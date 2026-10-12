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
import { sheetStrings } from './i18n';
import { StripeCardSection, stripeInstalled } from './components/StripeCardSection';
import { createSession, WajubSession } from './WajubSession';
import { hostedCardFieldError, isHostedCardField, isRedirectWalletChannel } from './mappers/paymentMapper';
import type {
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  PresentOptions,
  SdkConfig,
  SessionChannel,
  SessionData,
} from './types';

type PaymentTab = 'mobile_money' | 'card' | 'wallet';

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
  const [locale, setLocale] = useState<string | undefined>(undefined);
  const resolverRef = useRef<((result: PaymentResult | { cancelled: true }) => void) | null>(null);
  // Whether the payer submitted anything: closing the sheet before that
  // cancels the payment on Wajub too.
  const submittedRef = useRef(false);

  const present = useCallback(
    (options: PresentOptions): Promise<PaymentResult | { cancelled: true }> => {
      const wajubSession = factory(options.sessionToken);
      setSession(wajubSession);
      setLocale(options.locale);
      submittedRef.current = false;
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
      locale={locale}
      onSubmit={() => {
        submittedRef.current = true;
      }}
      onDismiss={() => {
        void session.cancelIfNothingSubmitted(submittedRef.current);
        finish({ cancelled: true });
      }}
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
  /** The language `present()` asked for; the session's own when absent. */
  locale?: string;
  /** Called as the payer submits a payment. */
  onSubmit: () => void;
  onDismiss: () => void;
  onResult: (result: PaymentResult) => void;
}

function PaymentSheetModal({ visible, session, locale, onSubmit, onDismiss, onResult }: PaymentSheetModalProps) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [sdkConfig, setSdkConfig] = useState<SdkConfig | null>(null);
  const [tab, setTab] = useState<PaymentTab>('mobile_money');
  const [momoChannels, setMomoChannels] = useState<SessionChannel[]>([]);
  const [walletChannels, setWalletChannels] = useState<SessionChannel[]>([]);
  const [selected, setSelected] = useState<SessionChannel | null>(null);
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('CM');
  const [cardholderName, setCardholderName] = useState('');
  const [email, setEmail] = useState('');
  const [billing, setBilling] = useState<Partial<Record<HostedCardField, string>>>({});

  const t = sheetStrings(locale ?? sessionData?.locale);
  const hasCard = sessionData?.channels.some((c) => c.type.toLowerCase() === 'card') ?? false;
  const availableTabs: PaymentTab[] = [
    ...(momoChannels.length > 0 ? (['mobile_money'] as const) : []),
    ...(hasCard ? (['card'] as const) : []),
    ...(walletChannels.length > 0 ? (['wallet'] as const) : []),
  ];
  const cardSlug = session.cardChannelSlug() ?? 'card';
  const cardCfg = sdkConfig?.channels[cardSlug];
  // Stripe cards only when the app installed the optional Stripe module.
  const stripeAvailable = stripeInstalled && cardCfg?.sdk === 'stripe_elements' && !!cardCfg.publishable_key;
  // Paystack / Flutterwave: the PSP's own hosted checkout collects the card
  // and runs PIN/OTP/AVS (see WajubSession.payCardHosted()).
  const clientSessionAvailable = cardCfg?.client_session === true;
  // PayPal / Mollie / Paddle / Kkiapay / FedaPay / PayDunya / CinetPay: the
  // PSP's own page collects the card; some still need contact/billing
  // details the merchant didn't attach (sdk-config `required_fields`).
  const hostedRedirectAvailable = cardCfg?.sdk === 'hosted_redirect';
  const redirectFields = (cardCfg?.required_fields ?? []).filter(isHostedCardField);
  const redirectFieldsValid = redirectFields.every((f) => hostedCardFieldError(f, billing[f]) === null);

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
        const wallets = data.channels.filter((c) => isRedirectWalletChannel(c, cfg.channels[c.slug]));
        setSessionData(data);
        setSdkConfig(cfg);
        setMomoChannels(momo);
        setWalletChannels(wallets);
        setSelected(momo[0] ?? null);
        setCountry(momo[0]?.countries[0] ?? 'CM');
        setTab(momo.length > 0 ? 'mobile_money' : card ? 'card' : wallets.length > 0 ? 'wallet' : 'mobile_money');
      } catch (e) {
        setError(e instanceof Error ? e.message : t.loadFailed);
      } finally {
        setLoading(false);
      }
    })();
  }, [visible, session]);

  const start = () => {
    setSubmitting(true);
    onSubmit();
  };

  const payMomo = async () => {
    if (!selected) return;
    start();
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
      setError(e instanceof Error ? e.message : t.paymentFailed);
      setSubmitting(false);
    }
  };

  const payCard = async (paymentMethodId: string) => {
    start();
    setError(null);
    try {
      const result = await session.payCard(cardSlug, paymentMethodId, cardholderName.trim() || null);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.cardPaymentFailed);
      setSubmitting(false);
    }
  };

  const payWallet = async (channel: SessionChannel) => {
    start();
    setError(null);
    try {
      const result = await session.payWallet(channel.slug);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.paymentFailed);
      setSubmitting(false);
    }
  };

  const payCardHosted = async () => {
    start();
    setError(null);
    try {
      const result = await session.payCardHosted(cardSlug, { email: email.trim() || null });
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.cardPaymentFailed);
      setSubmitting(false);
    }
  };

  const payCardRedirect = async () => {
    start();
    setError(null);
    try {
      const result = await session.payCardHostedRedirect(cardSlug, billing);
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.cardPaymentFailed);
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{t.title}</Text>
            <Pressable onPress={onDismiss} hitSlop={8}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {availableTabs.length > 1 ? (
            <View style={styles.tabs}>
              {availableTabs.map((option) => (
                <Pressable key={option} style={[styles.tab, tab === option && styles.tabActive]} onPress={() => setTab(option)}>
                  <Text style={tab === option ? styles.tabTextActive : styles.tabText}>{t.tabs[option]}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {loading ? (
            <ActivityIndicator style={styles.loader} />
          ) : tab === 'wallet' ? (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.hint}>{t.walletHint}</Text>
              {walletChannels.map((ch) => (
                <Pressable
                  key={ch.slug}
                  style={[styles.button, submitting && styles.buttonDisabled]}
                  onPress={() => payWallet(ch)}
                  disabled={submitting}
                >
                  <Text style={styles.buttonText}>{submitting ? t.processing : t.payWith(ch.name)}</Text>
                </Pressable>
              ))}
            </>
          ) : tab === 'mobile_money' ? (
            momoChannels.length === 0 ? (
              <Text>{t.noMobileMoney}</Text>
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
                  placeholder={t.phoneNumber}
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
                />
                <Pressable
                  style={[styles.button, (submitting || !phone.trim()) && styles.buttonDisabled]}
                  onPress={payMomo}
                  disabled={submitting || !phone.trim()}
                >
                  <Text style={styles.buttonText}>{submitting ? t.processing : t.payNow}</Text>
                </Pressable>
              </>
            )
          ) : !hasCard ? (
            <Text>{t.noCardChannel}</Text>
          ) : stripeAvailable ? (
            <StripeCardSection
              cardholderName={cardholderName}
              onCardholderNameChange={setCardholderName}
              onPay={payCard}
              submitting={submitting}
              error={error}
              locale={locale ?? sessionData?.locale}
            />
          ) : clientSessionAvailable ? (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.hint}>{t.providerPageHint}</Text>
              <TextInput
                style={styles.input}
                placeholder={t.emailForReceipt}
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
                <Text style={styles.buttonText}>{submitting ? t.waitingForPayment : t.payByCard}</Text>
              </Pressable>
            </>
          ) : hostedRedirectAvailable ? (
            <>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Text style={styles.hint}>{t.providerPageHint}</Text>
              {redirectFields.map((field) => (
                <TextInput
                  key={field}
                  style={styles.input}
                  placeholder={t.fields[field]}
                  keyboardType={field === 'email' ? 'email-address' : field === 'phone' ? 'phone-pad' : 'default'}
                  autoCapitalize={field === 'email' ? 'none' : field === 'country' ? 'characters' : 'words'}
                  maxLength={field === 'country' ? 2 : undefined}
                  value={billing[field] ?? ''}
                  onChangeText={(value) => setBilling((b) => ({ ...b, [field]: value }))}
                />
              ))}
              <Pressable
                style={[styles.button, (submitting || !redirectFieldsValid) && styles.buttonDisabled]}
                onPress={payCardRedirect}
                disabled={submitting || !redirectFieldsValid}
              >
                <Text style={styles.buttonText}>{submitting ? t.processing : t.payByCard}</Text>
              </Pressable>
            </>
          ) : (
            <Text>{t.cardUnavailable}</Text>
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
