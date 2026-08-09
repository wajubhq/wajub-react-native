/** Minimal stubs for `tsc --noEmit` when Stripe native module is not linked. */
declare module '@stripe/stripe-react-native' {
  import type { ComponentType } from 'react';

  export const CardField: ComponentType<{
    postalCodeEnabled?: boolean;
    style?: object;
    onCardChange?: (details: { complete: boolean }) => void;
  }>;

  export function useStripe(): {
    createPaymentMethod?: (params: {
      paymentMethodType: string;
      paymentMethodData?: { billingDetails?: { name?: string } };
    }) => Promise<{
      paymentMethod?: { id?: string };
      error?: { message?: string };
    }>;
  };

  export const StripeProvider: ComponentType<{
    publishableKey: string;
    children?: React.ReactNode;
  }>;
}
