import type { PayClient } from '../client/payClient';
import { subscribeStatus } from '../realtime/statusSubscriber';
import FakePusher from '../test/pusherMock';
import type { EchoConfig, PaymentResult, SessionData } from '../types';

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

/** A PayClient whose `/pay/status` answers with the given statuses, the last one for good. */
function pollingClient(statuses: string[]): { client: PayClient; getStatus: jest.Mock; broadcastingAuth: jest.Mock } {
  let call = 0;
  const getStatus = jest.fn(async () => ({ reference: 'pay_9f3c', status: statuses[Math.min(call++, statuses.length - 1)] }));
  const broadcastingAuth = jest.fn(async () => ({ auth: 'app_key:SIGNATURE' }));
  return { client: { getStatus, broadcastingAuth } as unknown as PayClient, getStatus, broadcastingAuth };
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
    const { client, getStatus } = pollingClient(['processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    FakePusher.instances[0].connect();

    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing']);

    // Connected, and not one socket event: the next poll (15 s with a socket) brings the result.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(updates).toEqual(['processing', 'complete']);

    // The final status ends the polling.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('reports each status once when the socket and the polling both see it', async () => {
    const { client, getStatus } = pollingClient(['processing', 'processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    const pusher = FakePusher.instances[0];

    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing']);

    pusher.emit('private-payment.pay_9f3c', 'PaymentStatusUpdated', { status: 'succeeded' });
    expect(updates).toEqual(['processing', 'complete']);

    // The socket got there first: the polling stops and adds nothing.
    const polls = getStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(polls);
    expect(updates).toEqual(['processing', 'complete']);
  });

  it('stops polling when the app stops watching', async () => {
    const { client, getStatus } = pollingClient(['processing']);

    const unsub = watch(client, 'tok', makeSession(ECHO));
    await jest.advanceTimersByTimeAsync(5000);
    const polls = getStatus.mock.calls.length;
    expect(polls).toBeGreaterThan(0);

    unsub();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getStatus).toHaveBeenCalledTimes(polls);
  });
});
