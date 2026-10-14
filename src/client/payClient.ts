import { API_URL } from '../types';
import type {
  CancelResult,
  ClientSessionOptions,
  ConfirmStepKind,
  PaymentStatus,
  SdkConfig,
  SessionData,
  StepVerifyResponse,
} from '../types';
import { uuidV4 } from '../crypto';
import { WajubError } from '../WajubError';
import type { ErrorPhase, HeaderReader } from '../WajubError';
import {
  parseBroadcastAuth,
  parseCancel,
  parseProcess,
  parseSdkConfig,
  parseSession,
  parseStatus,
  parseStepVerify,
} from '../wire/parse';
import type { RawProcessBody } from '../wire/parse';
import { acceptLanguage, clientHeader, clientSignals } from './device';

/** Whole-request timeouts (spec README §2.4). The connect timeout is the platform's. */
export const TIMEOUTS = {
  requestMs: 30_000,
  /** /pay/process, /pay/client-session(/complete), the verify calls: they reach a provider. */
  paymentRequestMs: 60_000,
} as const;

/** Automatic retries (spec README §2.5). */
export const RETRY = {
  getMaxRetries: 3,
  postMaxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitter: 0.3,
  /** A 429 Retry-After longer than this is not waited for. */
  maxRetryAfterWaitMs: 10_000,
} as const;

/**
 * `read`: GETs — network, timeout, 408, 429, 5xx. `payment`: the POSTs that
 * charge — network, timeout, 502–504, same body and Idempotency-Key.
 * `cancel`: network and timeout. `none`: the verify calls and the rest.
 */
type RetryPolicy = 'read' | 'payment' | 'cancel' | 'none';

interface Call {
  method: 'GET' | 'POST';
  path: string;
  timeoutMs: number;
  retry: RetryPolicy;
  phase?: ErrorPhase;
}

const RETRIED_STATUSES: Record<RetryPolicy, number[]> = {
  read: [408, 429, 500, 502, 503, 504],
  payment: [502, 503, 504],
  cancel: [],
  none: [],
};

export interface RequestOptions {
  /** One per payment attempt; the automatic retries of that request reuse it. */
  idempotencyKey?: string;
  /** Aborting it stops the request and its retries. */
  signal?: AbortSignal;
}

export interface PayClientOptions {
  /** @internal For the SDK's own tests. Production always talks to https://api.wajub.com. */
  baseUrl?: string;
  /** @internal Waits between retries; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/** Raw `/pay/*` answer, before mapping. */
interface Answer {
  status: number;
  body: unknown;
  headers: HeaderReader;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A new key for each payment attempt (`^[A-Za-z0-9._:-]{1,128}$`). */
export function newIdempotencyKey(): string {
  return uuidV4();
}

/** `/pay/*` with the session token: headers, timeouts, retries, error mapping. */
export class PayClient {
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? API_URL).replace(/\/+$/, '');
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getSession(token: string, options: RequestOptions = {}): Promise<SessionData> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/session', timeoutMs: TIMEOUTS.requestMs, retry: 'read', phase: 'load' }, undefined, options);
    try {
      return parseSession(answer.body);
    } catch (e) {
      throw WajubError.create('load_error', { apiMessage: e instanceof Error ? e.message : null, httpStatus: answer.status });
    }
  }

