/**
 * Lenient readers for every `/pay/*` body (spec README §2.6, conformance
 * PR-01…PR-08): unknown keys are ignored, every key is optional, numbers
 * arrive as integers, decimals or numeric strings, booleans as booleans,
 * 0/1 or "true"/"false", and keys with a dot (`name.fr`) are literal keys.
 *
 * An object read here keeps every key of the answer, as 1.4 handed the JSON
 * over as it came (`payment_limits`, `checkout_fields`, `currency_conversion`,
 * `tax`, `processing_context.bank_transfer_account`…): the keys the SDK reads
 * carry the values read here, and one it reads as absent or unusable is left out.
 */
import type {
  AltchaChallenge,
  Branding,
  ChannelOperator,
  ClientSession,
  EchoConfig,
  PaymentStatus,
  ProcessingContext,
  SavedMethod,
  SdkChannelConfig,
  SdkConfig,
  SdkFlavor,
  SessionChannel,
  SessionData,
  SessionTransaction,
  StepVerifyResponse,
} from '../types';

type Json = Record<string, unknown>;

/** A body the SDK cannot use at all: a session without a numeric `transaction.amount`. */
export class WajubParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WajubParseError';
  }
}

export function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string, or a number written as one (ids sometimes arrive as numbers). */
export function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A non-empty string. */
function text(value: unknown): string | undefined {
  const s = str(value);
  return s ? s : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

/**
 * `read` laid over the answer's own object: its other keys stay as they came.
 * A key `read` has as `undefined`, or one of `handled` it does not have, is left out.
 */
function keep<T extends object>(raw: Json, read: T, handled: readonly string[] = []): T {
  const out: Json = { ...raw };
  for (const key of handled) delete out[key];
  for (const [key, value] of Object.entries(read)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as T;
}

function parseProcessingContext(raw: unknown): ProcessingContext | undefined {
  const c = obj(raw);
  if (!c) return undefined;
  return keep(c, {
    channel_slug: nullable(str(c.channel_slug)),
    is_mobile_money: bool(c.is_mobile_money) ?? false,
    is_ussd: bool(c.is_ussd) ?? false,
    is_bank_transfer: bool(c.is_bank_transfer) ?? false,
    payer_instruction: nullable(text(c.payer_instruction)),
    action_url: nullable(text(c.action_url)),
    three_ds_id: nullable(text(c.three_ds_id)),
    three_ds_method: nullable(str(c.three_ds_method)),
    masked_email: nullable(str(c.masked_email)),
    three_ds_timeout: nullable(num(c.three_ds_timeout)),
  });
}

/**
 * `strict`: a session needs a numeric `amount` (a parse error otherwise);
 * a transaction riding on another answer reads a bad one as 0.
 */
export function parseTransaction(raw: unknown, strict = false): SessionTransaction {
  const t = obj(raw) ?? {};
  const amount = num(t.amount);
  if (amount === undefined && strict) {
    throw new WajubParseError('transaction.amount is not a number');
  }
  const fee = obj(t.fee);
  const customer = t.customer === null ? null : obj(t.customer);
  const transaction: SessionTransaction = {
    id: str(t.id) ?? '',
    reference: str(t.reference) ?? '',
    trxref: nullable(str(t.trxref)),
    amount: amount ?? 0,
    amount_total: num(t.amount_total) ?? amount ?? 0,
    amount_collected: num(t.amount_collected),
    amount_paid: num(t.amount_paid),
    remaining_amount: num(t.remaining_amount),
    currency: str(t.currency) ?? '',
    bearer: nullable(str(t.bearer)),
    fee: fee ? keep(fee, { amount: num(fee.amount) ?? 0, rate: nullable(num(fee.rate)), description: nullable(str(fee.description)) }) : null,
    status: str(t.status) ?? 'pending',
    status_label: str(t.status_label),
    sandbox: bool(t.sandbox) ?? false,
    description: nullable(str(t.description)),
    receipt_url: nullable(text(t.receipt_url)),
    expires_at: nullable(text(t.expires_at)),
    created_at: nullable(text(t.created_at)),
    updated_at: nullable(text(t.updated_at)),
    terminal_at: nullable(text(t.terminal_at)),
  };
  if (customer === null) transaction.customer = null;
  else if (customer) transaction.customer = keep(customer, { name: nullable(str(customer.name)), email: nullable(str(customer.email)) });
  const context = parseProcessingContext(t.processing_context);
  if (context) transaction.processing_context = context;
  return keep(t, transaction, ['customer', 'processing_context']);
}

function parseOperator(raw: unknown): ChannelOperator | undefined {
  const o = obj(raw);
  const operator = text(o?.operator);
  if (!o || !operator) return undefined;
  return keep(o, { slug: str(o.slug) ?? '', operator: operator.toLowerCase(), name: str(o.name) ?? operator, logo: nullable(text(o.logo)) });
}

export function parseChannel(raw: unknown): SessionChannel | undefined {
  const c = obj(raw);
  const slug = text(c?.slug) ?? text(c?.id);
  if (!c || !slug) return undefined;
  const channel: SessionChannel = {
    id: str(c.id) ?? slug,
    slug,
    name: str(c.name) ?? slug,
    type: (str(c.type) ?? '').toLowerCase(),
    logo: nullable(text(c.logo)),
    countries: arr(c.countries)
      .map((country) => str(country)?.toUpperCase())
      .filter((country): country is string => !!country),
    currency: str(c.currency) ?? '',
  };
  const nameFr = str(c['name.fr']);
  if (nameFr !== undefined) {
    channel['name.fr'] = nameFr;
    channel.name_fr = nameFr;
  }
  const min = num(c.min_amount);
  const max = num(c.max_amount);
  if (min !== undefined) channel.min_amount = min;
  if (max !== undefined) channel.max_amount = max;
  const operators = arr(c.operators)
    .map(parseOperator)
    .filter((o): o is ChannelOperator => !!o);
  if (operators.length > 0) channel.operators = operators;
  return keep(c, channel, ['name.fr', 'name_fr', 'min_amount', 'max_amount', 'operators']);
}

function parseEcho(raw: unknown): EchoConfig | undefined {
  const e = obj(raw);
  if (!e) return undefined;
  return keep(e, {
    key: str(e.key) ?? '',
    ws_host: str(e.ws_host) ?? '',
    ws_port: num(e.ws_port) ?? 443,
    channel_prefix: str(e.channel_prefix) ?? 'private-payment.',
    broadcaster: str(e.broadcaster) ?? 'pusher',
  });
}

/** The branding keys the API sends (three sources); anything else is dropped. */
const BRANDING_KEYS = [
  'primary_color', 'secondary_color', 'background_color', 'logo_url', 'logo_square_url', 'icon_url',
  'custom_domain', 'business_name', 'layout', 'border_radius', 'font', 'appearance_mode', 'density',
  'cover_style', 'locale', 'custom_css', 'white_label', 'card.background_color', 'card.border_color',
  'input_background_color', 'input_border_color', 'text_muted_color', 'button_text_color', 'success_color',
  'error_color', 'shadow', 'overlay_intensity', 'tab_active_bg', 'tab_active_text', 'tab_inactive_bg',
  'tab_inactive_text', 'font_weight_heading', 'font_weight_body', 'step_active_bg', 'step_done_bg',
  'step_inactive_bg', 'accordion_header_bg', 'accordion_body_bg', 'separator_color',
];

function parseBranding(raw: unknown): Branding {
  const b = obj(raw) ?? {};
  const branding: Branding = {};
  for (const key of BRANDING_KEYS) {
    if (key in b) branding[key] = typeof b[key] === 'string' ? b[key] : null;
  }
  const whiteLabel = obj(b.white_label);
  branding.white_label = whiteLabel
    ? {
        enabled: bool(whiteLabel.enabled) ?? false,
        brand_name: nullable(str(whiteLabel.brand_name)),
        support_email: nullable(str(whiteLabel.support_email)),
        support_phone: nullable(str(whiteLabel.support_phone)),
      }
    : nullable(bool(b.white_label));
  branding.overlay_intensity = nullable(num(b.overlay_intensity));
  for (const key of ['font_weight_heading', 'font_weight_body'] as const) {
    branding[key] = nullable(num(b[key]) ?? str(b[key]));
  }
  return branding;
}

function parseAltcha(raw: unknown): AltchaChallenge | null {
  const a = obj(raw);
  const challenge = text(a?.challenge);
  if (!a || !challenge) return null;
  return keep(a, {
    algorithm: str(a.algorithm) ?? 'SHA-256',
    challenge,
    salt: str(a.salt) ?? '',
    signature: str(a.signature) ?? '',
    maxnumber: num(a.maxnumber) ?? 1_000_000,
  });
}

function parseSavedMethod(raw: unknown): SavedMethod | undefined {
  const m = obj(raw);
  const id = str(m?.id);
  if (!m || !id) return undefined;
  const base = { id, is_default: bool(m.is_default) ?? false, label: str(m.label) ?? '' };
  if (m.type === 'mobile_money') {
    return keep<SavedMethod>(m, {
      ...base,
      type: 'mobile_money',
      provider: str(m.provider) ?? '',
      last4: nullable(str(m.last4)),
      phone_country: nullable(str(m.phone_country)),
    });
  }
  if (m.type === 'card') {
    return keep<SavedMethod>(m, { ...base, type: 'card', brand: nullable(str(m.brand)), last4: nullable(str(m.last4)) });
  }
  return undefined;
}

/** GET /pay/session. Throws `WajubParseError` without a usable transaction. */
export function parseSession(raw: unknown): SessionData {
  const body = obj(raw) ?? {};
  if (!obj(body.transaction)) {
    throw new WajubParseError('transaction is missing');
  }
  const session: SessionData = {
    transaction: parseTransaction(body.transaction, true),
    channels: arr(body.channels)
      .map(parseChannel)
      .filter((c): c is SessionChannel => !!c),
    parsedBranding: parseBranding(body.branding),
    altcha: parseAltcha(body.altcha),
    return_url: nullable(text(body.return_url)),
    cancel_url: nullable(text(body.cancel_url)),
    geo_country: nullable(text(body.geo_country)?.toUpperCase()),
  };
  const locale = text(body.locale);
  if (locale) session.locale = locale;
  // As the API sent it, for code written against 1.4 (some values are numbers or booleans).
  const branding = obj(body.branding);
  if (branding) session.branding = branding as Record<string, string | null>;
  const echo = parseEcho(body.echo);
  if (echo) session.echo = echo;
  const features = obj(body.features);
  if (features) {
    session.features = Object.fromEntries(Object.entries(features).map(([k, v]) => [k, bool(v) ?? false]));
  }
  if (Array.isArray(body.saved_methods)) {
    session.saved_methods = body.saved_methods.map(parseSavedMethod).filter((m): m is SavedMethod => !!m);
  }
  return keep(body, session, ['locale', 'branding', 'echo', 'features', 'saved_methods']);
}

/** GET /pay/sdk-config. */
export function parseSdkConfig(raw: unknown): SdkConfig {
  const channels: Record<string, SdkChannelConfig> = {};
  for (const [slug, value] of Object.entries(obj(obj(raw)?.channels) ?? {})) {
    const c = obj(value);
    if (!c) continue;
    const read: SdkChannelConfig = {
      available: bool(c.available) ?? false,
      provider: nullable(str(c.provider)),
      // The API may send flavours the 1.4 type does not name (`psp_inline`…).
      sdk: nullable(str(c.sdk)) as SdkFlavor | null,
      publishable_key: nullable(text(c.publishable_key)),
      required_fields: arr(c.required_fields)
        .map((f) => str(f))
        .filter((f): f is string => !!f),
    };
    const clientSession = bool(c.client_session);
    if (clientSession !== undefined) read.client_session = clientSession;
    if (str(c.inline)) read.inline = str(c.inline);
    if (bool(c.testmode) !== undefined) read.testmode = bool(c.testmode);
    channels[slug] = keep(c, read, ['client_session', 'inline', 'testmode']);
  }
  return keep(obj(raw) ?? {}, { channels });
}

/** GET /pay/status `transaction`, and a realtime `PaymentStatusUpdated` payload (a JSON string or an object). */
export function parseStatus(raw: unknown): PaymentStatus {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const body = obj(value) ?? {};
  const t = obj(body.transaction) ?? body;
  const status: PaymentStatus = { reference: str(t.reference) ?? '', status: (str(t.status) ?? '').toLowerCase() };
  const errorCode = text(t.error_code);
  if (errorCode) status.error_code = errorCode;
  if ('payer_message' in t) status.payer_message = nullable(text(t.payer_message));
  return status;
}

/** 2xx of /pay/process, /pay/client-session and /pay/client-session/complete. */
export interface RawProcessBody {
  code: number;
  status: string;
  message: string;
  action?: string | null;
  transaction?: SessionTransaction;
  confirm_url?: string;
  simulator_url?: string;
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

const PROCESS_STRINGS = [
  'confirm_url',
  'simulator_url',
  'three_ds_id',
  'three_ds_method',
  'masked_email',
  'otp_id',
  'otp_masked_contact',
  'pin_id',
  'pin_instruction',
  'phone_id',
  'phone_instruction',
  'birthday_id',
  'birthday_instruction',
  'address_id',
  'address_instruction',
] as const;

function parseClientSession(raw: unknown): ClientSession | undefined {
  const c = obj(raw);
  const id = text(c?.id);
  if (!c || !id) return undefined;
  const session: ClientSession = { id, provider: str(c.provider) ?? '' };
  for (const key of ['reference', 'currency', 'hosted_url', 'access_code', 'public_key', 'encryption_key', 'customer_email', 'customer_name'] as const) {
    const value = text(c[key]);
    if (value) session[key] = value;
  }
  const amount = num(c.amount);
  if (amount !== undefined) session.amount = amount;
  return keep(c, session, ['reference', 'currency', 'hosted_url', 'access_code', 'public_key', 'encryption_key', 'customer_email', 'customer_name', 'amount']);
}

export function parseProcess(raw: unknown): RawProcessBody {
  const b = obj(raw) ?? {};
  const body: RawProcessBody = {
    code: num(b.code) ?? 0,
    status: str(b.status) ?? '',
    message: str(b.message) ?? '',
  };
  const action = text(b.action);
  if (action) body.action = action;
  if (obj(b.transaction)) body.transaction = parseTransaction(b.transaction);
  for (const key of PROCESS_STRINGS) {
    const value = text(b[key]);
    if (value) body[key] = value;
  }
  const timeout = num(b.three_ds_timeout);
  if (timeout !== undefined) body.three_ds_timeout = timeout;
  const clientSession = parseClientSession(b.client_session);
  if (clientSession) body.client_session = clientSession;
  return keep(b, body, ['action', 'transaction', ...PROCESS_STRINGS, 'three_ds_timeout', 'client_session']);
}

/** POST /pay/{kind}/verify, HTTP 200. Anything but `success` is a failure. */
export function parseStepVerify(raw: unknown): StepVerifyResponse {
  const b = obj(raw) ?? {};
  if (str(b.status)?.toLowerCase() === 'success') {
    return { status: 'success', transaction: obj(b.transaction) ? parseTransaction(b.transaction) : null };
  }
  const error = obj(b.error) ?? {};
  return {
    status: 'failed',
    attempts_remaining: nullable(num(b.attempts_remaining)),
    error: { code: str(error.code) ?? '', message: str(error.message) ?? '' },
  };
}

/** Every API error answer (README §2.7). Not the WajubError shape. */
export interface ApiErrorBody {
  code?: number;
  status?: string;
  message?: string;
  error_code?: string;
  errors: Record<string, string[]>;
  block_reference?: string;
  retry_after?: number;
  payer_message?: string;
  /** /pay/3ds/verify. */
  error?: { code?: string; message?: string; retryable?: boolean };
  attempts_remaining?: number;
}

export function parseApiError(raw: unknown): ApiErrorBody {
  const b = obj(raw) ?? {};
  const errors: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(obj(b.errors) ?? {})) {
    const messages = (Array.isArray(value) ? value : [value]).map((m) => str(m)).filter((m): m is string => m !== undefined);
    if (messages.length > 0) errors[key] = messages;
  }
  const body: ApiErrorBody = { errors };
  const code = num(b.code);
  if (code !== undefined) body.code = code;
  for (const key of ['status', 'message', 'error_code', 'block_reference', 'payer_message'] as const) {
    const value = text(b[key]);
    if (value) body[key] = value;
  }
  const retryAfter = num(b.retry_after);
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  const attempts = num(b.attempts_remaining);
  if (attempts !== undefined) body.attempts_remaining = attempts;
  const error = obj(b.error);
  if (error) {
    body.error = { code: text(error.code), message: str(error.message), retryable: bool(error.retryable) };
  }
  return body;
}

/** POST /pay/cancel 200. */
export function parseCancel(raw: unknown): { redirect_url: string | null } {
  return { redirect_url: nullable(text(obj(raw)?.redirect_url)) };
}

/** POST /pay/broadcasting/auth 200. */
export function parseBroadcastAuth(raw: unknown): { auth: string } {
  return { auth: str(obj(raw)?.auth) ?? '' };
}
