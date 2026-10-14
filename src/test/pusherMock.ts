/**
 * `pusher-js` for the tests: records every client, never opens a socket.
 * `connect()` and `emit()` drive it the way Reverb or Pusher would.
 */
type Handler = (data: unknown) => void;

export class FakePusher {
  static instances: FakePusher[] = [];
  readonly channels = new Map<string, { bind: jest.Mock; handlers: Map<string, Handler> }>();
  readonly connectionHandlers = new Map<string, Handler>();
  readonly connection = {
    state: 'connecting',
    bind: (event: string, handler: Handler) => {
      this.connectionHandlers.set(event, handler);
    },
  };
  readonly unsubscribe = jest.fn();
  readonly disconnect = jest.fn();

  constructor(
    public readonly key: string,
    public readonly options: Record<string, unknown>,
  ) {
    FakePusher.instances.push(this);
  }

  subscribe(name: string) {
    const handlers = new Map<string, Handler>();
    const channel = { handlers, bind: jest.fn((event: string, handler: Handler) => handlers.set(event, handler)) };
    this.channels.set(name, channel);
    return channel;
  }

  /** The socket connects. */
  connect(): void {
    this.connection.state = 'connected';
    this.connectionHandlers.get('state_change')?.({ previous: 'connecting', current: 'connected' });
  }

  /** The socket drops. */
  drop(): void {
    this.connection.state = 'unavailable';
    this.connectionHandlers.get('state_change')?.({ previous: 'connected', current: 'unavailable' });
  }

  /** The API broadcasts `event` with `data` (a JSON string or an object) on `channel`. */
  emit(channel: string, event: string, data: unknown): void {
    this.channels.get(channel)?.handlers.get(event)?.(data);
  }
}

export default FakePusher;