  async getSdkConfig(token: string, options: RequestOptions = {}): Promise<SdkConfig> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/sdk-config', timeoutMs: TIMEOUTS.requestMs, retry: 'read', phase: 'load' }, undefined, options);
    return parseSdkConfig(answer.body);
  }

  /** GET /pay/status — `reference` there is the payment's id, not the merchant's reference. */
  async getStatus(token: string, options: RequestOptions = {}): Promise<PaymentStatus> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/status', timeoutMs: TIMEOUTS.requestMs, retry: 'read' }, undefined, options);
    return parseStatus(answer.body);
  }

  /**
   * POST /pay/process. `data._client` (device signals) is added when absent.
   * Without `idempotencyKey` each call is a new attempt with a key of its own.
   */
  async process(
    token: string,
    channel: string,
    data: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<RawProcessResponse> {
    const payload = { ...data, _client: data._client ?? (await clientSignals()) };
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/process', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      { channel, data: payload },
      { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
    );
    return parseProcess(answer.body);
  }

  /**
   * POST /pay/client-session — opens (or re-serves) a PSP-hosted checkout
   * for `channel`. Idempotent server-side; pins the provider.
   */
  async startClientSession(
    token: string,
    channel: string,
    options: ClientSessionOptions = {},
    request: RequestOptions = {},
  ): Promise<RawProcessResponse> {
    const body: Record<string, unknown> = { channel };
    for (const key of ['email', 'name', 'return_url', 'first_name', 'last_name', 'phone', 'address', 'city', 'country', 'state', 'zip_code'] as const) {
      const value = options[key];
      if (value) body[key] = value;
    }
    if (options.restart) body.restart = true;
    if (options.altcha) body.altcha = options.altcha;
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/client-session', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      body,
      request,
    );
    return parseProcess(answer.body);
  }

  /**
   * POST /pay/client-session/complete — the backend verifies with the PSP by
   * its own reference; the client never sends a PSP reference.
   */
  async completeClientSession(token: string, clientSessionId: string, request: RequestOptions = {}): Promise<RawProcessResponse> {
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/client-session/complete', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      { client_session_id: clientSessionId },
      request,
    );
    return parseProcess(answer.body);
  }

  async cancel(token: string, options: RequestOptions = {}): Promise<CancelResult> {
    const answer = await this.send(token, { method: 'POST', path: '/pay/cancel', timeoutMs: TIMEOUTS.requestMs, retry: 'cancel' }, undefined, options);
    return parseCancel(answer.body);
  }

  /** POST /pay/{kind}/verify — never retried: on no answer, read the status instead. */
  async verifyStep(token: string, kind: ConfirmStepKind, body: Record<string, string>, options: RequestOptions = {}): Promise<StepVerifyResponse> {
    const answer = await this.send(
      token,
      { method: 'POST', path: `/pay/${kind}/verify`, timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'none' },
      body,
      options,
    );
    return parseStepVerify(answer.body);
  }

  /** POST /pay/{kind}/resend — a no-op on the API's side today. */
  async resendStep(token: string, kind: ConfirmStepKind, id: string, options: RequestOptions = {}): Promise<void> {
    await this.send(token, { method: 'POST', path: `/pay/${kind}/resend`, timeoutMs: TIMEOUTS.requestMs, retry: 'none' }, { [`${kind}_id`]: id }, options);
  }

  /** POST /pay/3ds/verify (sandbox email code): HTTP 200 whose body says `code: 202`. */
  async verify3ds(token: string, threeDsId: string, code: string, options: RequestOptions = {}): Promise<void> {
    await this.send(
      token,
      { method: 'POST', path: '/pay/3ds/verify', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'none' },
      { three_ds_id: threeDsId, code },
      options,
    );
  }

  /** POST /pay/3ds/send — a new sandbox 3-D Secure code. */
  async send3ds(token: string, threeDsId: string, options: RequestOptions = {}): Promise<void> {
    await this.send(token, { method: 'POST', path: '/pay/3ds/send', timeoutMs: TIMEOUTS.requestMs, retry: 'none' }, { three_ds_id: threeDsId }, options);
  }

  /** POST /pay/broadcasting/auth — signs the payment's private realtime channel. */
  async broadcastingAuth(token: string, socketId: string, channelName: string): Promise<{ auth: string }> {
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/broadcasting/auth', timeoutMs: TIMEOUTS.requestMs, retry: 'none' },
      { socket_id: socketId, channel_name: channelName },
    );
    return parseBroadcastAuth(answer.body);
  }

  private backoff(retry: number): number {
    const base = Math.min(RETRY.baseDelayMs * 2 ** retry, RETRY.maxDelayMs);
    return Math.round(base * (1 + (Math.random() * 2 - 1) * RETRY.jitter));
  }

  private async send(token: string, call: Call, body?: Record<string, unknown>, options: RequestOptions = {}): Promise<Answer> {
    const maxRetries = call.retry === 'read' ? RETRY.getMaxRetries : call.retry === 'none' ? 0 : RETRY.postMaxRetries;
    // Built once: a retry resends the identical bytes with the same key.
    const json = call.method === 'POST' ? JSON.stringify(body ?? {}) : undefined;

    for (let retry = 0; ; retry++) {
      const outcome = await this.once(token, call, json, options);
      const retriesLeft = retry < maxRetries && !options.signal?.aborted;

      if ('failure' in outcome) {
        if (retriesLeft && call.retry !== 'none') {
          await this.sleep(this.backoff(retry));
          continue;
        }
        throw WajubError.create(outcome.failure);
      }

      const { status } = outcome;
      if (status >= 200 && status < 300) return outcome;

      const error = WajubError.fromResponse({ status, body: outcome.body, headers: outcome.headers, phase: call.phase });
      if (retriesLeft && RETRIED_STATUSES[call.retry].includes(status)) {
        if (status !== 429) {
          await this.sleep(this.backoff(retry));
          continue;
        }
        const waitMs = (error.retry_after_seconds ?? Infinity) * 1000;
        if (waitMs <= RETRY.maxRetryAfterWaitMs) {
          await this.sleep(waitMs);
          continue;
        }
      }
      throw error;
    }
  }

  /** One HTTP request, bounded by the call's timeout. */
  private async once(
    token: string,
    call: Call,
    json: string | undefined,
    options: RequestOptions,
  ): Promise<Answer | { failure: 'network_error' | 'timeout' }> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // AuthenticatePaymentSession reads Request::bearerToken(): the literal
      // "Bearer " prefix is required.
      Authorization: `Bearer ${token}`,
      'Accept-Language': acceptLanguage(),
      'X-Request-Id': uuidV4(),
      'X-Wajub-Client': clientHeader(),
    };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, call.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort);

    try {
      const response = await fetch(`${this.baseUrl}${call.path}`, {
        method: call.method,
        headers,
        body: json,
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      return { status: response.status, body, headers: response.headers };
    } catch {
      return { failure: timedOut ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

/** 2xx body of /pay/process and the client-session calls, parsed leniently. */
export type RawProcessResponse = RawProcessBody;
