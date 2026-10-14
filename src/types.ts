/** Fixed Wajub API origin — not configurable. */
export const API_URL = 'https://api.wajub.com';

// ─────────────────────────────────────────────────────────────────────────────
// Wire: GET /pay/sdk-config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `paystack_inline` / `flutterwave_inline` are legacy values the API no
 * longer sends — Paystack/Flutterwave cards go through `client_session`.
 * `adyen_custom_card` and `psp_inline` without `client_session` need a web
 * component this SDK doesn't embed: card is hidden. Unknown values: hidden.
 */
export type SdkFlavor =
  | 'form'
  | 'stripe_elements'
  | 'hosted_redirect'
  | 'adyen_custom_card'
  | 'psp_inline'
  | 'paystack_inline'
  | 'flutterwave_inline'
  | (string & {});

export interface SdkChannelConfig {
  available: boolean;
  /** Prediction only — the pinned provider is `ClientSession.provider`. */
  provider: string | null;
  sdk: SdkFlavor | null;
  publishable_key: string | null;
  required_fields: string[];
  /** true → `startClientSession()` can hand this channel to the PSP's own
   *  hosted checkout (PIN/OTP/AVS handled by the PSP). Absent = false. */
  client_session?: boolean;
  /** Web clients only: ignored. */
  inline?: string;
  /** Web clients only: ignored. */
  testmode?: boolean;
}

export interface SdkConfig {
  /** Keyed by raw slug (`cm.mtn`, `cm.orange` — never `cm.mobile`). Over-returns. */
  channels: Record<string, SdkChannelConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire: client sessions
// ─────────────────────────────────────────────────────────────────────────────

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
  customer_email?: string;
  customer_name?: string;
}

export interface ClientSessionOptions {
  /** Required by Paystack/Flutterwave when the transaction has no customer email. */
  email?: string | null;
  name?: string | null;
  /** http(s) URL the PSP's hosted page redirects to after payment (e.g. a universal/app link). */
  return_url?: string | null;
  /** Replace a session that died on the PSP side (the old one is re-verified first). */
  restart?: boolean;
  /** Billing fields the provider lists in sdk-config `required_fields`. */
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  /** ISO-2. */
  country?: string | null;
  state?: string | null;
  zip_code?: string | null;
  /** The solved Altcha challenge, when the session carries one. */
  altcha?: AltchaSolution | null;
}

/** Error code for an API `action` this SDK can't perform natively — see mapProcessResponse(). */
export const UNSUPPORTED_ACTION_CODE = 'unsupported_action';

/**
 * Contact/billing fields a `hosted_redirect` card PSP may still need before
 * it opens its page — sdk-config lists the missing ones in `required_fields`
 * (Kkiapay/FedaPay/PayDunya: `email`; CinetPay: `first_name` … `zip_code`).
 */
export type HostedCardField =
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'address'
  | 'city'
  | 'country'
  | 'state'
  | 'zip_code';

export const HOSTED_CARD_FIELDS: readonly HostedCardField[] = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'address',
  'city',
  'country',
  'state',
  'zip_code',
];

// ─────────────────────────────────────────────────────────────────────────────
// Wire: GET /pay/session
// ─────────────────────────────────────────────────────────────────────────────

/** Present only while the payment is `processing` or `partial`. */
export interface ProcessingContext {
  channel_slug?: string | null;
  is_mobile_money?: boolean;
  is_ussd?: boolean;
  is_bank_transfer?: boolean;
  /** English. May hold a USSD fallback ("dial *126#"). */
  payer_instruction?: string | null;
  /** PSP page to reopen (redirect restore). */
  action_url?: string | null;
  /** Sandbox 3-D Secure email challenge restore. */
  three_ds_id?: string | null;
  three_ds_method?: string | null;
  masked_email?: string | null;
  three_ds_timeout?: number | null;
}

export interface TransactionFee {
  /** Major units. */
  amount: number;
  /** Decimal, e.g. 0.035. */
  rate: number | null;
  description: string | null;
}

