import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { CheckoutController, CheckoutSnapshot } from '../checkout/controller';
import { catalogueMessage } from '../errorCatalogue';
import type { MethodEntry } from '../checkout/methods';
import { formatAmount } from '../i18n';
import {
  countryRules,
  detectOperator,
  formatAsYouType,
  isOperatorIndependent,
  mobileMoneyData,
  sanitize,
} from '../mobileMoney/data';
import { defaultCountry, mobileMoneyCountries, operatorChoices, preselect } from '../mobileMoney/form';
import type { OperatorChoice } from '../mobileMoney/form';
import { Banner, Button, Field, OperatorLogo, Txt, weight } from './components';
import { useSheet } from './theme';

/**
 * Country, operator list (logos, or brand badges), the number with its dial
 * code — formatted as typed, with the operator detected from it while the
 * payer has not picked one by hand.
 */
export function MobileMoneyForm({
  controller,
  snapshot,
  method,
}: {
  controller: CheckoutController;
  snapshot: CheckoutSnapshot;
  method: Extract<MethodEntry, { kind: 'mobile_money' }>;
}) {
  const { theme, t, lang } = useSheet();
  const { colors } = theme;
  const options = controller.options.mobileMoney ?? {};
  const session = snapshot.session!;
  const countries = useMemo(() => mobileMoneyCountries(method.channels), [method.channels]);
  const [country, setCountry] = useState(() => defaultCountry(method.channels, options.country, session.geo_country));
  const choices = useMemo(() => operatorChoices(method.channels, country, lang), [method.channels, country, lang]);
  const [selected, setSelected] = useState<string | null>(choices[0]?.id ?? null);
  const [pickedByHand, setPickedByHand] = useState(false);
  const [phone, setPhone] = useState('');
  const [listOpened, setListOpened] = useState(false);

  // A new country: the first operator again, not marked as picked.
  useEffect(() => {
    setSelected((current) => (choices.some((c) => c.id === current) ? current : (choices[0]?.id ?? null)));
    setPickedByHand(false);
  }, [choices]);

  const rules = countryRules(country);
  const sandbox = session.transaction.sandbox === true;
  const detected = detectOperator(phone, country, sandbox);
  const detectedChoice = choices.find((c) => c.id === detected);
  const selectedChoice = choices.find((c) => c.id === selected) ?? null;

  // `operatorMode: "detect"`: no list until the number does not tell, or a
  // wallet held whatever the operator is on offer while it does.
  const detectMode = options.operatorMode === 'detect';
  const numberUndetected = choices.length > 1 && sanitize(phone).length >= 6 && !detectedChoice;
  const walletOffered = choices.some((c) => isOperatorIndependent(c.id));
  const showList =
    choices.length > 0 && (!detectMode || pickedByHand || listOpened || numberUndetected || (!!detectedChoice && walletOffered));
  const badge: OperatorChoice | undefined =
    detectMode && !showList ? (choices.length === 1 ? choices[0] : detectedChoice) : undefined;
  const showCountries = countries.length > 1 && !(options.countryLocked && options.country && countries.includes(options.country.toUpperCase()));

  const pick = (id: string) => {
    setSelected(id);
    setPickedByHand(true);
  };
  const onPhone = (value: string) => {
    const formatted = formatAsYouType(value);
    setPhone(formatted);
    setSelected((current) => preselect(current, pickedByHand, formatted, country, choices, sandbox));
  };
  const total = session.transaction.amount_total ?? session.transaction.amount;

  return (
    <View style={{ gap: theme.gapRow }}>
      {snapshot.banner ? <Banner message={snapshot.banner.message} testID="wajub-banner" /> : null}

      {showCountries ? (
        <View style={{ gap: theme.spacingUnit * 1.5 }}>
          <Txt variant="label">{t.country}</Txt>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacingUnit * 2 }}>
            {countries.map((code) => {
              const active = code === country;
              return (
                <Pressable
                  key={code}
                  testID={`wajub-country-${code}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  onPress={() => setCountry(code)}
                  style={{
                    paddingHorizontal: theme.spacingUnit * 3,
                    paddingVertical: theme.spacingUnit * 2,
                    borderRadius: theme.radius,
                    borderWidth: active ? 2 : 1,
                    borderColor: active ? colors.primary : colors.inputBorder,
                    backgroundColor: active ? colors.selectedBackground : colors.inputBackground,
                  }}
                >
                  <Text style={{ color: colors.text, fontFamily: theme.fontFamily }}>
                    {mobileMoneyData().countries[code]?.name ?? code} {mobileMoneyData().countries[code]?.dial_code ?? ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {choices.length === 0 ? <Banner tone="warning" message={catalogueMessage('operator_unavailable', lang) ?? ''} testID="wajub-no-operator" /> : null}

      {showList ? (
        <View style={{ gap: theme.spacingUnit * 1.5 }}>
          <Txt variant="label">{t.operator}</Txt>
          <View
            accessibilityRole="radiogroup"
            style={{ borderRadius: theme.radius, borderWidth: 1, borderColor: colors.inputBorder, overflow: 'hidden', backgroundColor: colors.background }}
          >
            {choices.map((choice, index) => {
              const active = choice.id === selected;
              return (
                <Pressable
                  key={choice.id}
                  testID={`wajub-operator-${choice.id}`}
                  accessibilityRole="radio"
                  accessibilityLabel={choice.label}
                  accessibilityState={{ selected: active }}
                  onPress={() => pick(choice.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacingUnit * 3,
                    minHeight: 64,
                    paddingHorizontal: theme.spacingUnit * 3.5,
                    paddingVertical: theme.spacingUnit * 3,
                    borderTopWidth: index > 0 ? 1 : 0,
                    borderTopColor: colors.inputBorder,
                    backgroundColor: active ? colors.selectedBackground : colors.background,
                  }}
                >
                  <OperatorLogo operator={choice.id} name={choice.name} logo={choice.logo} />
                  <Text style={{ flex: 1, color: colors.text, fontFamily: theme.fontFamily, fontSize: theme.fontSizeBase, fontWeight: weight(theme.fontWeightMedium) }}>
                    {choice.label}
                  </Text>
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      borderWidth: active ? 6 : 1,
                      borderColor: active ? colors.primary : colors.borderStrong,
                      backgroundColor: active ? colors.onPrimary : colors.background,
                    }}
                  />
                </Pressable>
              );
            })}
          </View>
          {snapshot.fieldErrors.operator ? (
            <Txt variant="hint" style={{ color: colors.danger }} testID="wajub-operator-error">
              {snapshot.fieldErrors.operator}
            </Txt>
          ) : null}
        </View>
      ) : null}

      <Field
        testID="wajub-phone"
        label={t.phoneNumber}
        value={phone}
        onChangeText={onPhone}
        keyboardType="phone-pad"
        prefix={rules?.dial_code}
        placeholder={rules?.placeholder_formatted}
        error={snapshot.fieldErrors.phone}
        suffix={
          badge ? (
            <View testID="wajub-detected-operator" style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacingUnit }}>
              <OperatorLogo operator={badge.id} name={badge.name} logo={badge.logo} size={24} />
              <Txt variant="hint">{badge.label}</Txt>
            </View>
          ) : undefined
        }
      />
      {detectMode && !showList && choices.length > 1 ? (
        <Button variant="link" title={t.otherOperator} onPress={() => setListOpened(true)} testID="wajub-open-operators" />
      ) : null}

      <Banner tone="info" message={t.mobileMoneyInstructions} />

      <Button
        testID="wajub-pay"
        title={t.payAmount(formatAmount(total, session.transaction.currency, lang))}
        onPress={() => void controller.payMobileMoney({ phone, country, choice: selectedChoice, pickedByHand })}
        loading={snapshot.busy}
        disabled={choices.length === 0}
      />
    </View>
  );
}
