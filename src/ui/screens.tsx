import React, { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import type { CheckoutController, CheckoutSnapshot, StepScreen, ThreeDsScreen } from '../checkout/controller';
import type { MethodEntry } from '../checkout/methods';
import { SANDBOX_CARD_FIELDS } from '../checkout/methods';
import { StripeCardSection } from '../components/StripeCardSection';
import { formatAmount } from '../i18n';
import type { PaymentSuccess } from '../types';
import type { WajubError } from '../WajubError';
import { Banner, Button, Field, OperatorLogo, StatusMark, Txt, useNow, weight } from './components';
import { useSheet } from './theme';

type Props = { controller: CheckoutController; snapshot: CheckoutSnapshot };

function amountOf(snapshot: CheckoutSnapshot, lang: 'en' | 'fr'): string {
  const t = snapshot.session?.transaction;
  return t ? formatAmount(t.amount_total ?? t.amount, t.currency, lang) : '';
}

/** Several methods, none chosen (INITIATED). Out-of-limit ones are shown disabled with their limit. */
export function MethodList({ controller, snapshot }: Props) {
  const { theme, t, lang } = useSheet();
  const { colors } = theme;
  const currency = snapshot.session?.transaction.currency ?? '';
  return (
    <View style={{ gap: theme.spacingUnit * 3 }}>
      <Txt variant="label">{t.selectMethod}</Txt>
      <View style={{ borderRadius: theme.radius, borderWidth: 1, borderColor: colors.inputBorder, overflow: 'hidden' }}>
        {snapshot.methods.map((method, index) => {
          const limit = method.limit;
          const label = method.kind === 'mobile_money' ? t.tabs.mobile_money : method.label;
          return (
            <Pressable
              key={method.id}
              testID={`wajub-method-${method.id}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!limit }}
              disabled={!!limit}
              onPress={() => controller.chooseMethod(method.id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacingUnit * 3,
                minHeight: 60,
                paddingHorizontal: theme.spacingUnit * 3.5,
                borderTopWidth: index > 0 ? 1 : 0,
                borderTopColor: colors.inputBorder,
                backgroundColor: colors.background,
                opacity: limit ? 0.5 : 1,
              }}
            >
              <OperatorLogo operator={method.kind === 'wallet' ? method.slug.split('.').pop() ?? method.id : method.kind} name={label} logo={method.logo} size={32} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontFamily: theme.fontFamily, fontSize: theme.fontSizeBase, fontWeight: weight(theme.fontWeightMedium) }}>
                  {label}
                </Text>
                {limit ? (
                  <Txt variant="hint">
                    {limit.min !== undefined ? t.minimum(formatAmount(limit.min, currency, lang)) : t.maximum(formatAmount(limit.max ?? 0, currency, lang))}
                  </Txt>
                ) : null}
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 20 }}>›</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const FIELD_KEYBOARDS: Record<string, 'email-address' | 'phone-pad' | 'number-pad' | 'default'> = {
  email: 'email-address',
  phone: 'phone-pad',
  'card.number': 'number-pad',
  expiry_month: 'number-pad',
  expiry_year: 'number-pad',
  cvv: 'number-pad',
};

/** Card: Stripe's field, the fields a hosted page or client session needs, or the sandbox test form. */
export function CardForm({ controller, snapshot, method }: Props & { method: Extract<MethodEntry, { kind: 'card' }> }) {
  const { theme, t, lang } = useSheet();
  const customer = snapshot.session?.transaction.customer;
  const [values, setValues] = useState<Record<string, string>>(() => ({
    email: customer?.email ?? '',
    first_name: customer?.name?.split(' ')[0] ?? '',
    last_name: customer?.name?.split(' ').slice(1).join(' ') ?? '',
    card_holder: customer?.name ?? '',
  }));
  const [cardholder, setCardholder] = useState(customer?.name ?? '');
  const payLabel = t.payAmount(amountOf(snapshot, lang));

  if (method.flavor === 'stripe') {
    return (
      <StripeCardSection
        cardholderName={cardholder}
        onCardholderNameChange={setCardholder}
        onPay={(id) => controller.payStripe(id, cardholder)}
        submitting={snapshot.busy}
        error={snapshot.banner?.message ?? null}
        locale={lang}
        payLabel={payLabel}
        publishableKey={method.publishableKey}
      />
    );
  }

  const sandbox = method.flavor === 'sandbox_form';
  const fields: readonly string[] = sandbox ? SANDBOX_CARD_FIELDS : method.fields;
  const labels: Record<string, string> = {
    ...t.fields,
    'card.number': t.cardNumber,
    card_holder: t.cardholderName,
    expiry_month: t.expiryMonth,
    expiry_year: t.expiryYear,
    cvv: t.cvv,
  };
  return (
    <View style={{ gap: theme.gapRow }}>
      {snapshot.banner ? <Banner message={snapshot.banner.message} testID="wajub-banner" /> : null}
      <Banner tone={sandbox ? 'warning' : 'info'} message={sandbox ? t.testCardHint : t.providerPageHint} />
      {fields.map((field) => (
        <Field
          key={field}
          testID={`wajub-field-${field}`}
          label={labels[field] ?? field}
          value={values[field] ?? ''}
          onChangeText={(value) => setValues((v) => ({ ...v, [field]: value }))}
          keyboardType={FIELD_KEYBOARDS[field] ?? 'default'}
          secureTextEntry={field === 'cvv'}
          autoCapitalize={field === 'country' ? 'characters' : field === 'email' || FIELD_KEYBOARDS[field] ? 'none' : 'words'}
          maxLength={field === 'country' ? 2 : field === 'expiry_month' || field === 'expiry_year' ? 2 : field === 'cvv' ? 4 : undefined}
          error={snapshot.fieldErrors[field]}
        />
      ))}
      <Button testID="wajub-pay" title={payLabel} onPress={() => void controller.payCard(values)} loading={snapshot.busy} />
    </View>
  );
}

/** A one-tap wallet: its page opens the wallet's app. */
export function WalletForm({ controller, snapshot, method }: Props & { method: Extract<MethodEntry, { kind: 'wallet' }> }) {
  const { theme, t } = useSheet();
  return (
    <View style={{ gap: theme.gapRow }}>
      {snapshot.banner ? <Banner message={snapshot.banner.message} testID="wajub-banner" /> : null}
      <Banner tone="info" message={t.walletHint} />
      <Button testID="wajub-pay" title={t.payWith(method.label)} onPress={() => void controller.payWallet(method.slug)} loading={snapshot.busy} />
    </View>
  );
}

/** A push sent to the phone (APPROVAL_REQUIRED), or a code to dial (USSD_REQUIRED). */
export function WaitingOnPhone({ snapshot, phone, instruction, ussd }: Props & { phone: string | null; instruction: string | null; ussd: boolean }) {
  const { theme, t, lang } = useSheet();
  const { colors } = theme;
  // The API's instruction is English: a French sheet keeps it under a label.
  const main = ussd ? t.ussdBody : lang === 'en' && instruction ? instruction : t.noCodeToEnter;
  return (
    <View style={{ gap: theme.gapRow, alignItems: 'stretch' }} testID={ussd ? 'wajub-ussd' : 'wajub-approval'}>
      <StatusMark tone="neutral" glyph="📱" />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {ussd ? t.ussdTitle : t.approveTitle}
      </Txt>
      <Txt variant="amount" style={{ textAlign: 'center' }}>
        {amountOf(snapshot, lang)}
      </Txt>
      {phone ? <Txt style={{ textAlign: 'center' }}>{t.approveBody(phone)}</Txt> : null}
      <Txt style={{ textAlign: 'center', color: colors.textSecondary }}>{main}</Txt>
      {instruction && (ussd || lang === 'fr') ? (
        <View style={{ backgroundColor: colors.surfaceMuted, borderRadius: theme.radius, padding: theme.spacingUnit * 3, gap: theme.spacingUnit }}>
          <Txt variant="label">{t.instructions}</Txt>
          <Txt testID="wajub-payer-instruction">{instruction}</Txt>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.spacingUnit * 2, alignItems: 'center' }}>
        <ActivityIndicator color={colors.primary} />
        <Txt variant="hint">{t.waitingForConfirmation}</Txt>
      </View>
    </View>
  );
}

function ResendButton({ at, busy, onPress }: { at: number; busy: boolean; onPress: () => void }) {
  const { t } = useSheet();
  const now = useNow(at > Date.now());
  const seconds = Math.ceil((at - now) / 1000);
  return (
    <Button
      variant="link"
      testID="wajub-resend"
      title={seconds > 0 ? t.resendIn(seconds) : t.resendCode}
      disabled={seconds > 0 || busy}
      onPress={onPress}
    />
  );
}

/** OTP, card PIN, phone, date of birth, billing address (README §10). */
export function StepView({ controller, snapshot, step }: Props & { step: StepScreen }) {
  const { theme, t } = useSheet();
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (key: string) => (value: string) => setValues((v) => ({ ...v, [key]: value }));
  const field = (key: string, label: string, extra: Partial<React.ComponentProps<typeof Field>> = {}) => (
    <Field key={key} testID={`wajub-step-${key}`} label={label} value={values[key] ?? ''} onChangeText={set(key)} error={snapshot.fieldErrors[key]} {...extra} />
  );
  const submit = () => {
    if (step.kind !== 'birthday') return void controller.submitStep(values);
    const pad = (v: string | undefined) => (v ?? '').trim().padStart(2, '0');
    const year = (values.year ?? '').trim();
    void controller.submitStep({ birthday: year ? `${year}-${pad(values.month)}-${pad(values.day)}` : '' });
  };
  const secondary = step.kind === 'otp' && step.hint ? t.codeSentTo(step.hint) : step.hint;
  return (
    <View style={{ gap: theme.gapRow }} testID={`wajub-step-screen-${step.kind}`}>
      <Txt variant="title">{t.steps[step.kind]}</Txt>
      {secondary ? <Txt variant="hint">{secondary}</Txt> : null}
      {step.error ? <Banner message={step.error} testID="wajub-step-error" /> : null}
      {step.kind === 'otp' ? field('code', t.code, { keyboardType: 'number-pad', maxLength: 10 }) : null}
      {step.kind === 'pin' ? field('pin', t.pin, { keyboardType: 'number-pad', maxLength: 6, secureTextEntry: true }) : null}
      {step.kind === 'phone' ? field('phone', t.phoneNumber, { keyboardType: 'phone-pad', maxLength: 32 }) : null}
      {step.kind === 'birthday' ? (
        <View style={{ gap: theme.gapRow }}>
          <View style={{ flexDirection: 'row', gap: theme.gapColumn }}>
            <View style={{ flex: 1 }}>{field('day', t.day, { keyboardType: 'number-pad', maxLength: 2, placeholder: 'DD' })}</View>
            <View style={{ flex: 1 }}>{field('month', t.month, { keyboardType: 'number-pad', maxLength: 2, placeholder: 'MM' })}</View>
            <View style={{ flex: 1.5 }}>{field('year', t.year, { keyboardType: 'number-pad', maxLength: 4, placeholder: 'YYYY' })}</View>
          </View>
          {snapshot.fieldErrors.birthday ? <Txt variant="hint" style={{ color: theme.colors.danger }}>{snapshot.fieldErrors.birthday}</Txt> : null}
        </View>
      ) : null}
      {step.kind === 'address'
        ? (['address', 'city', 'state', 'zip_code'] as const).map((key) => field(key, t.fields[key], { autoCapitalize: 'words' }))
        : null}
      <Button testID="wajub-verify" title={snapshot.busy ? t.verifying : t.verify} onPress={submit} loading={snapshot.busy} />
      <ResendButton at={step.resendAt} busy={snapshot.busy} onPress={() => void controller.resendStep()} />
    </View>
  );
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The sandbox 3-D Secure code sent by email. */
export function ThreeDsView({ controller, snapshot, threeDs }: Props & { threeDs: ThreeDsScreen }) {
  const { theme, t } = useSheet();
  const [code, setCode] = useState('');
  const now = useNow(threeDs.expiresAt !== null && !threeDs.accepted);
  if (threeDs.accepted) return <Waiting title={t.threeDsTitle} body={t.verifying} />;
  return (
    <View style={{ gap: theme.gapRow }} testID="wajub-3ds">
      <Txt variant="title">{t.threeDsTitle}</Txt>
      {threeDs.maskedEmail ? <Txt variant="hint">{t.threeDsSentTo(threeDs.maskedEmail)}</Txt> : null}
      {threeDs.expiresAt ? <Txt variant="hint">{t.expiresIn(clock(threeDs.expiresAt - now))}</Txt> : null}
      {threeDs.error ? <Banner message={threeDs.error} testID="wajub-step-error" /> : null}
      <Field testID="wajub-step-code" label={t.code} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} error={snapshot.fieldErrors.code} />
      <Button testID="wajub-verify" title={snapshot.busy ? t.verifying : t.verify} onPress={() => void controller.submit3ds(code)} loading={snapshot.busy} />
      <ResendButton at={threeDs.resendAt} busy={snapshot.busy} onPress={() => void controller.resendStep()} />
    </View>
  );
}

function Waiting({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  const { theme } = useSheet();
  return (
    <View style={{ gap: theme.gapRow, alignItems: 'center' }} testID="wajub-pending">
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt style={{ textAlign: 'center', color: theme.colors.textSecondary }}>{body}</Txt>
      {children}
    </View>
  );
}

/** PENDING: a provider's page is open, or the payment is being confirmed. */
export function PendingView({ controller, snapshot, url, capped }: Props & { url: string | null; capped: boolean }) {
  const { t } = useSheet();
  const browser3ds = snapshot.state === '3DS_REQUIRED';
  return (
    <Waiting title={browser3ds ? t.threeDsTitle : t.pendingTitle} body={capped ? t.willBeNotified : browser3ds ? t.threeDsBrowser : t.pendingBody}>
      {url ? <Button variant="secondary" testID="wajub-continue" title={t.continuePayment} onPress={() => void controller.continuePayment()} /> : null}
    </Waiting>
  );
}

export function SuccessView({ controller, snapshot, payment }: Props & { payment: PaymentSuccess }) {
  const { theme, t, lang } = useSheet();
  const merchant = snapshot.session?.branding?.business_name;
  return (
    <View style={{ gap: theme.gapRow }} testID="wajub-success">
      <StatusMark tone="success" glyph="✓" />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {t.successTitle}
      </Txt>
      <Txt variant="amount" style={{ textAlign: 'center' }}>
        {formatAmount(payment.amount, payment.currency, lang)}
      </Txt>
      <Txt style={{ textAlign: 'center', color: theme.colors.textSecondary }}>
        {typeof merchant === 'string' && merchant ? `${t.successBody} · ${merchant}` : t.successBody}
      </Txt>
      {payment.reference ? (
        <Txt variant="hint" style={{ textAlign: 'center' }}>
          {t.reference}: {payment.reference}
        </Txt>
      ) : null}
      {payment.receipt_url ? (
        <Button variant="link" testID="wajub-receipt" title={t.viewReceipt} onPress={() => void Linking.openURL(payment.receipt_url!)} />
      ) : null}
      <Button testID="wajub-close" title={t.close} onPress={controller.dismiss} />
    </View>
  );
}

/** FAILED: "Try again" when the error allows it (after the countdown of a rate limit). */
export function FailedView({ controller, error }: Props & { error: WajubError }) {
  const { theme, t } = useSheet();
  const [until] = useState(() => Date.now() + (error.retry_after_seconds ?? 0) * 1000);
  const now = useNow(error.code === 'rate_limited' && until > Date.now());
  const wait = error.code === 'rate_limited' ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  return (
    <View style={{ gap: theme.gapRow }} testID="wajub-failed">
      <StatusMark tone="danger" glyph="!" />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {error.code === 'rate_limited' ? t.rateLimitedTitle : t.failureTitle}
      </Txt>
      <Txt style={{ textAlign: 'center', color: theme.colors.textSecondary }} testID="wajub-error-message">
        {error.message}
      </Txt>
      {error.retryable ? (
        <Button testID="wajub-try-again" title={wait > 0 ? t.tryAgainIn(wait) : t.tryAgain} disabled={wait > 0} onPress={() => controller.tryAgain()} />
      ) : null}
      <Button variant={error.retryable ? 'secondary' : 'primary'} testID="wajub-close" title={t.close} onPress={controller.dismiss} />
    </View>
  );
}

/** EXPIRED, CANCELLED, or a payment that had ended before the sheet opened. */
export function NoticeView({ controller, title, error }: Props & { title: string; error: WajubError }) {
  const { theme, t } = useSheet();
  return (
    <View style={{ gap: theme.gapRow }} testID="wajub-notice">
      <StatusMark tone="neutral" glyph="⏱" />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      <Txt style={{ textAlign: 'center', color: theme.colors.textSecondary }} testID="wajub-error-message">
        {error.message}
      </Txt>
      <Button testID="wajub-close" title={t.close} onPress={controller.dismiss} />
    </View>
  );
}

/** A load that failed or timed out: Retry when it may work, Close always. */
export function LoadErrorView({ controller, error }: Props & { error: WajubError }) {
  const { theme, t } = useSheet();
  return (
    <View style={{ gap: theme.gapRow }} testID="wajub-load-error">
      <StatusMark tone="danger" glyph="!" />
      <Txt variant="title" style={{ textAlign: 'center' }}>
        {error.code === 'session_not_found' ? t.sessionNotFoundTitle : error.retryable ? t.loadErrorTitle : t.endedTitle}
      </Txt>
      <Txt style={{ textAlign: 'center', color: theme.colors.textSecondary }} testID="wajub-error-message">
        {error.message}
      </Txt>
      {error.retryable ? <Button testID="wajub-retry" title={t.retry} onPress={() => controller.retryLoad()} /> : null}
      <Button variant={error.retryable ? 'secondary' : 'primary'} testID="wajub-close" title={t.close} onPress={controller.dismiss} />
    </View>
  );
}
