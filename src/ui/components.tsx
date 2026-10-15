import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { KeyboardTypeOptions, StyleProp, TextStyle, ViewStyle } from 'react-native';

import type { ResolvedTheme } from '../appearance/theme';
import { brandBadge } from '../mobileMoney/data';
import { useSheet } from './theme';

type FontWeight = TextStyle['fontWeight'];

/** A weight as React Native writes it: "100" … "900". */
export function weight(value: number): FontWeight {
  return String(Math.min(900, Math.max(100, Math.round(value / 100) * 100))) as FontWeight;
}

export function textStyle(theme: ResolvedTheme, variant: 'title' | 'body' | 'label' | 'hint' | 'amount'): TextStyle {
  const base: TextStyle = { fontFamily: theme.fontFamily, color: theme.colors.text };
  switch (variant) {
    case 'title':
      return { ...base, fontSize: theme.fontSizeBase * 1.125, fontWeight: weight(theme.fontWeightBold) };
    case 'amount':
      return { ...base, fontSize: theme.fontSizeBase * 1.5, fontWeight: weight(theme.fontWeightBold) };
    case 'label':
      return { ...base, fontSize: theme.fontSizeLabel, fontWeight: weight(theme.fontWeightMedium), color: theme.colors.textSecondary };
    case 'hint':
      return { ...base, fontSize: theme.fontSizeHint, fontWeight: weight(theme.fontWeightNormal), color: theme.colors.textSecondary };
    default:
      return { ...base, fontSize: theme.fontSizeBase * 0.9375, fontWeight: weight(theme.fontWeightNormal) };
  }
}