/** Major units: 25000 for 25 000 XAF, 49.9 for 49.90 EUR. */
export interface SessionTransaction {
  /** Wajub's payment id: `trx_…` / `trx_test_…`. Realtime channel suffix. */
  id: string;
  /** The merchant's reference (= trxref). NOT the `reference` of GET /pay/status. */
  reference: string;
  trxref?: string | null;
  amount: number;
  /** What the payer pays: amount + fee when `bearer` is "customer". Show this one. */
  amount_total?: number;
  amount_collected?: number;
  amount_paid?: number;
  remaining_amount?: number;
  currency: string;
  bearer?: string | null;
  fee?: TransactionFee | null;
  status: string;
  status_label?: string;
  sandbox?: boolean;
  description?: string | null;
  /** Absent when not loaded, null without a customer. */
  customer?: { name: string | null; email: string | null } | null;
  receipt_url?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  terminal_at?: string | null;
  processing_context?: ProcessingContext | null;
}

/** One member of an aggregate channel (`cm.mobile` = cm.mtn + cm.orange). */
export interface ChannelOperator {
  /** Real operator channel, e.g. "cm.orange". */
  slug: string;
  /** "mtn", "orange". */
  operator: string;
  /** In the session's locale. */
  name: string;
  logo: string | null;
}

export interface SessionChannel {
  id: string;
  slug: string;
  /** In the session's locale. */
  name: string;
  /** Always French (the wire key is literally `name.fr`). */
  'name.fr'?: string;
  /** @deprecated Read `'name.fr'`; kept equal to it. */
  name_fr?: string;
  type: string;
  logo?: string | null;
  /** ISO-2, upper case. May be empty (card). */
  countries: string[];
  min_amount?: number;
  max_amount?: number;
  currency: string;
  /** Aggregates only (`cm.mobile`): one entry per operator it folds. */
  operators?: ChannelOperator[];
}

/** Realtime (Pusher protocol): Wajub's Reverb, or hosted Pusher. */
export interface EchoConfig {
  /** Empty when broadcasting is not configured: polling only. */
  key: string;
  /** Scheme included: "wss://ws.wajub.com", "wss://ws-eu.pusher.com", "ws://localhost". */
  ws_host: string;
  ws_port: number;
  /** "private-payment." */
  channel_prefix: string;
  broadcaster: string;
}

/** The merchant's branding. Three sources with slightly different key sets: every key optional. */
export interface Branding {
  primary_color?: string | null;
  secondary_color?: string | null;
  background_color?: string | null;
  logo_url?: string | null;
  logo_square_url?: string | null;
  icon_url?: string | null;
  business_name?: string | null;
  /** "12px", "12", or "none" | "sm" | "md" | "lg" | "xl". */
  border_radius?: string | null;
  font?: string | null;
  /** "system" | "light" | "dark". */
  appearance_mode?: string | null;
  density?: string | null;
  locale?: string | null;
  /** A boolean from the API; the web also accepts an object. */
  white_label?:
    | boolean
    | { enabled?: boolean; brand_name?: string | null; support_email?: string | null; support_phone?: string | null }
    | null;
  input_background_color?: string | null;
  input_border_color?: string | null;
  text_muted_color?: string | null;
  button_text_color?: string | null;
  success_color?: string | null;
  error_color?: string | null;
  shadow?: string | null;
  /** 0–100. */
  overlay_intensity?: number | null;
  /** Integer or string, as the dashboard stored it. */
  font_weight_heading?: number | string | null;
  font_weight_body?: number | string | null;
  separator_color?: string | null;
  /** Every other key the API sends (`layout`, `card.background_color`, `tab_*`…), ignored on mobile. */
  [key: string]: unknown;
}

export interface AltchaChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

/** Sent as `data.altcha` / `altcha`. */
export interface AltchaSolution {
  algorithm: string;
  challenge: string;
  number: number;
  salt: string;
  signature: string;
}

