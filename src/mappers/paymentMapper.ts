import type { MobileMoneyInput, PaymentResult, SessionTransaction } from '../types';

export interface RawProcessResponse {
  code: number;
  status: string;
  message: string;
  action?: 'confirm_3ds' | 'confirm' | 'redirect' | null;
  transaction?: SessionTransaction;
  confirm_url?: string;
  simulator_url?: string;
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
