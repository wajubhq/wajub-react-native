/** Fixed Wajub API origin — not configurable. */
export const API_URL = 'https://api.wajub.com';

export type SdkFlavor =
  | 'form'
  | 'stripe_elements'
  | 'paystack_inline'
  | 'flutterwave_inline'
  | 'hosted_redirect';

export interface SdkChannelConfig {
  available: boolean;
  provider: string | null;
  sdk: SdkFlavor | null;
  publishable_key: string | null;
  required_fields: string[];
}

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

export type ActionKind = 'redirect' | 'confirm' | 'confirm_3ds' | 'push_approval';

export type PaymentResult =
  | { status: 'complete'; transaction: SessionTransaction }
  | { status: 'processing'; transaction: SessionTransaction; instruction?: string | null }
  | {
      status: 'requires_action';
      action: ActionKind;
      action_url?: string | null;
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
