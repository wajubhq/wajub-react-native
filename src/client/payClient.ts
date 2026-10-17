import { API_URL } from '../types';
import type {
  CancelResult,
  ClientSessionOptions,
  ConfirmStepKind,
  PaymentStatus,
  SdkConfig,
  SessionData,
  StepVerifyResponse,
  WajubStorage,
} from '../types';
import { monotonicNow } from '../clock';
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
  WajubParseError,
} from '../wire/parse';
import type { RawProcessBody } from '../wire/parse';
import { acceptLanguage, clientHeader, clientSignals } from './device';

/** @internal Whole-request timeouts. The connect timeout is the platform's. */
export const TIMEOUTS = {
  requestMs: 30_000,
  /** The calls that reach a provider: a payment, its checkout, its confirmation steps. */
  paymentRequestMs: 60_000,
} as const;

/** @internal Automatic retries. */
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
  /** Pass the same key to retry the same payment; a new one is made when absent. */
  idempotencyKey?: string;
  /** Aborting it stops the request. */
  signal?: AbortSignal;
  /** @internal Called as the request is sent. */
  onSend?: (at: number) => void;
}

export interface PayClientOptions {
  /** @internal For the SDK's own tests. Production always talks to https://api.wajub.com. */
  baseUrl?: string;
  /** @internal For the SDK's own tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How errors are reported. `legacy` (the default) keeps 1.4's codes and
   * messages; `v2` gives the codes and messages the payment sheet uses.
   */
  errors?: 'legacy' | 'v2';
  /** Where the SDK keeps its data: any `{ getItem, setItem }`. Default: AsyncStorage. */
  storage?: WajubStorage;
}

/** Raw `/pay/*` answer, before mapping. */
interface Answer {
  status: number;
  body: unknown;
  headers: HeaderReader;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function flattenErrors(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = Array.isArray(value) && value.length > 0 ? String(value[0]) : String(value);
  }
  return out;
}

/** 1.4's mapping of an error answer, kept for the 1.4 methods. */
function legacyHttpError(status: number, raw: unknown, headers: HeaderReader): WajubError {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const message = typeof body.message === 'string' && body.message.length > 0 ? body.message : `Request failed (${status})`;
  const errorCode =
    typeof body.error_code === 'string'
      ? body.error_code
      : status === 402
        ? 'insufficient_funds'
        : status === 403
          ? 'blocked'
          : status === 410
            ? 'session_terminal_expired'
            : status === 422
              ? 'validation_error'
              : status === 429
                ? 'rate_limited'
                : status === 401 || status === 404
                  ? 'session_not_found'
                  : status >= 500
                    ? 'server_error'
                    : 'payment_error';
  const retryAfter = headers.get('Retry-After');
  return WajubError.fromHttp(
    status,
    message,
    errorCode,
    flattenErrors(body.errors),
    headers.get('X-Request-Id') ?? headers.get('X-Trace-Id'),
    retryAfter ? parseInt(retryAfter, 10) : null,
  );
}

/** A new key for a payment attempt. */
export function newIdempotencyKey(): string {
  return uuidV4();
}

