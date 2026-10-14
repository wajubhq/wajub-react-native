import { catalogueMessage, ERROR_CATALOGUE, GENERIC_DECLINE, isCatalogued } from './errorCatalogue';
import type { Lang } from './errorCatalogue';
import { parseApiError } from './wire/parse';
import type { WajubErrorJSON, WajubErrorShape, WajubErrorType } from './types';

/** What a message is rebuilt from when the error is shown in another language. */
interface ErrorContext {
  status?: number | null;
  apiMessage?: string | null;
  payerMessage?: string | null;
  vars?: Record<string, string | number | null | undefined>;
}

/** Response headers, as `fetch` gives them. */
export interface HeaderReader {
  get(name: string): string | null;
}

export type ErrorPhase = 'load' | 'payment';

function messageFor(code: string, lang: Lang, ctx: ErrorContext): string {
  if (code === 'validation_error' && lang === 'en' && ctx.apiMessage) {
    return ctx.apiMessage;
  }
  const catalogued = catalogueMessage(code, lang, ctx.vars);
  if (catalogued !== null) return catalogued;
  if (ctx.status === 402) return GENERIC_DECLINE[lang];
  if (lang === 'en') {
    return ctx.payerMessage || ctx.apiMessage || ERROR_CATALOGUE.request_failed.en;
  }
  return ERROR_CATALOGUE[ctx.status === 422 ? 'validation_error' : 'server_error'].fr;
}

function codeForStatus(status: number, phase: ErrorPhase): string {
  if (status === 400) return 'not_processable';
  if (status === 401 || status === 404) return 'session_not_found';
  if (status === 402) return 'payment_declined';
  if (status === 403) return phase === 'load' ? 'session_not_found' : 'merchant_restricted';
  if (status === 409) return 'order_not_validated';
  if (status === 410) return 'session_terminal_expired';
  if (status === 422) return 'validation_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'request_failed';
}

