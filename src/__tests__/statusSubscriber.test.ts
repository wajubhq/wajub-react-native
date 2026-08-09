import type { EchoConfig, SessionData } from '../types';
import type { PayClient } from '../client/payClient';

const pusherInstances: FakePusher[] = [];
class FakePusher {
  connection = { state: 'connecting' as string, bind: jest.fn(), connect: jest.fn() };
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
}
jest.mock('pusher-js', () => ({ __esModule: true, default: FakePusher }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { subscribeStatus } = require('../realtime/statusSubscriber');

function makeSession(echo: EchoConfig): SessionData {
  return {
    transaction: { id: 'trx', reference: 'TX1', amount: 1000, currency: 'XAF', status: 'processing' },
    echo,
  } as unknown as SessionData;
}

describe('subscribeStatus — Pusher private channel authorization', () => {
  beforeEach(() => {
    pusherInstances.length = 0;
  });

  it('configures channelAuthorization against /pay/broadcasting/auth with the session bearer token', () => {
    const echo: EchoConfig = {
      broadcaster: 'pusher',
      key: 'app_key',
      ws_host: 'wss://ws.wajub.test',
      ws_port: 443,
      channel_prefix: 'private-payment.',
    };
    const session = makeSession(echo);
    const client = {} as PayClient;

    const unsub = subscribeStatus(client, 'sess_token_123', session, () => {});

    expect(pusherInstances).toHaveLength(1);
    const opts = pusherInstances[0].opts as {
      channelAuthorization: { endpoint: string; headers: Record<string, string> };
    };
    expect(opts.channelAuthorization.endpoint).toMatch(/\/pay\/broadcasting\/auth$/);
    expect(opts.channelAuthorization.headers.Authorization).toBe('Bearer sess_token_123');

    unsub();
  });

  it('subscribes to the server-provided private channel name', () => {
    const echo: EchoConfig = {
      broadcaster: 'pusher',
      key: 'app_key',
      ws_host: 'wss://ws.wajub.test',
      ws_port: 443,
      channel_prefix: 'private-payment.',
    };
    const session = makeSession(echo);
    const client = {} as PayClient;

    const unsub = subscribeStatus(client, 'sess_token_123', session, () => {});

    const pusher = pusherInstances[0];
    expect(pusher.channels.has('private-payment.TX1')).toBe(true);

    unsub();
  });
});
