/** Wajub's API origin. */
export const API_URL = 'https://api.wajub.com';

// ─────────────────────────────────────────────────────────────────────────────
// How each payment method is paid
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a payment method collects its details. The sheet offers the ones it can
 * draw and hides the others; other values may come.
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
  /** The provider expected to carry the payment, when known. */
  provider: string | null;
  sdk: SdkFlavor | null;
  publishable_key: string | null;
  required_fields: string[];
  /** `true`: `startClientSession()` opens the provider's own checkout for this method. */
  client_session?: boolean;
  /** For web pages: ignored here. */
  inline?: string;
  /** For web pages: ignored here. */
  testmode?: boolean;
}

export interface SdkConfig {
  /** By payment method slug. */
  channels: Record<string, SdkChannelConfig>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The provider's own checkout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A card checkout run by the payment's provider: open `hosted_url` in the
 * system browser, then call `completeClientSession(id)` when the payer comes
 * back. An app that launches the provider's own SDK with these values calls
 * `completeClientSession(id)` the same way.
 */
export interface ClientSession {
  id: string;
  provider: string;
  /** The provider's reference for this checkout. */
  reference?: string;
  /** In the provider's own units. */
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
  /** Needed when the payment has no customer email. */
  email?: string | null;
  name?: string | null;
  /** An `https` universal or app link the provider's page sends the payer back to. */
  return_url?: string | null;
  /** Start a new checkout in place of one that expired at the provider. */
  restart?: boolean;
  /** Billing fields the payment method asks for (`required_fields`). */
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  /** ISO-2. */
  country?: string | null;
  state?: string | null;
  zip_code?: string | null;
  /** The security check's answer, when the payment asks for one. */
  altcha?: AltchaSolution | null;
}

/** Error code for a payment step this SDK cannot perform — see mapProcessResponse(). */
export const UNSUPPORTED_ACTION_CODE = 'unsupported_action';

/**
 * Contact and billing fields a card payment may ask for before the
 * provider's page opens: the method's `required_fields` lists them.
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
// The payment
// ─────────────────────────────────────────────────────────────────────────────

/** Present only while the payment is `processing` or `partial`. */
export interface ProcessingContext {
  channel_slug?: string | null;
  is_mobile_money?: boolean;
  is_ussd?: boolean;
  is_bank_transfer?: boolean;
  /** English. May hold a USSD fallback ("dial *126#"). */
  payer_instruction?: string | null;
  /** The provider's page, to reopen. */
  action_url?: string | null;
  /** The sandbox 3-D Secure email code under way. */
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
  /** Wajub's payment id: `trx_…` / `trx_test_…`. */
  id: string;
  /** The merchant's reference (= trxref). Not the `reference` of `PaymentStatus`, which is the payment's id. */
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
  /**
   * The refusal that put the payment back at `pending` (its code), `null`
   * when there is none. Absent from older answers.
   */
  error_code?: string | null;
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
  /** The same logo as a PNG, where `logo` is an SVG; `null` or absent when there is none. */
  logo_png?: string | null;
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
  /** The same logo as a PNG, where `logo` is an SVG; `null` or absent when there is none. */
  logo_png?: string | null;
  /** ISO-2, upper case. May be empty (card). */
  countries: string[];
  min_amount?: number;
  max_amount?: number;
  currency: string;
  /** Aggregates only (`cm.mobile`): one entry per operator it folds. */
  operators?: ChannelOperator[];
}

/** The payment's live status updates; the SDK uses them on its own. */
export interface EchoConfig {
  /** Empty when the payment has none. */
  key: string;
  /** Scheme included. */
  ws_host: string;
  ws_port: number;
  channel_prefix: string;
  broadcaster: string;
}

/** The merchant's branding. Every key is optional. */
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
  /** `true`: no "Secured by Wajub". */
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
  /** An integer, or a numeric string. */
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

/** The answer to the payment's security check. */
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

/** The payment, its payment methods and the merchant's branding. */
export interface SessionData {
  transaction: SessionTransaction;
  channels: SessionChannel[];
  /** "fr" | "en"; absent when the payment has none. */
  locale?: string;
  /** The merchant's branding as the API sent it (some values are numbers or booleans). Typed: `parsedBranding`. */
  branding?: Record<string, string | null>;
  /** `branding`, read with its types (white label, weights, overlay…). */
  parsedBranding?: Branding;
  /** Absent when the payment has no live status updates. */
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
// Status, confirmation steps, cancel
// ─────────────────────────────────────────────────────────────────────────────

/** Where a payment is. */
export interface PaymentStatus {
  /** Wajub's payment id (= `SessionTransaction.id`), not the merchant's reference. */
  reference: string;
  status: string;
  /** Only when an attempt was refused and the payment is back at `pending`. */
  error_code?: string;
  /** The refusal's message for the payer; `null` without one. */
  payer_message?: string | null;
}

export type ConfirmStepKind = 'otp' | 'pin' | 'phone' | 'birthday' | 'address';

/**
 * The next step a provider asks for after a confirmation step: `action` and
 * its fields, as a payment's own answer carries them (`confirm_otp` with
 * `otp_id` and `otp_masked_contact`, `redirect` with `confirm_url`, …).
 */
export interface StepFields {
  action?: string;
  confirm_url?: string;
  three_ds_id?: string;
  three_ds_method?: string;
  masked_email?: string;
  three_ds_timeout?: number;
  otp_id?: string;
  otp_masked_contact?: string;
  pin_id?: string;
  pin_instruction?: string;
  phone_id?: string;
  phone_instruction?: string;
  birthday_id?: string;
  birthday_instruction?: string;
  address_id?: string;
  address_instruction?: string;
  client_session?: ClientSession;
}

export type StepVerifyResponse =
  | ({ status: 'success'; transaction: SessionTransaction | null } & StepFields)
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

/** The fields of a `WajubError`. */
export interface WajubErrorShape {
  name?: 'WajubError';
  type: WajubErrorType;
  /** What went wrong, to branch on. */
  code: string;
  /** Payer-facing, in the sheet's language. */
  message: string;
  /** On a decline, its reason. */
  decline_code?: string | null;
  retryable: boolean;
  /** The field at fault, e.g. "data.phone". */
  param?: string | null;
  correlation_id?: string | null;
  /** The wait on `rate_limited`. */
  retry_after_seconds?: number | null;
  /** The field errors, first message per field. */
  details?: Record<string, string>;
  http_status?: number | null;
  /** On `shield_blocked`, the reference to quote to Wajub support. */
  block_reference?: string | null;
  /** Wajub's own English text, for your logs. */
  api_message?: string | null;
}

/** `WajubError.toJSON()`: the plain shape. */
export interface WajubErrorJSON {
  name: 'WajubError';
  type: WajubErrorType;
  code: string;
  message: string;
  decline_code: string | null;
  retryable: boolean;
  param: string | null;
  http_status: number | null;
  correlation_id: string | null;
  retry_after_seconds: number | null;
  details: Record<string, string> | null;
  block_reference: string | null;
  api_message: string | null;
}

export type ActionKind = 'redirect' | 'confirm' | 'confirm_3ds' | 'push_approval' | 'client_session';

/** A payment attempt's answer, as `mapProcessResponse()` and the 1.4 `WajubSession` methods read it. */
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

/** What a payment attempt asks for next; other values may come. */
export type ProcessAction =
  | 'redirect'
  | 'confirm'
  | 'confirm_3ds'
  | 'confirm_otp'
  | 'confirm_pin'
  | 'confirm_phone'
  | 'confirm_birthday'
  | 'confirm_address'
  | 'client_session'
  | (string & {});

/**
 * A payment attempt's answer, as `WajubSession.submit()` reads it: a
 * confirmation step carries its `stepId` and `hint`; a step the SDK cannot
 * perform is `failed` / `unsupported_action`.
 */
export type ProcessOutcome =
  | { status: 'complete'; transaction: SessionTransaction }
  | { status: 'processing'; transaction: SessionTransaction | null; instruction: string | null; kind: 'approval' | 'ussd' | 'pending' }
  | {
      status: 'requires_action';
      action: ProcessAction;
      /** The provider's page to open. */
      url: string | null;
      /** The confirmation step's id, for its verify call. */
      stepId: string | null;
      /** What to show the payer with the step (where a code was sent, an instruction). */
      hint: string | null;
      clientSession: ClientSession | null;
      transaction: SessionTransaction | null;
    }
  | { status: 'failed'; error: WajubErrorShape; transaction: SessionTransaction | null };

export interface MobileMoneyInput {
  channel_slug: string;
  phone: string;
  country: string;
}

/** @deprecated `present()` resolves a `CheckoutResult`. */
export interface PaymentSheetResult {
  result: PaymentResult;
  cancelled: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment sheet: states, callbacks, results
// ─────────────────────────────────────────────────────────────────────────────

/** The sheet's states, as `onStateChange` reports them. */
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

/** A successful payment. Confirm it on your server before delivering. */
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

/** How the sheet closed: what `onComplete` gets and `present()` resolves with. */
export type CheckoutResult =
  | { status: 'complete'; payment: PaymentSuccess; transaction: SessionTransaction }
  /** An attempt started (so the payment is known) and has no outcome yet. */
  | { status: 'processing'; transaction: SessionTransaction; instruction?: string | null }
  | { status: 'failed'; error: WajubErrorShape; transaction: SessionTransaction | null }
  | {
      status: 'cancelled';
      reason: CancelReason;
      redirectUrl: string | null;
      /** @deprecated Kept for code written against 1.4: test `status === 'cancelled'`. */
      cancelled: true;
    };

/**
 * @deprecated Never produced since 1.5: approvals, steps and provider pages
 * happen in the sheet. Kept in `present()`'s type so 1.4 code still compiles.
 */
export type DeprecatedRequiresAction = Extract<PaymentResult, { status: 'requires_action' }>;

/** What `present()` resolves with: a `CheckoutResult` (1.4's `requires_action` never comes). */
export type PresentResult = CheckoutResult | DeprecatedRequiresAction;

/** Key-value storage that outlives the app, as `@react-native-async-storage/async-storage` offers. */
export interface WajubStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

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

/** A provider's page about to open in the system browser. */
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
// Appearance
// ─────────────────────────────────────────────────────────────────────────────

/** The appearance variables. */
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
  /** Closing the sheet before any attempt cancels the payment. `false` keeps it open, to present it again. Default true. */
  cancelOnDismiss?: boolean;
  /** ms before the success screen closes itself; 0 keeps it. Default 3000. */
  autoCloseSuccess?: number;
  /** Where the SDK keeps its data: any `{ getItem, setItem }`. Default: AsyncStorage. */
  storage?: WajubStorage;
  /**
   * Stripe cards need nothing more. If your app also takes its own Stripe
   * payments, give its publishable key so they keep working after the sheet.
   */
  stripe?: { appPublishableKey?: string };
}
