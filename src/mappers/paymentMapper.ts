import { HOSTED_CARD_FIELDS, UNSUPPORTED_ACTION_CODE } from '../types';
import type {
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  ProcessOutcome,
  SdkChannelConfig,
  SessionChannel,
  SessionTransaction,
} from '../types';
import { WajubError } from '../WajubError';
import type { Lang } from '../errorCatalogue';
import type { RawProcessBody } from '../wire/parse';

/** A payment attempt's answer, before it is read. */
export type RawProcessResponse = RawProcessBody;

const SUCCESS_STATUSES = new Set(['success', 'successful', 'succeeded', 'paid', 'complete']);

/** `data` for a Mobile Money charge, as 1.4 sent it. The payment sheet sends the number in E.164. */
export function buildMobileMoneyRequest(input: MobileMoneyInput): Record<string, string> {
  return {
    phone: input.phone,
    country: input.country.toUpperCase(),
  };
}

/**
 * A `wallet` method the SDK can pay with a single tap: nothing to collect,
 * the payment opens the wallet's own page or app.
 */
export function isRedirectWalletChannel(channel: SessionChannel, config: SdkChannelConfig | undefined): boolean {
  return (
    channel.type.toLowerCase() === 'wallet' &&
    config?.available === true &&
    config.sdk === 'form' &&
    (config.required_fields ?? []).length === 0
  );
}

export function isHostedCardField(field: string): field is HostedCardField {
  return (HOSTED_CARD_FIELDS as readonly string[]).includes(field);
}

/** Why a billing value a card payment asks for can't be sent yet, or null when it's fine. */
export function hostedCardFieldError(field: HostedCardField, value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return 'Required';
  if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Invalid email';
  // CinetPay's customer_country is a 2-letter ISO code.
  if (field === 'country' && !/^[A-Za-z]{2}$/.test(v)) return 'Use the 2-letter country code';
  return null;
}

/** `data` for a card paid on the provider's page, from the billing fields it asks for. */
export function buildHostedCardRequest(billing: Partial<Record<HostedCardField, string>>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const field of HOSTED_CARD_FIELDS) {
    const v = (billing[field] ?? '').trim();
    if (v) data[field] = field === 'country' ? v.toUpperCase() : v;
  }
  return data;
}

/**
 * A payment attempt's answer, read the 1.4 way, as the 1.4 `WajubSession`
 * methods return it. A confirmation step (`confirm_otp`…) fails as
 * `unsupported_action` here; `mapProcessOutcome()` returns it.
 */
export function mapProcessResponse(body: RawProcessResponse, methodType: string): PaymentResult {
  const txn = body.transaction;
  if (!txn) {
    return {
      status: 'failed',
      error: {
        type: 'payment_error',
        code: 'invalid_response',
        message: 'Missing transaction',
        retryable: false,
      },
      transaction: null,
    };
  }

  if (!body.action && SUCCESS_STATUSES.has(txn.status.toLowerCase())) {
    return { status: 'complete', transaction: txn };
  }

  if (body.action === 'redirect') {
    return {
      status: 'requires_action',
      action: 'redirect',
      action_url: body.confirm_url ?? body.simulator_url ?? null,
      transaction: txn,
    };
  }

  if (body.action === 'confirm' || body.action === 'confirm_3ds') {
    return {
      status: 'requires_action',
      action: body.action === 'confirm_3ds' ? 'confirm_3ds' : 'confirm',
      action_url: body.confirm_url ?? body.simulator_url ?? null,
      transaction: txn,
    };
  }

  if (body.action === 'client_session' && body.client_session) {
    return {
      status: 'requires_action',
      action: 'client_session',
      action_url: body.client_session.hosted_url ?? null,
      client_session: body.client_session,
      transaction: txn,
    };
  }

  // Any other action (confirm_otp, confirm_pin, card_reauth, …) needs a step
  // this reading can't perform — fail loudly rather than fall through to
  // `processing`, which would leave the payer on an endless spinner.
  if (body.action) {
    return {
      status: 'failed',
      error: {
        type: 'payment_error',
        code: UNSUPPORTED_ACTION_CODE,
        message: `This payment requires a step the Wajub SDK cannot perform (${body.action}). Try another payment method.`,
        retryable: false,
      },
      transaction: txn,
    };
  }

  if (methodType === 'mobile_money') {
    return {
      status: 'requires_action',
      action: 'push_approval',
      action_url: body.confirm_url ?? null,
      transaction: txn,
    };
  }

  return {
    status: 'processing',
    transaction: txn,
    instruction: txn.processing_context?.payer_instruction ?? null,
  };
}

