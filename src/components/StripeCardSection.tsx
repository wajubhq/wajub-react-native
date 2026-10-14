import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { createStripePaymentMethod } from '../adapters/stripeAdapter';
import { sheetStrings } from '../i18n';
import { Banner, Button, Field } from '../ui/components';
import { useSheet } from '../ui/theme';

/**
 * The parts of `@stripe/stripe-react-native` this section uses. The module is
 * an optional peer: required inside try/catch, which Metro treats as an
 * optional dependency, so an app that only takes Mobile Money bundles without
 * it. Importing it at the top of the file made the whole package need it.
 */
interface StripeModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CardField: React.ComponentType<any>;
  initStripe?: (params: { publishableKey: string }) => Promise<void>;
  useStripe: () => {
    createPaymentMethod?: (params: {
      paymentMethodType: 'Card';
      paymentMethodData?: { billingDetails?: { name?: string } };
    }) => Promise<{ paymentMethod?: { id?: string } | null; error?: { message?: string } | null }>;
  };
}

let stripeModule: StripeModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  stripeModule = require('@stripe/stripe-react-native') as StripeModule;
} catch {
  stripeModule = null;
}

/** Whether `@stripe/stripe-react-native` is installed in the app. */
export const stripeInstalled: boolean = stripeModule !== null;

export interface StripeCardSectionProps {
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  onPay: (paymentMethodId: string) => Promise<void>;
  submitting: boolean;
  error: string | null;
  /** `fr` or `en`; English when absent. */
  locale?: string | null;
  /** The Pay button's label; "Pay with card" when absent. */
  payLabel?: string;
  /**
   * The payment's Stripe key (sdk-config `publishable_key`): only the account
   * that issues a `pm_…` can charge it. When given, Stripe is initialised with it.
   */
  publishableKey?: string | null;
}

/**
 * Native Stripe card fields — requires `StripeProvider` at app root. Drawn
 * with the payment sheet's theme inside it, the default light one elsewhere.
 */
export function StripeCardSection({
  cardholderName,
  onCardholderNameChange,
  onPay,
  submitting,
  error,
  locale,
  payLabel,
  publishableKey,
}: StripeCardSectionProps) {
  const t = sheetStrings(locale);
  const { theme } = useSheet();
  if (stripeModule === null) {
    throw new Error('StripeCardSection needs @stripe/stripe-react-native. Install it, or take cards another way.');
  }
  const { CardField } = stripeModule;
  const { createPaymentMethod } = stripeModule.useStripe();
  const [cardComplete, setCardComplete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const initStripe = stripeModule.initStripe;

  useEffect(() => {
    if (publishableKey && initStripe) void initStripe({ publishableKey }).catch(() => undefined);
  }, [publishableKey, initStripe]);

  const pay = async () => {
    if (!createPaymentMethod) {
      setLocalError(t.stripeNotInitialized);
      return;
    }
    setLocalError(null);
    try {
      const paymentMethodId = await createStripePaymentMethod(async () => {
        const { paymentMethod, error: stripeError } = await createPaymentMethod({
          paymentMethodType: 'Card',
          paymentMethodData: {
            billingDetails: cardholderName.trim()
              ? { name: cardholderName.trim() }
              : undefined,
          },
        });
        return {
          paymentMethodId: paymentMethod?.id,
          error: stripeError ? { message: stripeError.message } : null,
        };
      });
      await onPay(paymentMethodId);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : t.cardPaymentFailed);
    }
  };

  const message = error ?? localError;
  return (
    <View style={{ gap: theme.gapRow }}>
      {message ? <Banner message={message} /> : null}
      <Field label={t.cardholderName} value={cardholderName} onChangeText={onCardholderNameChange} autoCapitalize="words" />
      <CardField
        postalCodeEnabled={false}
        style={{ width: '100%', height: 50 }}
        cardStyle={{
          backgroundColor: theme.colors.inputBackground,
          borderColor: theme.colors.inputBorder,
          borderWidth: 1,
          borderRadius: theme.radius,
          textColor: theme.colors.text,
          placeholderColor: theme.colors.textPlaceholder,
        }}
        onCardChange={(details: { complete: boolean }) => setCardComplete(details.complete)}
      />
      <Button title={payLabel ?? t.payWithCard} onPress={pay} disabled={!cardComplete} loading={submitting} testID="wajub-pay" />
    </View>
  );
}