function typeForStatus(status: number): WajubErrorType {
  if (status === 402 || status === 403) return 'payment_error';
  if (status === 401 || status === 404) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function retryAfterHeader(headers: HeaderReader | undefined): number | null {
  const raw = headers?.get('Retry-After');
  const seconds = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

export class WajubError extends Error implements WajubErrorShape {
  readonly name = 'WajubError' as const;
  readonly type: WajubErrorType;
  readonly code: string;
  readonly decline_code: string | null;
  readonly retryable: boolean;
  readonly param: string | null;
  readonly http_status: number | null;
  readonly correlation_id: string | null;
  readonly retry_after_seconds: number | null;
  readonly details?: Record<string, string>;
  readonly block_reference: string | null;
  readonly api_message: string | null;

  constructor(shape: WajubErrorShape, context?: ErrorContext) {
    super(shape.message);
    this.type = shape.type;
    this.code = shape.code;
    this.decline_code = shape.decline_code ?? null;
    this.retryable = shape.retryable;
    this.param = shape.param ?? null;
    this.http_status = shape.http_status ?? null;
    this.correlation_id = shape.correlation_id ?? null;
    this.retry_after_seconds = shape.retry_after_seconds ?? null;
    this.details = shape.details ?? undefined;
    this.block_reference = shape.block_reference ?? null;
    this.api_message = shape.api_message ?? null;
    Object.defineProperty(this, 'context', { value: context ?? null, enumerable: false });
  }

  /** The spec's plain shape (errors.md §1). */
  toJSON(): WajubErrorJSON {
    return {
      name: 'WajubError',
      type: this.type,
      code: this.code,
      message: this.message,
      decline_code: this.decline_code,
      retryable: this.retryable,
      param: this.param,
      http_status: this.http_status,
      correlation_id: this.correlation_id,
      retry_after_seconds: this.retry_after_seconds,
      details: this.details ?? null,
      block_reference: this.block_reference,
      api_message: this.api_message,
    };
  }

  /** Its fields as a `WajubErrorShape`. */
  private shape(): WajubErrorShape {
    return { ...this.toJSON(), details: this.details };
  }

  /** The same error with its message in `lang` (an error built from a bare shape keeps its own). */
  localized(lang: Lang): WajubError {
    const context = (this as unknown as { context: ErrorContext | null }).context;
    if (!context) return this;
    return new WajubError({ ...this.shape(), message: messageFor(this.code, lang, context) }, context);
  }

  /** An error of the catalogue (errors.md §3), with its type, retryability and message. */
  static create(
    code: string,
    options: {
      lang?: Lang;
      vars?: Record<string, string | number | null | undefined>;
      apiMessage?: string | null;
      param?: string | null;
      httpStatus?: number | null;
      retryAfterSeconds?: number | null;
    } = {},
  ): WajubError {
    const entry = isCatalogued(code) ? ERROR_CATALOGUE[code] : undefined;
    const context: ErrorContext = { status: options.httpStatus ?? null, apiMessage: options.apiMessage, vars: options.vars };
    return new WajubError(
      {
        type: entry?.type ?? 'api_error',
        code,
        message: messageFor(code, options.lang ?? 'en', context),
        retryable: entry?.retryable ?? false,
        param: options.param ?? null,
        http_status: options.httpStatus ?? null,
        retry_after_seconds: options.retryAfterSeconds ?? null,
        api_message: options.apiMessage ?? null,
      },
      context,
    );
  }

  /**
   * An API error answer mapped by errors.md §2. `phase` tells a 403 at load
   * (not a payment session) from one during payment (a merchant restriction).
   */
  static fromResponse(input: {
    status: number;
    body: unknown;
    headers?: HeaderReader;
    phase?: ErrorPhase;
    lang?: Lang;
  }): WajubError {
    const { status, headers } = input;
    const body = parseApiError(input.body);
    let code = body.error_code || body.error?.code || codeForStatus(status, input.phase ?? 'payment');
    if (status === 410) code = 'session_terminal_expired';
    const entry = isCatalogued(code) ? ERROR_CATALOGUE[code] : undefined;
    const keys = Object.keys(body.errors);
    const details = keys.length > 0 ? Object.fromEntries(keys.map((k) => [k, body.errors[k][0] ?? ''])) : undefined;
    const retryAfter = body.retry_after ?? retryAfterHeader(headers);
    const context: ErrorContext = {
      status,
      apiMessage: body.message,
      payerMessage: body.payer_message,
      vars: { seconds: retryAfter, block_reference: body.block_reference },
    };
    return new WajubError(
      {
        type: entry?.type ?? typeForStatus(status),
        code,
        message: messageFor(code, input.lang ?? 'en', context),
        decline_code: status === 402 ? body.error_code || null : null,
        retryable: entry?.retryable ?? (status === 402 || status === 422 || status >= 500),
        // The field the refusal is about, when it names exactly one.
        param: keys.length === 1 ? keys[0] : null,
        http_status: status,
        correlation_id: headers?.get('X-Request-Id') ?? null,
        retry_after_seconds: retryAfter,
        details,
        block_reference: body.block_reference ?? null,
        api_message: body.message ?? null,
      },
      context,
    );
  }

  /** A confirmation step's HTTP 200 `{status: "failed", attempts_remaining, error}`. */
  static fromStepFailure(
    failure: { attempts_remaining: number | null; error: { code: string; message: string } },
    lang: Lang = 'en',
  ): WajubError {
    const code = failure.error.code || 'validation_error';
    const entry = isCatalogued(code) ? ERROR_CATALOGUE[code] : undefined;
    const context: ErrorContext = {
      status: 200,
      apiMessage: failure.error.message,
      vars: { n: failure.attempts_remaining },
    };
    return new WajubError(
      {
        type: entry?.type ?? 'invalid_request_error',
        code,
        message: messageFor(code, lang, context),
        retryable: entry?.retryable ?? true,
        http_status: 200,
        api_message: failure.error.message || null,
      },
      context,
    );
  }

  /** A request that got no answer (no connection, DNS, TLS, reset). */
  static network(message?: string): WajubError {
    const error = WajubError.create('network_error', { apiMessage: message ?? null });
    return message ? new WajubError({ ...error.toJSON(), details: undefined, message }, { apiMessage: message }) : error;
  }

  /**
   * @deprecated The 1.4 mapping, kept as it was. The SDK itself maps answers
   * with `WajubError.fromResponse()` (spec errors.md §2).
   */
  static fromHttp(
    status: number,
    message: string,
    code: string,
    details: Record<string, string>,
    correlationId?: string | null,
    retryAfterSeconds?: number | null,
  ): WajubError {
    const type: WajubErrorType =
      status === 401 || status === 404 || status === 410
        ? 'authentication_error'
        : status === 422
          ? 'invalid_request_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'api_error'
              : 'payment_error';
    const keys = Object.keys(details ?? {});

    return new WajubError({
      type,
      code,
      message,
      retryable: ![401, 403, 404, 410].includes(status),
      param: keys.length === 1 ? keys[0] : null,
      correlation_id: correlationId ?? null,
      retry_after_seconds: retryAfterSeconds ?? null,
      details,
      decline_code: status === 402 ? code : null,
      http_status: status,
    });
  }
}
