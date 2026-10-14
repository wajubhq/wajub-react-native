/**
 * Code written against @wajub/react-native 1.4.1, type-checked by `npm run
 * lint` (tsconfig.json includes this file; the build does not): 1.5 must
 * compile it with zero errors. The exhaustive switches fail to compile if a
 * union 1.4.1 exported gains or loses a member.
 */
import React from 'react';

import {
  createSession,
  handlePaymentAction,
  mapProcessResponse,
  mapStatusToResult,
  PaymentSheet,
  PayClient,
  subscribeStatus,
  usePayment,
  WajubError,
} from '../../index';
import type {
  ActionKind,
  CancelResult,
  ClientSessionOptions,
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  PaymentSheetResult,
  PresentOptions,
  SdkChannelConfig,
  SdkFlavor,
  SessionData,
  WajubErrorShape,
  WajubErrorType,
} from '../../index';

export function useCheckout() {
  const { present, PaymentSheet: sheet } = usePayment();
  async function pay(token: string): Promise<string | null | undefined> {
    const outcome = await present({ sessionToken: token, locale: 'fr' });
    if ('cancelled' in outcome) return 'cancelled';
    if (outcome.status === 'requires_action') return outcome.action_url;
    if (outcome.status === 'processing') return outcome.transaction.id + (outcome.instruction ?? '');
    if (outcome.status === 'complete') return outcome.transaction.reference;
    if (outcome.status === 'failed') return outcome.error.code;
    return null;
  }
  return { pay, sheet };
}

export async function typed(present: ReturnType<typeof usePayment>['present']) {
  const r: PaymentResult | { cancelled: true } = await present({ sessionToken: 't' });
  const options: PresentOptions = { sessionToken: 't', locale: 'en' };
  const legacy: (o: PresentOptions) => Promise<PaymentResult | { cancelled: true }> = present;
  return [r, options, legacy];
}

export function label(a: ActionKind): string {
  switch (a) {
    case 'redirect':
      return 'r';
    case 'confirm':
      return 'c';
    case 'confirm_3ds':
      return '3';
    case 'push_approval':
      return 'p';
    case 'client_session':
      return 'cs';
    default: {
      const never: never = a;
      return never;
    }
  }
}

export function flavor(f: SdkFlavor): string {
  switch (f) {
    case 'form':
    case 'stripe_elements':
    case 'hosted_redirect':
    case 'adyen_custom_card':
    case 'paystack_inline':
    case 'flutterwave_inline':
      return f;
    default: {
      const never: never = f;
      return never;
    }
  }
}

export function resultStatus(r: PaymentResult): string {
  switch (r.status) {
    case 'complete':
      return r.transaction.id;
    case 'processing':
      return `${r.transaction.id}${r.instruction ?? ''}`;
    case 'requires_action':
      return `${r.action}${r.action_url ?? ''}${r.client_session?.id ?? ''}${r.transaction.id}`;
    case 'failed':
      return `${r.error.code}${r.transaction?.id ?? ''}`;
    default: {
      const never: never = r;
      return never;
    }
  }
}

export function errorType(t: WajubErrorType): string {
  switch (t) {
    case 'api_error':
    case 'authentication_error':
    case 'invalid_request_error':
    case 'payment_error':
    case 'rate_limit_error':
      return t;
    default: {
      const never: never = t;
      return never;
    }
  }
}

export function field(f: HostedCardField): string {
  switch (f) {
    case 'first_name':
    case 'last_name':
    case 'email':
    case 'phone':
    case 'address':
    case 'city':
    case 'country':
    case 'state':
    case 'zip_code':
      return f;
    default: {
      const never: never = f;
      return never;
    }
  }
}

export function details(e: WajubErrorShape): Record<string, string> | undefined {
  return e.details;
}
export function details2(e: WajubError): Record<string, string> | undefined {
  return e.details;
}
export function errorFields(e: WajubError): [string | null | undefined, string | null | undefined, string | null | undefined, number | null | undefined] {
  return [e.decline_code, e.param, e.correlation_id, e.retry_after_seconds];
}

export function brandingColors(s: SessionData): (string | null)[] {
  return Object.values(s.branding ?? {});
}

export function config(c: SdkChannelConfig): [SdkFlavor | null, boolean | undefined] {
  return [c.sdk, c.client_session];
}

export const el = (
  <PaymentSheet visible session={createSession('t')} onSubmit={() => {}} onDismiss={() => {}} onResult={(r: PaymentResult) => void r} />
);

export async function low(): Promise<string | null | undefined> {
  const s = createSession('t', new PayClient());
  const input: MobileMoneyInput = { channel_slug: 'cm.mtn', phone: '+237677123456', country: 'CM' };
  const r = await s.payMobileMoney(input);
  const h = await handlePaymentAction(s, r);
  const options: ClientSessionOptions = { email: 'a@b.co', name: null, return_url: null, restart: true };
  await s.payCardHosted('card', options);
  const cancelled: CancelResult = { redirect_url: await s.cancel() };
  const sheetResult: PaymentSheetResult = { result: r, cancelled: false };
  const stop: () => void = s.watchStatus((u: PaymentResult) => void u, 5000);
  stop();
  const unsubscribe: () => void = subscribeStatus(new PayClient(), 't', await s.loadSession(), (u) => void u, 5000);
  unsubscribe();
  void [cancelled, sheetResult, mapProcessResponse, mapStatusToResult, WajubError.fromHttp(402, 'm', 'c', {})];
  if (h.status === 'requires_action') {
    const u: string | null | undefined = h.action_url;
    return u;
  }
  return null;
}
