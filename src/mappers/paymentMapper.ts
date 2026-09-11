import { UNSUPPORTED_ACTION_CODE } from '../types';
import type { ClientSession, MobileMoneyInput, PaymentResult, SessionTransaction } from '../types';

export interface RawProcessResponse {
  code: number;
  status: string;
  message: string;
  /** Open-ended on purpose: the API adds actions over time (see mapProcessResponse()). */
  action?: string | null;
  transaction?: SessionTransaction;
  confirm_url?: string;
  simulator_url?: string;
  client_session?: ClientSession;
}

const SUCCESS_STATUSES = new Set(['success', 'successful', 'succeeded', 'paid', 'complete']);

export function buildMobileMoneyRequest(input: MobileMoneyInput): Record<string, string> {
  return {
    phone: input.phone,
    country: input.country.toUpperCase(),
  };
}

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
  // this SDK can't perform — fail loudly rather than fall through to
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
