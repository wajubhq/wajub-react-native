import type { WajubErrorShape, WajubErrorType } from './types';

export class WajubError extends Error implements WajubErrorShape {
  readonly type: WajubErrorType;
  readonly code: string;
  readonly decline_code?: string | null;
  readonly retryable: boolean;
  readonly param?: string | null;
  readonly correlation_id?: string | null;
  readonly retry_after_seconds?: number | null;
  readonly details?: Record<string, string>;

  constructor(shape: WajubErrorShape) {
    super(shape.message);
    this.name = 'WajubError';
    this.type = shape.type;
    this.code = shape.code;
    this.decline_code = shape.decline_code;
    this.retryable = shape.retryable;
    this.param = shape.param;
    this.correlation_id = shape.correlation_id;
    this.retry_after_seconds = shape.retry_after_seconds;
    this.details = shape.details;
  }

  static network(message: string): WajubError {
    return new WajubError({
      type: 'api_error',
      code: 'network_error',
      message,
      retryable: true,
    });
  }

  static fromHttp(
    status: number,
    message: string,
    code: string,
    details: Record<string, string>,
    correlationId?: string | null,
    retryAfterSeconds?: number | null,
  ): WajubError {
    const type: WajubErrorType =
      status === 401 || status === 404
        ? 'authentication_error'
        : status === 422
          ? 'invalid_request_error'
          : status === 429
            ? 'rate_limit_error'
            : 'payment_error';

    return new WajubError({
      type,
      code,
      message,
      retryable: status !== 403,
      correlation_id: correlationId ?? null,
      retry_after_seconds: retryAfterSeconds ?? null,
      details,
      decline_code: status === 402 ? code : null,
    });
  }
}
