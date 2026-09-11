import { API_URL } from '../types';
import type { CancelResult, ClientSessionOptions, SdkConfig, SessionData } from '../types';
import { WajubError } from '../WajubError';
import type { RawProcessResponse } from '../mappers/paymentMapper';

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `wajub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function flattenErrors(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > 0) {
      out[key] = String(value[0]);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

function mapHttpError(status: number, body: Record<string, unknown>, headers: Headers): WajubError {
  const message =
    typeof body.message === 'string' && body.message.length > 0
      ? body.message
      : `Request failed (${status})`;
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

export class PayClient {
  async getSession(token: string): Promise<SessionData> {
    const body = await this.request<SessionData>('GET', token, '/pay/session');
    return body;
  }

  async getSdkConfig(token: string): Promise<SdkConfig> {
    return this.request<SdkConfig>('GET', token, '/pay/sdk-config');
  }

  async process(token: string, channel: string, data: Record<string, unknown>): Promise<RawProcessResponse> {
    return this.request<RawProcessResponse>('POST', token, '/pay/process', {
      channel,
      data,
    }, { 'Idempotency-Key': idempotencyKey() });
  }

  /**
   * POST /pay/client-session — opens (or re-serves) a PSP-hosted checkout
   * for `channel`. Idempotent server-side; pins the provider.
   */
  async startClientSession(token: string, channel: string, options: ClientSessionOptions = {}): Promise<RawProcessResponse> {
    const body: Record<string, unknown> = { channel };
    if (options.email) body.email = options.email;
    if (options.name) body.name = options.name;
    if (options.return_url) body.return_url = options.return_url;
    if (options.restart) body.restart = true;
    return this.request<RawProcessResponse>('POST', token, '/pay/client-session', body);
  }

  /**
   * POST /pay/client-session/complete — the backend verifies with the PSP by
   * its own reference; the client never sends a PSP reference.
   */
  async completeClientSession(token: string, clientSessionId: string): Promise<RawProcessResponse> {
    return this.request<RawProcessResponse>('POST', token, '/pay/client-session/complete', {
      client_session_id: clientSessionId,
    });
  }

  async cancel(token: string): Promise<CancelResult> {
    const body = await this.request<{ redirect_url?: string }>('POST', token, '/pay/cancel', {});
    return { redirect_url: body.redirect_url ?? null };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    token: string,
    path: string,
    jsonBody?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = `${API_URL.replace(/\/+$/, '')}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // AuthenticatePaymentSession (api.wajub) reads this via Laravel's
      // Request::bearerToken(), which requires the literal "Bearer " prefix —
      // without it every /pay/* call 401s with "Payment session token required."
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    };

    const init: RequestInit = { method, headers };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(jsonBody ?? {});
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      throw WajubError.network(e instanceof Error ? e.message : 'Network error');
    }

    const text = await response.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      throw mapHttpError(response.status, body, response.headers);
    }

    return body as T;
  }
}
