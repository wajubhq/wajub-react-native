import type { EchoConfig, PaymentResult, SessionData } from '../types';
import type { PayClient } from '../client/payClient';

const pusherInstances: FakePusher[] = [];
class FakePusher {
  connectionHandlers = new Map<string, () => void>();
  connection = {
    state: 'connecting' as string,
    bind: jest.fn((event: string, handler: () => void) => {
      this.connectionHandlers.set(event, handler);
    }),
    connect: jest.fn(),
  };
  channels = new Map<string, { bind: jest.Mock }>();
  unsubscribe = jest.fn();
  disconnect = jest.fn();
  constructor(public key: string, public opts: Record<string, unknown>) {
    pusherInstances.push(this);
  }
  subscribe(name: string) {
    const channel = { bind: jest.fn() };
    this.channels.set(name, channel);
    return channel;
  }
  /** The socket connects, as it does against production Reverb. */
  connect() {
    this.connection.state = 'connected';
    this.connectionHandlers.get('connected')?.();
  }
  /** The API broadcasts `PaymentStatusUpdated` on `name`. */
  emit(name: string, status: string) {
    const handler = this.channels.get(name)?.bind.mock.calls.find(([event]) => event === 'PaymentStatusUpdated')?.[1];
    handler?.({ status });
  }
}
jest.mock('pusher-js', () => ({ __esModule: true, default: FakePusher }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { subscribeStatus } = require('../realtime/statusSubscriber');

// `id` is the payment's Wajub id, `reference` the merchant's own: two different
// values on every real session, so a test that mixes them up fails.
function makeSession(echo: EchoConfig, status = 'processing'): SessionData {
  return {
    transaction: { id: 'pay_9f3c', reference: 'ORDER-1042', amount: 1000, currency: 'XAF', status },
    echo,
  } as unknown as SessionData;
}

const ECHO: EchoConfig = {
  broadcaster: 'pusher',
  key: 'app_key',
  ws_host: 'wss://ws.wajub.test',
  ws_port: 443,
  channel_prefix: 'private-payment.',
};

/** A PayClient whose `/pay/session` answers with the given statuses, the last one for good. */
function pollingClient(statuses: string[]): { client: PayClient; getSession: jest.Mock } {
  let call = 0;
  const getSession = jest.fn(async () => makeSession(ECHO, statuses[Math.min(call++, statuses.length - 1)]));
  return { client: { getSession } as unknown as PayClient, getSession };
}

// Every watch is stopped after its test, passed or failed: one left running
// polls forever and keeps Jest from exiting.
const watches: Array<() => void> = [];
function watch(
  client: PayClient,
  token: string,
  session: SessionData,
  onUpdate: (result: PaymentResult) => void = () => {},
): () => void {
  const stop: () => void = subscribeStatus(client, token, session, onUpdate, 5000);
  watches.push(stop);
  return stop;
}
beforeEach(() => {
  pusherInstances.length = 0;
  jest.useFakeTimers();
});
afterEach(() => {
  watches.splice(0).forEach((stop) => stop());
  jest.useRealTimers();
});

describe('subscribeStatus — Pusher private channel authorization', () => {
  it('configures channelAuthorization against /pay/broadcasting/auth with the session bearer token', () => {
    const { client } = pollingClient(['processing']);

    watch(client, 'sess_token_123', makeSession(ECHO));

    expect(pusherInstances).toHaveLength(1);
    const opts = pusherInstances[0].opts as {
      channelAuthorization: { endpoint: string; headers: Record<string, string> };
    };
    expect(opts.channelAuthorization.endpoint).toMatch(/\/pay\/broadcasting\/auth$/);
    expect(opts.channelAuthorization.headers.Authorization).toBe('Bearer sess_token_123');
  });

  it('subscribes on the payment id, the channel the API publishes on, not on the merchant reference', () => {
    const { client } = pollingClient(['processing']);

    const unsub = watch(client, 'sess_token_123', makeSession(ECHO));

    const pusher = pusherInstances[0];
    expect([...pusher.channels.keys()]).toEqual(['private-payment.pay_9f3c']);

    unsub();
    expect(pusher.unsubscribe).toHaveBeenCalledWith('private-payment.pay_9f3c');
  });
});

describe('subscribeStatus — polling stays on next to a connected socket', () => {
  it('reports a payment the socket never announced', async () => {
    const { client, getSession } = pollingClient(['processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    pusherInstances[0].connect();

    await jest.advanceTimersByTimeAsync(0);
    expect(updates).toEqual(['processing']);

    // Connected, and not one socket event: the next poll brings the result.
    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing', 'complete']);

    // The final status ends the polling.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('reports each status once when the socket and the polling both see it', async () => {
    const { client, getSession } = pollingClient(['processing', 'processing', 'succeeded']);
    const updates: string[] = [];

    watch(client, 'tok', makeSession(ECHO), (r) => updates.push(r.status));
    const pusher = pusherInstances[0];
    pusher.connect();

    await jest.advanceTimersByTimeAsync(5000);
    expect(updates).toEqual(['processing']);

    pusher.emit('private-payment.pay_9f3c', 'succeeded');
    expect(updates).toEqual(['processing', 'complete']);

    // The socket got there first: the polling stops and adds nothing.
    const polls = getSession.mock.calls.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(getSession).toHaveBeenCalledTimes(polls);
    expect(updates).toEqual(['processing', 'complete']);
  });

  it('stops polling when the app stops watching', async () => {
    const { client, getSession } = pollingClient(['processing']);

    const unsub = watch(client, 'tok', makeSession(ECHO));
    pusherInstances[0].connect();
    await jest.advanceTimersByTimeAsync(5000);
    const polls = getSession.mock.calls.length;
    expect(polls).toBeGreaterThan(0);

    unsub();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(getSession).toHaveBeenCalledTimes(polls);
  });
});
