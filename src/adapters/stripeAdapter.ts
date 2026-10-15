export interface StripeCardRequest {
  payment_method_id: string;
  card_holder?: string;
}

/** `data` for a card Stripe has turned into a PaymentMethod. */
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
 * A PaymentMethod from `@stripe/stripe-react-native`, initialised with the
 * payment method's `publishable_key` (`StripeCardSection` given
 * `publishableKey` does it). Returns the `pm_…` id for `WajubSession.payCard()`.
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
