import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { CardField, useStripe } from '@stripe/stripe-react-native';
import { createStripePaymentMethod } from '../adapters/stripeAdapter';

export interface StripeCardSectionProps {
  cardholderName: string;
  onCardholderNameChange: (value: string) => void;
  onPay: (paymentMethodId: string) => Promise<void>;
  submitting: boolean;
  error: string | null;
}

/** Native Stripe card fields — requires `StripeProvider` at app root. */
export function StripeCardSection({
  cardholderName,
  onCardholderNameChange,
  onPay,
  submitting,
  error,
}: StripeCardSectionProps) {
  const { createPaymentMethod } = useStripe();
  const [cardComplete, setCardComplete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const pay = async () => {
    if (!createPaymentMethod) {
      setLocalError('Stripe is not initialized. Wrap your app with StripeProvider.');
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
      setLocalError(e instanceof Error ? e.message : 'Card payment failed');
    }
  };

  return (
    <View>
      {(error ?? localError) ? <Text style={styles.error}>{error ?? localError}</Text> : null}
      <TextInput
        style={styles.input}
        placeholder="Cardholder name"
        value={cardholderName}
        onChangeText={onCardholderNameChange}
      />
      <CardField
        postalCodeEnabled={false}
        style={styles.cardField}
        onCardChange={(details) => setCardComplete(details.complete)}
      />
      <Pressable
        style={[styles.button, (submitting || !cardComplete) && styles.buttonDisabled]}
        onPress={pay}
        disabled={submitting || !cardComplete}
      >
        {submitting ? (
          <ActivityIndicator style={{}} />
        ) : (
          <Text style={styles.buttonText}>Pay with card</Text>
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
