export const CardField = 'CardField';
export const StripeProvider = 'StripeProvider';
export const initStripe = jest.fn(async (_params: { publishableKey: string }) => undefined);
export function useStripe() {
  return { createPaymentMethod: undefined };
}
