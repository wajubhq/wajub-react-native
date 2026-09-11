/** Fixed Wajub API origin — not configurable. */
export const API_URL = 'https://api.wajub.com';

/**
 * `paystack_inline` / `flutterwave_inline` are legacy values the API no
 * longer sends — Paystack/Flutterwave cards go through `client_session`.
 * `adyen_custom_card` needs Adyen's own client-side encryption, which this
 * SDK doesn't embed: treated as unavailable.
 */
export type SdkFlavor =
  | 'form'
  | 'stripe_elements'
  | 'hosted_redirect'
  | 'adyen_custom_card'
  | 'paystack_inline'
  | 'flutterwave_inline';

export interface SdkChannelConfig {
  available: boolean;
  /** Prediction only — the pinned provider is `ClientSession.provider`. */
  provider: string | null;
  sdk: SdkFlavor | null;
  publishable_key: string | null;
  required_fields: string[];
  /** true → `startClientSession()` can hand this channel to the PSP's own
   *  hosted checkout (PIN/OTP/AVS handled by the PSP). */
  client_session?: boolean;
}

/**
 * PSP-hosted checkout session (POST /pay/client-session). Default flow:
 * open `hosted_url` in the system browser, then `completeClientSession(id)`
 * when the payer returns. Apps may instead launch the PSP's native SDK
 * themselves — Paystack Android/Flutter (`public_key` + `access_code`),
 * Flutterwave Android (`public_key` + `encryption_key`, `reference` as
 * tx_ref) — and call `completeClientSession(id)` the same way.
 */
export interface ClientSession {
  id: string;
  provider: string;
  /** PSP-side reference (Paystack `reference`, Flutterwave `tx_ref`). */
  reference?: string;
  /** In the PSP's own units (Paystack: subunit; Flutterwave: major). */
  amount?: number;
  currency?: string;
  hosted_url?: string;
  access_code?: string;
  public_key?: string;
  encryption_key?: string;
}

export interface ClientSessionOptions {
  /** Required by Paystack/Flutterwave when the transaction has no customer email. */
  email?: string | null;
  name?: string | null;
  /** http(s) URL the PSP's hosted page redirects to after payment (e.g. a universal/app link). */
  return_url?: string | null;
  /** Replace a session that died on the PSP side (the old one is re-verified first). */
  restart?: boolean;
}

/** Error code for an API `action` this SDK can't perform natively — see mapProcessResponse(). */
export const UNSUPPORTED_ACTION_CODE = 'unsupported_action';

export interface SdkConfig {
  channels: Record<string, SdkChannelConfig>;
}

export interface ProcessingContext {
  channel_slug?: string | null;
  is_mobile_money?: boolean;
  payer_instruction?: string | null;
  action_url?: string | null;
}

export interface SessionTransaction {
  id: string;
  reference: string;
  trxref?: string | null;
  amount: number;
  amount_total?: number;
  currency: string;
  status: string;
  status_label?: string;
  sandbox?: boolean;
  description?: string | null;
  processing_context?: ProcessingContext | null;
}

export interface SessionChannel {
  id: string;
  slug: string;
  name: string;
  name_fr?: string;
  type: string;
  logo?: string | null;
  countries: string[];
  min_amount?: number;
  max_amount?: number;
  currency: string;
}

export interface EchoConfig {
  key: string;
  ws_host: string;
  ws_port: number;
  channel_prefix: string;
  broadcaster: string;
}

export interface SessionData {
  transaction: SessionTransaction;
  channels: SessionChannel[];
  locale?: string;
  branding?: Record<string, string | null>;
  echo?: EchoConfig;
  callback?: string | null;
}

export type WajubErrorType =
  | 'api_error'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'payment_error'
  | 'rate_limit_error';

export interface WajubErrorShape {
  type: WajubErrorType;
  code: string;
  message: string;
  decline_code?: string | null;
  retryable: boolean;
  param?: string | null;
  correlation_id?: string | null;
  retry_after_seconds?: number | null;
  details?: Record<string, string>;
}

export type ActionKind = 'redirect' | 'confirm' | 'confirm_3ds' | 'push_approval' | 'client_session';

export type PaymentResult =
  | { status: 'complete'; transaction: SessionTransaction }
  | { status: 'processing'; transaction: SessionTransaction; instruction?: string | null }
  | {
      status: 'requires_action';
      action: ActionKind;
      action_url?: string | null;
      /** Set when `action` is `client_session`; `action_url` is then its `hosted_url`. */
      client_session?: ClientSession | null;
      transaction: SessionTransaction;
    }
  | { status: 'failed'; error: WajubErrorShape; transaction: SessionTransaction | null };

export interface MobileMoneyInput {
  channel_slug: string;
  phone: string;
  country: string;
}

export interface PresentOptions {
  /** Session authorization token from your backend. */
  sessionToken: string;
  locale?: string;
}

export interface PaymentSheetResult {
  result: PaymentResult;
  cancelled: boolean;
}

export interface CancelResult {
  redirect_url: string | null;
}