export function Txt({
  variant = 'body',
  style,
  children,
  testID,
}: {
  variant?: 'title' | 'body' | 'label' | 'hint' | 'amount';
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  testID?: string;
}) {
  const { theme } = useSheet();
  return (
    <Text style={[textStyle(theme, variant), style]} testID={testID}>
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  loading,
  variant = 'primary',
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'link';
  testID?: string;
}) {
  const { theme } = useSheet();
  const { colors } = theme;
  const inactive = disabled || loading;
  const label =
    variant === 'primary'
      ? { color: colors.onPrimary, fontWeight: weight(theme.fontWeightBold) }
      : { color: variant === 'link' ? colors.link : colors.text, fontWeight: weight(theme.fontWeightMedium) };
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        variant === 'link'
          ? styles.link
          : {
              minHeight: 48,
              borderRadius: theme.radius,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.spacingUnit * 4,
              backgroundColor: variant === 'primary' ? (pressed ? colors.primaryPressed : colors.primary) : colors.background,
              borderWidth: variant === 'secondary' ? 1 : 0,
              borderColor: colors.borderStrong,
            },
        inactive && { opacity: 0.5 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.onPrimary : colors.primary} />
      ) : (
        <Text style={[{ fontFamily: theme.fontFamily, fontSize: theme.fontSizeBase }, label]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  error,
  placeholder,
  keyboardType,
  secureTextEntry,
  autoCapitalize = 'none',
  maxLength,
  prefix,
  suffix,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'words' | 'characters' | 'sentences';
  maxLength?: number;
  prefix?: string;
  suffix?: React.ReactNode;
  testID?: string;
}) {
  const { theme } = useSheet();
  const { colors } = theme;
  const [focused, setFocused] = useState(false);
  // appearance `labels: 'floating'` (Wajub.js's): the label rests inside the box like a
  // placeholder and rises onto its border when the field has focus or a value.
  const floating = theme.labels === 'floating';
  const raised = !floating || focused || value.length > 0 || !!prefix;
  const lift = useRef(new Animated.Value(raised ? 1 : 0)).current;
  useEffect(() => {
    if (!floating) return;
    if (theme.disableAnimations) lift.setValue(raised ? 1 : 0);
    else Animated.timing(lift, { toValue: raised ? 1 : 0, duration: 150, useNativeDriver: false }).start();
  }, [floating, raised, theme.disableAnimations, lift]);
  const labelSize = theme.fontSizeBase;
  const raisedSize = theme.fontSizeBase * 0.85;
  return (
    <View style={{ gap: theme.spacingUnit * 1.5 }}>
      {floating ? null : (
        <Txt variant="label" testID={testID ? `${testID}-label` : undefined}>
          {label}
        </Txt>
      )}
      <View style={floating ? { paddingTop: Math.ceil(raisedSize / 2) } : null}>
        <View
          style={[
            styles.input,
            {
              minHeight: 44,
              borderRadius: theme.radius,
              backgroundColor: colors.inputBackground,
              borderColor: error ? colors.dangerBorder : focused ? colors.focusRing : colors.inputBorder,
              borderWidth: focused ? 2 : 1,
              paddingHorizontal: theme.spacingUnit * 3 - (focused ? 1 : 0),
            },
          ]}
        >
          {prefix ? <Text style={[textStyle(theme, 'body'), { fontSize: theme.fontSizeBase, marginRight: theme.spacingUnit * 2 }]}>{prefix}</Text> : null}
          <TextInput
            testID={testID}
            accessibilityLabel={label}
            value={value}
            onChangeText={onChangeText}
            // A resting floating label stands where the placeholder would.
            placeholder={raised ? placeholder : undefined}
            placeholderTextColor={colors.textPlaceholder}
            keyboardType={keyboardType}
            secureTextEntry={secureTextEntry}
            autoCapitalize={autoCapitalize}
            autoCorrect={false}
            maxLength={maxLength}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{ flex: 1, paddingVertical: 10, color: colors.text, fontSize: theme.fontSizeBase, fontFamily: theme.fontFamily }}
          />
          {suffix}
        </View>
        {floating ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Animated.Text
              testID={testID ? `${testID}-label` : undefined}
              accessibilityElementsHidden
              importantForAccessibility="no"
              numberOfLines={1}
              style={{
                position: 'absolute',
                left: theme.spacingUnit * 3 - 4,
                maxWidth: '90%',
                paddingHorizontal: 4,
                // On the box's border, which it hides: the field's own background behind it.
                backgroundColor: colors.inputBackground,
                fontFamily: theme.fontFamily,
                fontWeight: weight(theme.fontWeightNormal),
                color: raised ? colors.textSecondary : colors.textPlaceholder,
                top: lift.interpolate({ inputRange: [0, 1], outputRange: [Math.ceil(raisedSize / 2) + (44 - labelSize * 1.25) / 2, 0] }),
                fontSize: lift.interpolate({ inputRange: [0, 1], outputRange: [labelSize, raisedSize] }),
                lineHeight: lift.interpolate({ inputRange: [0, 1], outputRange: [labelSize * 1.25, raisedSize * 1.25] }),
              }}
            >
              {label}
            </Animated.Text>
          </View>
        ) : null}
      </View>
      {error ? (
        <Txt variant="hint" style={{ color: colors.danger }} testID={testID ? `${testID}-error` : undefined}>
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

/** A message above a form: an error (danger) or a note (warning, info). */
export function Banner({ message, tone = 'danger', testID }: { message: string; tone?: 'danger' | 'warning' | 'info'; testID?: string }) {
  const { theme } = useSheet();
  const { colors } = theme;
  const palette = {
    danger: [colors.dangerBackground, colors.danger],
    warning: [colors.warningBackground, colors.warning],
    info: [colors.selectedBackground, colors.text],
  }[tone];
  return (
    <View testID={testID} accessibilityRole="alert" style={{ backgroundColor: palette[0], borderRadius: theme.radius, padding: theme.spacingUnit * 3 }}>
      <Txt style={{ color: palette[1] }}>{message}</Txt>
    </View>
  );
}

/** A round badge in the operator's brand colours, when it has no usable logo. */
export function BrandBadge({ operator, name, size = 40 }: { operator: string; name: string; size?: number }) {
  const badge = brandBadge(operator, name);
  return (
    <View
      testID={`wajub-badge-${operator}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: badge.background, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}
    >
      <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: badge.color, fontSize: 9, fontWeight: '900' }}>
        {badge.text}
      </Text>
    </View>
  );
}

/** The operator's logo (https only), else — missing or failing to load — its brand badge. */
export function OperatorLogo({ operator, name, logo, size = 40 }: { operator: string; name: string; logo: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logo]);
  if (!logo || !/^https:\/\//i.test(logo) || failed) return <BrandBadge operator={operator} name={name} size={size} />;
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', padding: 4 }}>
      <Image
        testID={`wajub-logo-${operator}`}
        source={{ uri: logo }}
        resizeMode="contain"
        style={{ width: size - 8, height: size - 8 }}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

/** Placeholder blocks, pulsing unless animations are off (appearance, or the OS's reduced motion). */
export function Skeleton() {
  const { theme, t } = useSheet();
  const { colors } = theme;
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (theme.disableAnimations) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, theme.disableAnimations]);
  const block = (height: number, width: ViewStyle['width'] = '100%', fill = colors.surfaceMuted): ViewStyle => ({
    height,
    width,
    borderRadius: theme.radius,
    backgroundColor: fill,
  });
  return (
    <Animated.View testID="wajub-skeleton" accessibilityLabel={t.loading} style={{ opacity: pulse, gap: theme.gapRow }}>
      <View style={block(56)} />
      <View style={block(12, '40%')} />
      <View style={[block(44, '100%', colors.inputBackground), { borderWidth: 1, borderColor: colors.inputBorder }]} />
      <View style={[block(44, '100%', colors.inputBackground), { borderWidth: 1, borderColor: colors.inputBorder }]} />
      <View style={block(48)} />
    </Animated.View>
  );
}

/** A round mark at the top of an outcome screen. */
export function StatusMark({ tone, glyph }: { tone: 'success' | 'danger' | 'neutral'; glyph: string }) {
  const { theme } = useSheet();
  const { colors } = theme;
  const [background, color] =
    tone === 'success' ? [colors.successBackground, colors.success] : tone === 'danger' ? [colors.dangerBackground, colors.danger] : [colors.surfaceMuted, colors.textSecondary];
  return (
    <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: background, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}>
      <Text style={{ color, fontSize: 26, fontWeight: '700' }}>{glyph}</Text>
    </View>
  );
}

/** Re-renders every second while `active`, for countdowns. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

const styles = StyleSheet.create({
  input: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  link: {
    paddingVertical: 10,
    alignItems: 'center',
  },
});