export type SavedMethod =
  | {
      id: string;
      type: 'card';
      is_default: boolean;
      label: string;
      brand?: string | null;
      last4?: string | null;
    }
  | {
      id: string;
      type: 'mobile_money';
      is_default: boolean;
      /** Masks from the country code ("Mtn • 23••••56"): build your own label. */
      label: string;
      provider: string;
      last4: string | null;
      /** Lower case ISO-2. */
      phone_country: string | null;
    };

/** GET /pay/session, parsed leniently. */
export interface SessionData {
  transaction: SessionTransaction;
  channels: SessionChannel[];
  /** "fr" | "en"; absent when the payment has none. */
  locale?: string;
  branding?: Branding;
  /** Absent when broadcasting is off. */
  echo?: EchoConfig;
  altcha?: AltchaChallenge | null;
  /** The merchant callback with `status=succeeded` (informational). */
  return_url?: string | null;
  cancel_url?: string | null;
  /** ISO-2 of the payer's IP, when known. */
  geo_country?: string | null;
  features?: Record<string, boolean>;
  /** Absent when the customer has none. */
  saved_methods?: SavedMethod[];
  /** @deprecated Never sent by the API. */
  callback?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire: GET /pay/status, confirmation steps, cancel
// ─────────────────────────────────────────────────────────────────────────────

/** GET /pay/status `transaction`. */
export interface PaymentStatus {
  /** Wajub's payment id (= SessionTransaction.id), not the merchant reference. */
  reference: string;
  status: string;
  /** Only when an attempt was refused and the payment is back at `pending`. */
  error_code?: string;
  payer_message?: string | null;
}

export type ConfirmStepKind = 'otp' | 'pin' | 'phone' | 'birthday' | 'address';

/** POST /pay/{kind}/verify — HTTP 200 for both. */
export type StepVerifyResponse =
  | { status: 'success'; transaction: SessionTransaction | null }
  | {
      status: 'failed';
      attempts_remaining: number | null;
      error: { code: string; message: string };
    };

export interface CancelResult {
  redirect_url: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level results (WajubSession)
// ─────────────────────────────────────────────────────────────────────────────

export type WajubErrorType =
  | 'api_error'
  | 'authentication_error'
  | 'invalid_request_error'
  | 'payment_error'
  | 'rate_limit_error';

/** Wajub.js's error shape plus the mobile fields (spec errors.md §1). */
export interface WajubErrorShape {
  name?: 'WajubError';
  type: WajubErrorType;
  /** The catalogue's code, or an API code passed through. */
  code: string;
  /** Payer-facing, in the sheet's language. */
  message: string;
  /** 402: the API's `error_code`. */
  decline_code?: string | null;
  retryable: boolean;
  /** The field at fault, e.g. "data.phone". */
  param?: string | null;
  http_status?: number | null;
  /** The response's X-Request-Id. */
  correlation_id?: string | null;
  /** 429. */
  retry_after_seconds?: number | null;
  /** The API's `errors`, first message per key. */
  details?: Record<string, string> | null;
  /** 403 `shield_blocked`. */
  block_reference?: string | null;
  /** The API's own (English) message, for logs. */
  api_message?: string | null;
}

/**
 * What one `/pay/process` (or client-session) answer asks for. `push_approval`
 * is a Mobile Money push waiting on the phone; `confirm_otp` … `confirm_address`
 * carry `stepId` and `hint` for `WajubSession.verifyOtp()` and friends.
 */
export type ActionKind =
  | 'redirect'
  | 'confirm'
  | 'confirm_3ds'
  | 'push_approval'
  | 'client_session'
  | 'confirm_otp'
  | 'confirm_pin'
  | 'confirm_phone'
  | 'confirm_birthday'
  | 'confirm_address';

export type PaymentResult =
  | { status: 'complete'; transaction: SessionTransaction }
  | {
      status: 'processing';
      transaction: SessionTransaction;
      instruction?: string | null;
      /** `ussd`: the payer dials the code in `instruction`; `pending`: nothing to do but wait. */
      kind?: 'ussd' | 'pending';
    }
  | {
      status: 'requires_action';
      action: ActionKind;
      /** `confirm_url`, or `client_session.hosted_url`. */
      action_url?: string | null;
      /** Set when `action` is `client_session`; `action_url` is then its `hosted_url`. */
      client_session?: ClientSession | null;
      /** `otp_id` / `pin_id` / `phone_id` / `birthday_id` / `address_id` / `three_ds_id`. */
      stepId?: string | null;
      /** `otp_masked_contact` / `*_instruction` / `masked_email`. */
      hint?: string | null;
      transaction: SessionTransaction;
    }
  | { status: 'failed'; error: WajubErrorShape; transaction: SessionTransaction | null };

/** Spec v2's name for one `/pay/process` answer: this SDK's `PaymentResult`. */
export type ProcessOutcome = PaymentResult;

export interface MobileMoneyInput {
  channel_slug: string;
  /** Any input: the SDK sends it in E.164. */
  phone: string;
  country: string;
  /** Aggregates only (`cm.mobile`): the operator the payer named, e.g. "mtn". */
  operator?: string | null;
}

/** @deprecated `present()` resolves a `CheckoutResult`. */
export interface PaymentSheetResult {
  result: PaymentResult;
  cancelled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment sheet: states, callbacks, results (spec states.md)
// ─────────────────────────────────────────────────────────────────────────────

/** Wajub.js's `CheckoutState`, exact names. */
export type CheckoutState =
  | 'INITIATED'
  | 'COLLECTING_DETAILS'
  | 'PROCESSING'
  | 'OTP_REQUIRED'
  | 'PIN_REQUIRED'
  | 'PHONE_REQUIRED'
  | 'BIRTHDAY_REQUIRED'
  | 'ADDRESS_REQUIRED'
  | '3DS_REQUIRED'
  | 'USSD_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'VERIFYING'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

/** Wajub.js's `PaymentSuccess`. Confirm server-side before delivering. */
export interface PaymentSuccess {
  /** `transaction.id`. */
  id: string;
  /** `transaction.reference` (the merchant's). */
  reference?: string;
  /** `amount_total`, major units. */
  amount: number;
  currency: string;
  /** "mobile_money" | "card" | "wallet" | "unknown" (already paid at load). */
  method: string;
  status: 'success';
  /** ISO 8601: `terminal_at`, else `updated_at`, else now. */
  timestamp: string;
  receipt_url?: string;
}

export type CancelReason = 'payer_cancelled' | 'dismissed' | 'host_gone';

/** What `present()` resolves with, exactly once. */
export type CheckoutResult =
  | { status: 'complete'; payment: PaymentSuccess; transaction: SessionTransaction }
  | { status: 'processing'; transaction: SessionTransaction | null }
  | { status: 'failed'; error: WajubErrorShape; transaction: SessionTransaction | null }
  | {
      status: 'cancelled';
      reason: CancelReason;
      redirectUrl: string | null;
      /** @deprecated Kept for code written against 1.4: test `status === 'cancelled'`. */
      cancelled: true;
    };

export interface ReadyEvent {
  sessionId: string;
  environment: 'sandbox' | 'live';
  amount: number;
  currency: string;
  /** Channel slugs shown. */
  methods: string[];
}

export interface StateChangeEvent {
  state: CheckoutState;
  /** "mobile_money" | "card" | "wallet" | "unknown". */
  method?: string;
}

export interface PaymentStartedEvent {
  method: string;
  channel: string;
}

/** Wajub.js's redirect event. */
export interface RedirectEvent {
  url: string;
  method: 'GET';
}

export interface CancelEvent {
  reason: CancelReason;
  redirectUrl: string | null;
}

/** All optional, all called on the JS thread; one that throws is logged and ignored. */
export interface CheckoutCallbacks {
  onReady?(event: ReadyEvent): void;
  onStateChange?(event: StateChangeEvent): void;
  onLoadError?(error: WajubErrorShape): void;
  onPaymentStarted?(event: PaymentStartedEvent): void;
  onRedirect?(event: RedirectEvent): void;
  onSuccess?(payment: PaymentSuccess): void;
  onError?(error: WajubErrorShape): void;
  onCancel?(event: CancelEvent): void;
  onComplete?(result: CheckoutResult): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance (spec appearance.md) — the same object as Wajub.js
// ─────────────────────────────────────────────────────────────────────────────

/** Wajub.js's variable names, exactly. */
export interface AppearanceVariables {
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  colorTextSecondary?: string;
  colorTextPlaceholder?: string;
  colorDanger?: string;
  colorSuccess?: string;
  fontFamily?: string;
  fontSizeBase?: string;
  fontWeightNormal?: string;
  fontWeightMedium?: string;
  fontWeightBold?: string;
  spacingUnit?: string;
  borderRadius?: string;
  spacingGridRow?: string;
  spacingGridColumn?: string;
}

export type AppearanceColorScheme = 'light' | 'dark' | 'auto';
export type AppearanceThemePreset = 'stripe' | 'night' | 'flat' | 'none';

export interface Appearance {
  /** A preset, or the colour scheme ("system" = "auto"). */
  theme?: AppearanceThemePreset | 'light' | 'dark' | 'system' | 'auto';
  colorScheme?: AppearanceColorScheme;
  /** Follow the app's colour scheme (`useColorScheme()`). */
  inherit?: boolean;
  variables?: AppearanceVariables;
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
  borderRadius?: string;
  buttonTextColor?: string;
  inputBackgroundColor?: string;
  inputBorderColor?: string;
  textMutedColor?: string;
  successColor?: string;
  errorColor?: string;
  shadow?: 'none' | 'low' | 'high';
  labels?: 'above' | 'floating';
  disableAnimations?: boolean;
}

/** The sheet's resolved colours. */
export interface ThemeTokens {
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  background: string;
  surfaceRaised: string;
  surfaceMuted: string;
  selectedBackground: string;
  text: string;
  textSecondary: string;
  textPlaceholder: string;
  textDisabled: string;
  link: string;
  inputBackground: string;
  inputBorder: string;
  borderStrong: string;
  focusRing: string;
  danger: string;
  dangerBorder: string;
  dangerBackground: string;
  success: string;
  successBackground: string;
  warning: string;
  warningBackground: string;
  disabledBackground: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// present()
// ─────────────────────────────────────────────────────────────────────────────

export interface PresentOptions extends CheckoutCallbacks {
  /** Session authorization token from your backend. */
  sessionToken: string;
  /** "fr" | "en"; else the payment's own language, else the device's. */
  locale?: string;
  appearance?: Appearance;
  /** What shows while the payment loads. Default "skeleton". */
  loader?: 'skeleton' | 'spinner';
  /** ms before a load that has not finished shows an error with Retry. Default 15000; 0 disables. */
  readyTimeout?: number;
  /** https universal/app link the provider's page sends the payer back to. */
  returnUrl?: string;
  mobileMoney?: {
    /** ISO-2 to start on. */
    country?: string;
    /** Hide the country selector when `country` is offered. */
    countryLocked?: boolean;
    /** "detect": no operator list until the number does not tell. Default "choose". */
    operatorMode?: 'choose' | 'detect';
  };
  /** Override the realtime server (a self-hosted Reverb or Soketi), or turn realtime off. */
  realtime?: { enabled?: boolean; host?: string; port?: number; tls?: boolean };
  /** A dismiss before any attempt cancels the payment (POST /pay/cancel). Default true. */
  cancelOnDismiss?: boolean;
  /** ms before the success screen closes itself; 0 keeps it. Default 3000. */
  autoCloseSuccess?: number;
}
