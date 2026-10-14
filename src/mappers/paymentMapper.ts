import { HOSTED_CARD_FIELDS, UNSUPPORTED_ACTION_CODE } from '../types';
import type {
  ActionKind,
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  SdkChannelConfig,
  SessionChannel,
  SessionTransaction,
} from '../types';
import { toE164 } from '../mobileMoney/data';
import { WajubError } from '../WajubError';
import type { RawProcessBody } from '../wire/parse';

/** 2xx body of /pay/process and the client-session calls. */
export type RawProcessResponse = RawProcessBody;

const SUCCESS_STATUSES = new Set(['success', 'successful', 'succeeded', 'paid', 'complete', 'refunded', 'partially_refunded']);

/** `data` for a Mobile Money charge: the number in E.164, the country, the operator hint when given. */
export function buildMobileMoneyRequest(input: MobileMoneyInput): Record<string, string> {
  const data: Record<string, string> = {
    phone: toE164(input.phone, input.country),
    country: input.country.toUpperCase(),
  };
  if (input.operator) data.operator = input.operator;
  return data;
}

/**
 * A `wallet` channel the SDK can pay with a single tap — nothing to collect,
 * `/pay/process` answers with a redirect to the wallet's own page/app (e.g.
 * Djamo). Apple Pay / Google Pay / PayPal-via-Stripe need their own SDK
 * flavor and are excluded by `sdk: "form"` + no `required_fields`.
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

/** Why a hosted-redirect billing value can't be sent yet, or null when it's fine. */
export function hostedCardFieldError(field: HostedCardField, value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return 'Required';
  if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Invalid email';
  // CinetPay's customer_country is a 2-letter ISO code.
  if (field === 'country' && !/^[A-Za-z]{2}$/.test(v)) return 'Use the 2-letter country code';
  return null;
}

/** `data` for a hosted-redirect card charge — flat keys, exactly as sdk-config names them. */
export function buildHostedCardRequest(billing: Partial<Record<HostedCardField, string>>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const field of HOSTED_CARD_FIELDS) {
    const v = (billing[field] ?? '').trim();
    if (v) data[field] = field === 'country' ? v.toUpperCase() : v;
  }
  return data;
}

const STEP_FIELDS: Record<string, [keyof RawProcessBody, keyof RawProcessBody]> = {
  confirm_otp: ['otp_id', 'otp_masked_contact'],
  confirm_pin: ['pin_id', 'pin_instruction'],
  confirm_phone: ['phone_id', 'phone_instruction'],
  confirm_birthday: ['birthday_id', 'birthday_instruction'],
  confirm_address: ['address_id', 'address_instruction'],
};

function unsupported(action: string, transaction: SessionTransaction): PaymentResult {
  return {
    status: 'failed',
    error: WajubError.create(UNSUPPORTED_ACTION_CODE, { apiMessage: `Unsupported action: ${action}` }),
    transaction,
  };
}

/**
 * One `/pay/process` (or client-session) 2xx, for a host that draws its own
 * UI. The HTTP status, `action` and `transaction.status` decide — never
 * `message`. An action this SDK cannot perform, or one missing what it needs,
 * fails as `unsupported_action` instead of an endless `processing`.
 */
export function mapProcessResponse(body: RawProcessResponse, methodType: string): PaymentResult {
  const txn = body.transaction;
  if (!txn) {
    return {
      status: 'failed',
      error: { type: 'payment_error', code: 'invalid_response', message: 'Missing transaction', retryable: false },
      transaction: null,
    };
  }

  const action = body.action ?? null;
  if (!action && SUCCESS_STATUSES.has(txn.status.toLowerCase())) {
    return { status: 'complete', transaction: txn };
  }

  if (action === 'redirect' || action === 'confirm') {
    const url = body.confirm_url ?? body.simulator_url ?? null;
    return url ? { status: 'requires_action', action, action_url: url, transaction: txn } : unsupported(action, txn);
  }

  if (action === 'confirm_3ds') {
    if (body.confirm_url) {
      return { status: 'requires_action', action, action_url: body.confirm_url, transaction: txn };
    }
    // Sandbox: a code sent by email, verified with WajubSession.verify3ds().
    if (body.three_ds_id) {
      return { status: 'requires_action', action, action_url: null, stepId: body.three_ds_id, hint: body.masked_email ?? null, transaction: txn };
    }
    return unsupported(action, txn);
  }

  if (action === 'client_session') {
    return body.client_session
      ? {
          status: 'requires_action',
          action,
          action_url: body.client_session.hosted_url ?? null,
          client_session: body.client_session,
          transaction: txn,
        }
      : unsupported(action, txn);
  }

  if (action && STEP_FIELDS[action]) {
    const [idKey, hintKey] = STEP_FIELDS[action];
    const stepId = body[idKey] as string | undefined;
    if (!stepId) return unsupported(action, txn);
    return {
      status: 'requires_action',
      action: action as ActionKind,
      action_url: null,
      stepId,
      hint: (body[hintKey] as string | undefined) ?? null,
      transaction: txn,
    };
  }

  if (action) return unsupported(action, txn);

  const context = txn.processing_context;
  if (context?.is_ussd) {
    return { status: 'processing', transaction: txn, instruction: context.payer_instruction ?? null, kind: 'ussd' };
  }
  if (methodType === 'mobile_money' || context?.is_mobile_money) {
    return {
      status: 'requires_action',
      action: 'push_approval',
      action_url: body.confirm_url ?? null,
      hint: context?.payer_instruction ?? null,
      transaction: txn,
    };
  }

  return {
    status: 'processing',
    transaction: txn,
    instruction: context?.payer_instruction ?? null,
    kind: 'pending',
  };
}

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
