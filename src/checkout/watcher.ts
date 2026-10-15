/**
 * Watching a payment until it ends (spec README §13): `GET /pay/status` on a
 * schedule, the payment's private realtime channel next to it.
 */
import Pusher from 'pusher-js';
import { AppState } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';

import { monotonicNow } from '../clock';
import type { PayClient } from '../client/payClient';
import type { Lang } from '../errorCatalogue';
import type { EchoConfig, PaymentStatus, PresentOptions } from '../types';
import { WajubError } from '../WajubError';
import { parseStatus } from '../wire/parse';

export const POLLING = {
  intervalMs: 5_000,
  slowAfterMs: 120_000,
  slowFactor: 1.5,
  maxIntervalMs: 15_000,
  withSocketMs: 15_000,
  errorBaseMs: 5_000,
  errorMaxMs: 60_000,
  errorJitter: 0.2,
  overallCapMs: 900_000,
} as const;

export const SUCCESS_STATUSES = ['succeeded', 'refunded', 'partially_refunded'];

/** How a watch ended. `cause`: the request error behind it (an ended session). */
export type WatchOutcome =
  | { kind: 'success' }
  | { kind: 'failed'; error: WajubError; cause?: WajubError }
  | { kind: 'cancelled'; error: WajubError }
  | { kind: 'expired'; error: WajubError; cause?: WajubError }
  /** 15 minutes, or the payment's `expires_at`, without an outcome. */
  | { kind: 'cap' }
  /** A final status a custom `decide()` stops on (it reported it through `onStatus`). */
  | { kind: 'ended' };

/** A payment back at `pending` after this attempt was seen processing: refused, nothing charged. */
export function attemptEnded(status: PaymentStatus, lang: Lang): WajubError {
  if (!status.error_code) return WajubError.create('payment_attempt_ended', { lang });
  const declined = WajubError.fromResponse({
    status: 402,
    body: { error_code: status.error_code, message: status.payer_message ?? undefined, payer_message: status.payer_message ?? undefined },
    lang,
  });
  return new WajubError({ ...declined.toJSON(), details: declined.details, http_status: null, retryable: true });
}

/**
 * What one status (a poll, or a realtime event) means. `pending` ends the
 * attempt only once it was seen processing: before that it is the previous
 * attempt's leftover.
 */
export function decideStatus(status: PaymentStatus, seenProcessing: boolean, lang: Lang): WatchOutcome | null {
  const s = status.status;
  if (SUCCESS_STATUSES.includes(s)) return { kind: 'success' };
  if (s === 'failed') return { kind: 'failed', error: WajubError.create('payment_failed', { lang }) };
  if (s === 'cancelled') return { kind: 'cancelled', error: WajubError.create('payment_cancelled', { lang }) };
  if (s === 'expired') return { kind: 'expired', error: WajubError.create('session_expired', { lang }) };
  if (s === 'pending' && seenProcessing) return { kind: 'failed', error: attemptEnded(status, lang) };
  return null;
}

/** Where the realtime socket goes: `echo`, overridden by `PresentOptions.realtime`; null for polling only. */
export function realtimeConfig(
  echo: EchoConfig | null | undefined,
  override: PresentOptions['realtime'],
): { key: string; host: string; port: number; tls: boolean; channelPrefix: string } | null {
  if (override?.enabled === false || !echo?.key) return null;
  const match = /^(wss?):\/\/([^/:]+)/i.exec(echo.ws_host);
  const host = override?.host ?? match?.[2] ?? echo.ws_host;
  if (!host) return null;
  return {
    key: echo.key,
    host,
    port: override?.port ?? echo.ws_port,
    tls: override?.tls ?? (match ? match[1].toLowerCase() === 'wss' : true),
    channelPrefix: echo.channel_prefix,
  };
}

export interface WatcherOptions {
  client: PayClient;
  token: string;
  /** `transaction.id`: the channel suffix. */
  transactionId: string;
  echo?: EchoConfig | null;
  realtime?: PresentOptions['realtime'];
  lang: Lang;
  /** This attempt was already seen `processing` (its 2xx, or a restore). */
  seenProcessing: boolean;
  /** When polling gives up, on the monotonic clock (`monotonicNow()`): 15 min after the attempt started. Infinity: never. */
  deadline: number;
  /** Poll once right away, then on the schedule (1.4's `watchStatus()`). */
  pollImmediately?: boolean;
  /** Reads the status; `GET /pay/status` by default. */
  read?: () => Promise<PaymentStatus>;
  /** Decides on a status; `decideStatus()` by default. */
  decide?: (status: PaymentStatus, seenProcessing: boolean) => WatchOutcome | null;
  /** The base polling interval; 5 s unless an older API asked otherwise. */
  intervalMs?: number;
  onOutcome(outcome: WatchOutcome): void;
  /** Every status read, from a poll or the socket. */
  onStatus?(status: PaymentStatus): void;
}

