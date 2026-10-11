import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { createStripePaymentMethod } from '../adapters/stripeAdapter';
import { sheetStrings } from '../i18n';

/**
 * The parts of `@stripe/stripe-react-native` this section uses. The module is
 * an optional peer: required inside try/catch, which Metro treats as an
 * optional dependency, so an app that only takes Mobile Money bundles without
 * it. Importing it at the top of the file made the whole package need it.
 */
interface StripeModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CardField: React.ComponentType<any>;
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
}

/** Native Stripe card fields — requires `StripeProvider` at app root. */
export function StripeCardSection({
  cardholderName,
  onCardholderNameChange,
  onPay,
  submitting,
  error,
  locale,
}: StripeCardSectionProps) {
  const t = sheetStrings(locale);
  if (stripeModule === null) {
    throw new Error('StripeCardSection needs @stripe/stripe-react-native. Install it, or take cards another way.');
  }
  const { CardField } = stripeModule;
  const { createPaymentMethod } = stripeModule.useStripe();
  const [cardComplete, setCardComplete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

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

  return (
    <View>
      {(error ?? localError) ? <Text style={styles.error}>{error ?? localError}</Text> : null}
      <TextInput
        style={styles.input}
        placeholder={t.cardholderName}
        value={cardholderName}
        onChangeText={onCardholderNameChange}
      />
      <CardField
        postalCodeEnabled={false}
        style={styles.cardField}
        onCardChange={(details: { complete: boolean }) => setCardComplete(details.complete)}
      />
      <Pressable
        style={[styles.button, (submitting || !cardComplete) && styles.buttonDisabled]}
        onPress={pay}
        disabled={submitting || !cardComplete}
      >
        {submitting ? (
          <ActivityIndicator style={{}} />
        ) : (
          <Text style={styles.buttonText}>{t.payWithCard}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  cardField: {
    width: '100%',
    height: 50,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
  error: {
    color: '#c62828',
    marginBottom: 12,
  },
});
