import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { handlePaymentAction } from './actionHandler';
import { StripeCardSection } from './components/StripeCardSection';
import { createSession, WajubSession } from './WajubSession';
import type { MobileMoneyInput, PaymentResult, PresentOptions, SdkConfig, SessionChannel, SessionData } from './types';

type PaymentTab = 'mobile_money' | 'card';

interface WajubContextValue {
  createSession: (token: string) => WajubSession;
}

const WajubContext = createContext<WajubContextValue | null>(null);

export interface WajubProviderProps {
  children: React.ReactNode;
}

/** Optional root provider — sessions are created per payment via [usePayment]. */
export function WajubProvider({ children }: WajubProviderProps) {
  const value = useMemo<WajubContextValue>(
    () => ({
      createSession: (token: string) => createSession(token),
    }),
    [],
  );
  return <WajubContext.Provider value={value}>{children}</WajubContext.Provider>;
}

function useWajubContext(): WajubContextValue {
  const ctx = useContext(WajubContext);
  return ctx ?? { createSession };
}

export function usePayment() {
  const { createSession: factory } = useWajubContext();
  const [visible, setVisible] = useState(false);
  const [session, setSession] = useState<WajubSession | null>(null);
  const resolverRef = useRef<((result: PaymentResult | { cancelled: true }) => void) | null>(null);

  const present = useCallback(
    (options: PresentOptions): Promise<PaymentResult | { cancelled: true }> => {
      const wajubSession = factory(options.sessionToken);
      setSession(wajubSession);
      setVisible(true);
      return new Promise((resolve) => {
        resolverRef.current = resolve;
      });
    },
    [factory],
  );

  const finish = useCallback((result: PaymentResult | { cancelled: true }) => {
    setVisible(false);
    setSession(null);
    resolverRef.current?.(result);
    resolverRef.current = null;
  }, []);

  const sheet = session ? (
    <PaymentSheetModal
      visible={visible}
      session={session}
      onDismiss={() => finish({ cancelled: true })}
      onResult={async (result) => {
        if ('cancelled' in result) {
          finish(result);
          return;
        }
        const handled = await handlePaymentAction(session, result);
        finish(handled);
      }}
    />
  ) : null;

  return { present, PaymentSheet: sheet };
}

interface PaymentSheetModalProps {
  visible: boolean;
  session: WajubSession;
  onDismiss: () => void;
  onResult: (result: PaymentResult) => void;
}