export class StatusWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private polling = false;
  private pusher: Pusher | null = null;
  private socketConnected = false;
  private failures = 0;
  private interval: number;
  private readonly baseInterval: number;
  private lastStatus: string | null = null;
  private lastChangeAt = monotonicNow();
  private seenProcessing: boolean;
  private appState: NativeEventSubscription | null = null;
  private background = false;

  constructor(private readonly options: WatcherOptions) {
    this.seenProcessing = options.seenProcessing;
    // The attempt's own answer said processing: a poll that says it again is no change.
    this.lastStatus = options.seenProcessing ? 'processing' : null;
    this.baseInterval = options.intervalMs ?? POLLING.intervalMs;
    this.interval = this.baseInterval;
  }

  start(): void {
    this.lastChangeAt = monotonicNow();
    this.connectRealtime();
    this.appState = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        if (this.background) this.pollNow();
        this.background = false;
      } else if (state === 'background') {
        // Paused in the background; polled at once on the way back.
        this.background = true;
        this.clearTimer();
      }
    });
    this.schedule(this.options.pollImmediately ? 0 : this.baseInterval);
  }

  /** A status read right away: the payer came back from a provider's page, or the app to the foreground. */
  pollNow(): void {
    if (this.stopped) return;
    this.clearTimer();
    void this.poll();
  }

  /** Stops polling and closes the socket. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimer();
    this.appState?.remove();
    this.appState = null;
    if (this.pusher) {
      this.pusher.unsubscribe(this.channelName());
      this.pusher.disconnect();
      this.pusher = null;
    }
  }

  private channelName(): string {
    return `${this.options.echo?.channel_prefix ?? 'private-payment.'}${this.options.transactionId}`;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.stopped || this.background) return;
    this.clearTimer();
    const remaining = this.options.deadline - monotonicNow();
    if (remaining <= 0) {
      this.finish({ kind: 'cap' });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (monotonicNow() >= this.options.deadline) this.finish({ kind: 'cap' });
      else void this.poll();
    }, Math.min(delay, remaining));
  }

  /** 5 s; ×1.5 per poll up to 15 s after 2 minutes without a change; 15 s while the socket is up. */
  private nextInterval(): number {
    if (this.socketConnected) return POLLING.withSocketMs;
    this.interval =
      monotonicNow() - this.lastChangeAt >= POLLING.slowAfterMs
        ? Math.min(this.interval * POLLING.slowFactor, Math.max(POLLING.maxIntervalMs, this.baseInterval))
        : this.baseInterval;
    return this.interval;
  }

  private errorDelay(): number {
    const base = Math.min(POLLING.errorBaseMs * 2 ** this.failures, POLLING.errorMaxMs);
    return Math.round(base * (1 + (Math.random() * 2 - 1) * POLLING.errorJitter));
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    let delay: number;
    try {
      const status = await (this.options.read ? this.options.read() : this.options.client.getStatus(this.options.token));
      this.failures = 0;
      this.handle(status);
      delay = this.nextInterval();
    } catch (e) {
      const error = e instanceof WajubError ? e : null;
      const status = error?.http_status;
      const cause = error ?? undefined;
      if (status === 401 || status === 403 || status === 404) {
        this.finish({ kind: 'failed', error: WajubError.create('session_not_found', { lang: this.options.lang, httpStatus: status }), cause });
      } else if (status === 410) {
        this.finish({ kind: 'expired', error: WajubError.create('session_terminal_expired', { lang: this.options.lang, httpStatus: 410 }), cause });
      }
      this.failures += 1;
      delay = status === 429 && error?.retry_after_seconds ? error.retry_after_seconds * 1000 : this.errorDelay();
    } finally {
      this.polling = false;
    }
    this.schedule(delay);
  }

  /** A status from a poll or the socket. */
  private handle(status: PaymentStatus): void {
    // An empty answer, or a frame without a status, says nothing: never read as `pending`.
    if (this.stopped || !status.status) return;
    if (status.status !== this.lastStatus) {
      this.lastStatus = status.status;
      this.lastChangeAt = monotonicNow();
    }
    this.options.onStatus?.(status);
    const outcome = this.options.decide
      ? this.options.decide(status, this.seenProcessing)
      : decideStatus(status, this.seenProcessing, this.options.lang);
    if (outcome) {
      this.finish(outcome);
      return;
    }
    if (status.status === 'processing' || status.status === 'partial') this.seenProcessing = true;
  }

  private finish(outcome: WatchOutcome): void {
    if (this.stopped) return;
    this.stop();
    this.options.onOutcome(outcome);
  }

  private connectRealtime(): void {
    const config = realtimeConfig(this.options.echo, this.options.realtime);
    if (!config) return;
    const { client, token } = this.options;
    try {
      this.pusher = new Pusher(config.key, {
        // Ignored once wsHost is set; required by pusher-js's types.
        cluster: 'mt1',
        wsHost: config.host,
        wsPort: config.port,
        wssPort: config.port,
        forceTLS: config.tls,
        // pusher-js's transport named "ws" is the TLS socket too when forceTLS is set; "wss" its fallback.
        enabledTransports: ['ws', 'wss'],
        disableStats: true,
        // The channel is private: /pay/broadcasting/auth signs it for this
        // session's own bearer token, through the SDK's transport.
        channelAuthorization: {
          customHandler: ({ socketId, channelName }, callback) => {
            client.broadcastingAuth(token, socketId, channelName).then(
              (data) => callback(null, data),
              (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
            );
          },
        },
      });
    } catch {
      this.pusher = null;
      return;
    }
    this.pusher.connection.bind('state_change', ({ current }: { current: string }) => {
      const connected = current === 'connected';
      if (connected === this.socketConnected) return;
      this.socketConnected = connected;
      // Back to 5 s as soon as the socket drops.
      if (!connected && !this.polling && this.timer) this.schedule(this.baseInterval);
    });
    // The API names the event without Laravel Echo's leading dot.
    this.pusher.subscribe(this.channelName()).bind('PaymentStatusUpdated', (data: unknown) => this.handle(parseStatus(data)));
  }
}