/** Wajub's payment session calls for one payment's `authorization_token`; `WajubSession` uses it. */
export class PayClient {
  private readonly options: PayClientOptions;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PayClientOptions = {}) {
    this.options = options;
    this.baseUrl = (options.baseUrl ?? API_URL).replace(/\/+$/, '');
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** The same client with some options changed. */
  with(options: PayClientOptions): PayClient {
    const merged: PayClientOptions = { ...this.options };
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return new PayClient(merged);
  }

  private get v2(): boolean {
    return this.options.errors === 'v2';
  }

  /** The payment, its payment methods and the merchant's branding. */
  async getSession(token: string, options: RequestOptions = {}): Promise<SessionData> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/session', timeoutMs: TIMEOUTS.requestMs, retry: 'read', phase: 'load' }, undefined, options);
    try {
      return parseSession(answer.body);
    } catch (e) {
      // 1.4 handed the body back as it came.
      if (!this.v2 && e instanceof WajubParseError) return answer.body as SessionData;
      throw WajubError.create('load_error', { apiMessage: e instanceof Error ? e.message : null, httpStatus: answer.status });
    }
  }

  /** How each payment method collects its details. */
  async getSdkConfig(token: string, options: RequestOptions = {}): Promise<SdkConfig> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/sdk-config', timeoutMs: TIMEOUTS.requestMs, retry: 'read', phase: 'load' }, undefined, options);
    return parseSdkConfig(answer.body);
  }

  /** Where the payment is. Its `reference` is the payment's id, not the merchant's reference. */
  async getStatus(token: string, options: RequestOptions = {}): Promise<PaymentStatus> {
    const answer = await this.send(token, { method: 'GET', path: '/pay/status', timeoutMs: TIMEOUTS.requestMs, retry: 'read' }, undefined, options);
    return parseStatus(answer.body);
  }

  /**
   * A payment attempt with one of the payment's methods. Without
   * `idempotencyKey` each call is a new attempt.
   */
  async process(
    token: string,
    channel: string,
    data: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<RawProcessResponse> {
    const payload = { ...data, _client: data._client ?? (await clientSignals(this.options.storage)) };
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/process', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      { channel, data: payload },
      { ...options, idempotencyKey: options.idempotencyKey ?? newIdempotencyKey() },
    );
    return parseProcess(answer.body);
  }

  /** Opens the provider's own card checkout for `channel` (or gives back the one already open). */
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
    if (options.securitySolution) body.altcha = options.securitySolution;
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/client-session', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      body,
      request,
    );
    return parseProcess(answer.body);
  }

  /** The payer is back from the provider's checkout: Wajub checks the payment with the provider. */
  async completeClientSession(token: string, clientSessionId: string, request: RequestOptions = {}): Promise<RawProcessResponse> {
    const answer = await this.send(
      token,
      { method: 'POST', path: '/pay/client-session/complete', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'payment' },
      { client_session_id: clientSessionId },
      request,
    );
    return parseProcess(answer.body);
  }

  /** Cancels the payment for good; `redirect_url` is where the merchant sends a cancelled payer. */
  async cancel(token: string, options: RequestOptions = {}): Promise<CancelResult> {
    const answer = await this.send(token, { method: 'POST', path: '/pay/cancel', timeoutMs: TIMEOUTS.requestMs, retry: 'cancel', phase: 'cancel' }, undefined, options);
    return parseCancel(answer.body);
  }

  /** Answers a confirmation step. Without an answer, read the payment's status before trying again. */
  async verifyStep(token: string, kind: ConfirmStepKind, body: Record<string, string>, options: RequestOptions = {}): Promise<StepVerifyResponse> {
    const answer = await this.send(
      token,
      { method: 'POST', path: `/pay/${kind}/verify`, timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'none' },
      body,
      options,
    );
    return parseStepVerify(answer.body);
  }

  /** Sends a confirmation step's code again. */
  async resendStep(token: string, kind: ConfirmStepKind, id: string, options: RequestOptions = {}): Promise<void> {
    await this.send(token, { method: 'POST', path: `/pay/${kind}/resend`, timeoutMs: TIMEOUTS.requestMs, retry: 'none' }, { [`${kind}_id`]: id }, options);
  }

  /** Answers the sandbox 3-D Secure email code. */
  async verify3ds(token: string, threeDsId: string, code: string, options: RequestOptions = {}): Promise<void> {
    await this.send(
      token,
      { method: 'POST', path: '/pay/3ds/verify', timeoutMs: TIMEOUTS.paymentRequestMs, retry: 'none' },
      { three_ds_id: threeDsId, code },
      options,
    );
  }

  /** Sends a new sandbox 3-D Secure code. */
  async send3ds(token: string, threeDsId: string, options: RequestOptions = {}): Promise<void> {
    await this.send(token, { method: 'POST', path: '/pay/3ds/send', timeoutMs: TIMEOUTS.requestMs, retry: 'none' }, { three_ds_id: threeDsId }, options);
  }

  /** @internal Used by the SDK's live status updates. */
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
        if (this.v2) throw WajubError.create(outcome.failure);
        throw WajubError.network(outcome.failure === 'timeout' ? 'The request timed out.' : outcome.message);
      }

      const { status } = outcome;
      if (status >= 200 && status < 300) return outcome;

      const error = this.v2
        ? WajubError.fromResponse({ status, body: outcome.body, headers: outcome.headers, phase: call.phase })
        : legacyHttpError(status, outcome.body, outcome.headers);
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
  ): Promise<Answer | { failure: 'network_error' | 'timeout'; message: string }> {
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
    options.onSend?.(monotonicNow());

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
    } catch (e) {
      return { failure: timedOut ? 'timeout' : 'network_error', message: e instanceof Error ? e.message : 'Network error' };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

/** A payment attempt's answer, before it is read. */
export type RawProcessResponse = RawProcessBody;