function PaymentSheetModal({ visible, session, onDismiss, onResult }: PaymentSheetModalProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [sdkConfig, setSdkConfig] = useState<SdkConfig | null>(null);
  const [tab, setTab] = useState<PaymentTab>('mobile_money');
  const [momoChannels, setMomoChannels] = useState<SessionChannel[]>([]);
  const [selected, setSelected] = useState<SessionChannel | null>(null);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('CM');
  const [cardholderName, setCardholderName] = useState('');
  const [email, setEmail] = useState('');

  const hasCard = sessionData?.channels.some((c) => c.type.toLowerCase() === 'card') ?? false;
  const cardSlug = session.cardChannelSlug() ?? 'card';
  const cardCfg = sdkConfig?.channels[cardSlug];
  const stripeAvailable = cardCfg?.sdk === 'stripe_elements' && !!cardCfg.publishable_key;
  // Paystack / Flutterwave: the PSP's own hosted checkout collects the card
  // and runs PIN/OTP/AVS (see WajubSession.payCardHosted()).
  const clientSessionAvailable = cardCfg?.client_session === true;
  // PayPal / Mollie / Paddle: the PSP's own page collects the card.
  const hostedRedirectAvailable = cardCfg?.sdk === 'hosted_redirect';

  React.useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await session.loadSession();
        const cfg = await session.getSdkConfig();
        const momo = data.channels.filter(
          (c) => c.type.toLowerCase() === 'mobile_money' || c.type.toLowerCase() === 'mobile',
        );
        const card = data.channels.some((c) => c.type.toLowerCase() === 'card');
        setSessionData(data);
        setSdkConfig(cfg);
        setMomoChannels(momo);
        setSelected(momo[0] ?? null);
        setCountry(momo[0]?.countries[0] ?? 'CM');
        setTab(momo.length === 0 && card ? 'card' : 'mobile_money');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    })();
  }, [visible, session]);

  const payMomo = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: MobileMoneyInput = {
        channel_slug: selected.slug,
        phone: phone.trim(),
        country,
      };
      const result = await session.payMobileMoney(input);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Payment failed');
      setSubmitting(false);
    }
  };

  const payCard = async (paymentMethodId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await session.payCard(cardSlug, paymentMethodId, cardholderName.trim() || null);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Card payment failed');
      setSubmitting(false);
    }
  };

  const payCardHosted = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await session.payCardHosted(cardSlug, { email: email.trim() || null });
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Card payment failed');
      setSubmitting(false);
    }
  };

  const payCardRedirect = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await session.process(cardSlug, {});
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Card payment failed');
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Pay with Wajub</Text>
            <Pressable onPress={onDismiss} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {momoChannels.length > 0 && hasCard ? (
            <View style={styles.tabs}>
              <Pressable
                style={[styles.tab, tab === 'mobile_money' && styles.tabActive]}
                onPress={() => setTab('mobile_money')}
              >
                <Text style={tab === 'mobile_money' ? styles.tabTextActive : styles.tabText}>Mobile Money</Text>
              </Pressable>
              <Pressable
                style={[styles.tab, tab === 'card' && styles.tabActive]}
                onPress={() => setTab('card')}
              >
                <Text style={tab === 'card' ? styles.tabTextActive : styles.tabText}>Card</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator style={styles.loader} />
          ) : tab === 'mobile_money' ? (
            momoChannels.length === 0 ? (
              <Text>No Mobile Money channels available.</Text>
            ) : (
              <>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
                  {momoChannels.map((ch) => (
                    <Pressable
                      key={ch.slug}
                      onPress={() => {
                        setSelected(ch);
                        setCountry(ch.countries[0] ?? country);
                      }}
                      style={[styles.chip, selected?.slug === ch.slug && styles.chipSelected]}
                    >
                      <Text style={selected?.slug === ch.slug ? styles.chipTextSelected : styles.chipText}>
                        {ch.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <TextInput
                  style={styles.input}
                  placeholder="Phone number"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
                />
                <Pressable
                  style={[styles.button, (submitting || !phone.trim()) && styles.buttonDisabled]}
                  onPress={payMomo}
                  disabled={submitting || !phone.trim()}
                >
                  <Text style={styles.buttonText}>{submitting ? 'Processing…' : 'Pay now'}</Text>
                </Pressable>
              </>
            )
          ) : !hasCard ? (
            <Text>No card channel available.</Text>
          ) : stripeAvailable ? (
            <StripeCardSection
              cardholderName={cardholderName}
              onCardholderNameChange={setCardholderName}
              onPay={payCard}
              submitting={submitting}
              error={error}
            />
          ) : clientSessionAvailable ? (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.hint}>You will complete the payment on the provider's secure page.</Text>
              <TextInput
                style={styles.input}
                placeholder="Email (for your receipt)"
                keyboardType="email-address"
                autoCapitalize="none"
                value={email}
                onChangeText={setEmail}
              />
              <Pressable
                style={[styles.button, submitting && styles.buttonDisabled]}
                onPress={payCardHosted}
                disabled={submitting}
              >
                <Text style={styles.buttonText}>{submitting ? 'Waiting for payment…' : 'Pay by card'}</Text>
              </Pressable>
            </>
          ) : hostedRedirectAvailable ? (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.hint}>You will complete the payment on the provider's secure page.</Text>
              <Pressable
                style={[styles.button, submitting && styles.buttonDisabled]}
                onPress={payCardRedirect}
                disabled={submitting}
              >
                <Text style={styles.buttonText}>{submitting ? 'Processing…' : 'Pay by card'}</Text>
              </Pressable>
            </>
          ) : (
            <Text>Card payments unavailable for this session.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    minHeight: 320,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    flex: 1,
    fontSize: 20,
    fontWeight: '600',
  },
  close: {
    fontSize: 20,
    color: '#666',
  },
  tabs: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ccc',
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  tabText: {
    color: '#333',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  loader: {
    marginVertical: 24,
  },
  error: {
    color: '#c62828',
    marginBottom: 12,
  },
  hint: {
    color: '#555',
    marginBottom: 12,
  },
  chips: {
    marginBottom: 12,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#ccc',
    marginRight: 8,
  },
  chipSelected: {
    backgroundColor: '#111',
    borderColor: '#111',
  },
  chipText: {
    color: '#333',
  },
  chipTextSelected: {
    color: '#fff',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
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
});

export { PaymentSheetModal as PaymentSheet };
