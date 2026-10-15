import type { PayClient } from '../client/payClient';
import { subscribeStatus } from '../realtime/statusSubscriber';
import FakePusher from '../test/pusherMock';
import type { EchoConfig, PaymentResult, SessionData } from '../types';
import { WajubError } from '../WajubError';

// `id` is the payment's Wajub id, `reference` the merchant's own: two different
// values on every real session, so a test that mixes them up fails.
function makeSession(echo: EchoConfig, status = 'processing'): SessionData {
  return {
    transaction: { id: 'pay_9f3c', reference: 'ORDER-1042', amount: 1000, currency: 'XAF', status },
    channels: [],
    echo,
  };
}

const ECHO: EchoConfig = {
  broadcaster: 'pusher',
  key: 'app_key',
  ws_host: 'wss://ws.wajub.test',
  ws_port: 443,
  channel_prefix: 'private-payment.',
};

/** A PayClient whose `/pay/session` answers with the given statuses, the last one for good (1.4 polls the session). */
function pollingClient(statuses: string[]): { client: PayClient; getSession: jest.Mock; broadcastingAuth: jest.Mock } {
  let call = 0;
  const getSession = jest.fn(async () => makeSession(ECHO, statuses[Math.min(call++, statuses.length - 1)]));
  const broadcastingAuth = jest.fn(async () => ({ auth: 'app_key:SIGNATURE' }));
  return { client: { getSession, broadcastingAuth } as unknown as PayClient, getSession, broadcastingAuth };
}

// Every watch is stopped after its test, passed or failed: one left running
// polls on and keeps Jest from exiting.
const watches: Array<() => void> = [];
function watch(client: PayClient, token: string, session: SessionData, onUpdate: (result: PaymentResult) => void = () => {}): () => void {
  const stop = subscribeStatus(client, token, session, onUpdate, 5000);
  watches.push(stop);
  return stop;
}
beforeEach(() => {
  FakePusher.instances.length = 0;
  jest.useFakeTimers();
});
afterEach(() => {
  watches.splice(0).forEach((stop) => stop());
  jest.useRealTimers();
});

describe('subscribeStatus — Pusher private channel authorization', () => {
  it('authorizes the channel through /pay/broadcasting/auth with the session bearer token', async () => {
    const { client, broadcastingAuth } = pollingClient(['processing']);

    watch(client, 'sess_token_123', makeSession(ECHO));

    expect(FakePusher.instances).toHaveLength(1);
    const { channelAuthorization } = FakePusher.instances[0].options as {
      channelAuthorization: { customHandler: (p: { socketId: string; channelName: string }, cb: jest.Mock) => void };
    };
    const callback = jest.fn();
    channelAuthorization.customHandler({ socketId: '123.456', channelName: 'private-payment.pay_9f3c' }, callback);
    await jest.advanceTimersByTimeAsync(0);
    expect(broadcastingAuth).toHaveBeenCalledWith('sess_token_123', '123.456', 'private-payment.pay_9f3c');
    expect(callback).toHaveBeenCalledWith(null, { auth: 'app_key:SIGNATURE' });
  });

  it('subscribes on the payment id, the channel the API publishes on, not on the merchant reference', () => {
    const { client } = pollingClient(['processing']);

    const unsub = watch(client, 'sess_token_123', makeSession(ECHO));

    const pusher = FakePusher.instances[0];
    expect([...pusher.channels.keys()]).toEqual(['private-payment.pay_9f3c']);

    unsub();
    expect(pusher.unsubscribe).toHaveBeenCalledWith('private-payment.pay_9f3c');
    expect(pusher.disconnect).toHaveBeenCalled();
  });
});

describe('subscribeStatus — polling stays on next to a connected socket', () => {
  it('reports a payment the socket never announced', async () => {
    const { client, getSession } = pollingClient(['processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    FakePusher.instances[0].connect();

    // The first read right away, as in 1.4.
    await jest.advanceTimersByTimeAsync(0);
    expect(updates).toEqual(['processing']);

    // Connected, and not one socket event: the next poll (15 s with a socket) brings the result.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(updates).toEqual(['processing', 'complete']);

    // The final status ends the polling.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('reports each status once when the socket and the polling both see it', async () => {
    const { client, getSession } = pollingClient(['processing', 'processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    const pusher = FakePusher.instances[0];

    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing']);

    pusher.emit('private-payment.pay_9f3c', 'PaymentStatusUpdated', { status: 'succeeded' });
    expect(updates).toEqual(['processing', 'complete']);

    // The socket got there first: the polling stops and adds nothing.
    const polls = getSession.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledTimes(polls);
    expect(updates).toEqual(['processing', 'complete']);
  });

  it('stops polling when the app stops watching', async () => {
    const { client, getSession } = pollingClient(['processing']);

    const unsub = watch(client, 'tok', makeSession(ECHO));
    await jest.advanceTimersByTimeAsync(5000);
    const polls = getSession.mock.calls.length;
    expect(polls).toBeGreaterThan(0);

    unsub();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledTimes(polls);
  });

  it("keeps 1.4's results, and watches past 15 minutes until a final status", async () => {
    const { client, getSession } = pollingClient(['processing']);
    const updates: string[] = [];
    watch(client, 'tok', makeSession({ ...ECHO, key: '' }), (r) => updates.push(r.status));
    await jest.advanceTimersByTimeAsync(20 * 60_000);
    // No silent stop at the spec's 15-minute cap: 1.4 watched until told otherwise.
    const polls = getSession.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession.mock.calls.length).toBeGreaterThan(polls);

    getSession.mockImplementation(async () => makeSession(ECHO, 'failed'));
    await jest.advanceTimersByTimeAsync(15_000);
    expect(updates).toEqual(['processing', 'failed']);
  });

  it('reports every poll, as 1.4 did, when the session has no realtime channel', async () => {
    const { client, getSession } = pollingClient(['pending', 'processing', 'processing', 'succeeded']);
    const updates: string[] = [];
    const { echo: _none, ...withoutEcho } = makeSession(ECHO);
    watch(client, 'tok', withoutEcho, (r) => updates.push(r.status));
    expect(FakePusher.instances).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(0);
    expect(updates).toEqual(['processing']);
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(5000);
    // The same status again is told again: no deduplication without a socket.
    expect(updates).toEqual(['processing', 'processing', 'processing']);
    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing', 'processing', 'processing', 'complete']);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getSession).toHaveBeenCalledTimes(4);
  });

  it('stops on an ended session with the 1.4 error', async () => {
    const { client, getSession } = pollingClient(['processing']);
    const results: PaymentResult[] = [];
    getSession.mockRejectedValue(WajubError.fromHttp(410, 'Expired', 'session_terminal_expired', {}));
    watch(client, 'tok', makeSession({ ...ECHO, key: '' }), (r) => results.push(r));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(results).toMatchObject([{ status: 'failed', error: { code: 'session_terminal_expired', type: 'authentication_error' } }]);
    expect(getSession).toHaveBeenCalledTimes(1);
  });
});