const V2_SUCCESS = ['succeeded', 'refunded', 'partially_refunded'];

const STEP_FIELDS: Record<string, [keyof RawProcessBody, keyof RawProcessBody]> = {
  confirm_otp: ['otp_id', 'otp_masked_contact'],
  confirm_pin: ['pin_id', 'pin_instruction'],
  confirm_phone: ['phone_id', 'phone_instruction'],
  confirm_birthday: ['birthday_id', 'birthday_instruction'],
  confirm_address: ['address_id', 'address_instruction'],
};

/**
 * A payment attempt's answer, as `WajubSession.submit()` reads it. A
 * confirmation step comes with its `stepId` and `hint`; a step the SDK cannot
 * perform is `failed` / `unsupported_action` (the payment may still be
 * processing).
 */
export function mapProcessOutcome(body: RawProcessResponse, methodType: string, lang: Lang = 'en'): ProcessOutcome {
  const transaction = body.transaction ?? null;
  const context = transaction?.processing_context;
  const action = body.action ?? null;
  const requires = (url: string | null, stepId: string | null = null, hint: string | null = null): ProcessOutcome => ({
    status: 'requires_action',
    action: action ?? '',
    url,
    stepId,
    hint,
    clientSession: body.client_session ?? null,
    transaction,
  });

  if (!action) {
    if (transaction && V2_SUCCESS.includes(transaction.status)) return { status: 'complete', transaction };
    const instruction = context?.payer_instruction ?? null;
    if (context?.is_ussd) return { status: 'processing', transaction, instruction, kind: 'ussd' };
    if (methodType === 'mobile_money' || context?.is_mobile_money) return { status: 'processing', transaction, instruction, kind: 'approval' };
    return { status: 'processing', transaction, instruction, kind: 'pending' };
  }
  if ((action === 'redirect' || action === 'confirm' || action === 'confirm_3ds') && body.confirm_url) return requires(body.confirm_url);
  if (action === 'confirm_3ds' && body.three_ds_id) return requires(null, body.three_ds_id, body.masked_email ?? null);
  if (action === 'client_session' && body.client_session?.hosted_url) return requires(body.client_session.hosted_url);
  // The payer's own code, to send again with `data.otp`: nothing was charged.
  if (action === 'payer_otp' && body.payer_otp) return { ...(requires(null) as Extract<ProcessOutcome, { status: 'requires_action' }>), payerOtp: body.payer_otp };
  const step = STEP_FIELDS[action];
  if (step && body[step[0]]) return requires(null, body[step[0]] as string, (body[step[1]] as string | undefined) ?? null);
  return {
    status: 'failed',
    error: WajubError.create(UNSUPPORTED_ACTION_CODE, { lang, apiMessage: `Unsupported action: ${action}` }),
    transaction,
  };
}

/** A payment status as a `PaymentResult`, the 1.4 way. */
export function mapStatusToResult(status: string, transaction: SessionTransaction): PaymentResult {
  const normalized = status.toLowerCase();
  if (SUCCESS_STATUSES.has(normalized)) {
    return { status: 'complete', transaction };
  }
  if (['failed', 'cancelled', 'expired'].includes(normalized)) {
    return {
      status: 'failed',
      error: {
        type: 'payment_error',
        code: normalized,
        message: status,
        retryable: false,
      },
      transaction,
    };
  }
  return { status: 'processing', transaction };
}
