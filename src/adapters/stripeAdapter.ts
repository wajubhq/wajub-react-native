export interface StripeCardRequest {
  payment_method_id: string;
  card_holder?: string;
}

/** Builds `/pay/process` data for Stripe tokenized cards. */
export function buildStripeCardRequest(
  paymentMethodId: string,
  cardholderName?: string | null,
): Record<string, string> {
  const data: Record<string, string> = { payment_method_id: paymentMethodId };
  if (cardholderName?.trim()) {
    data.card_holder = cardholderName.trim();
  }
  return data;
}

/**
 * Tokenize with `@stripe/stripe-react-native`. Stripe must be initialised with
 * the payment's publishable key (sdk-config's): the sheet and
 * `StripeCardSection` given `publishableKey` do it themselves; code of your own
 * calls `initStripe()` with that key. Returns `pm_*` for [WajubSession.payCard].
 */
export async function createStripePaymentMethod(
  createFn: () => Promise<{ paymentMethodId?: string | null; error?: { message?: string } | null }>,
): Promise<string> {
  const { paymentMethodId, error } = await createFn();
  if (error?.message) {
    throw new Error(error.message);
  }
  if (!paymentMethodId) {
    throw new Error('Missing payment method id');
  }
  return paymentMethodId;
}
