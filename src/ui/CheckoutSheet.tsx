import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, Animated, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CheckoutController } from '../checkout/controller';
import { formatAmount, sheetStrings } from '../i18n';
import { MobileMoneyForm } from './MobileMoneyForm';
import { Button, Skeleton, Txt, weight } from './components';
import {
  CardForm,
  FailedView,
  LoadErrorView,
  MethodList,
  NoticeView,
  PendingView,
  StepView,
  SuccessView,
  ThreeDsView,
  WaitingOnPhone,
  WalletForm,
} from './screens';
import { SheetProvider, useResolvedTheme, useSheet } from './theme';

const ELEVATION = { none: 0, low: 1, high: 8 };

/** Fades its content in once (200 ms), unless animations are off. */
function FadeIn({ children }: { children: React.ReactNode }) {
  const { theme } = useSheet();
  const opacity = useRef(new Animated.Value(theme.disableAnimations ? 1 : 0)).current;
  useEffect(() => {
    if (theme.disableAnimations) return;
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [opacity, theme.disableAnimations]);
  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

function Content({ controller }: { controller: CheckoutController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { theme, t } = useSheet();
  const screen = snapshot.screen;
  const props = { controller, snapshot };

  switch (screen.name) {
    case 'loading':
      return controller.options.loader === 'spinner' ? (
        <ActivityIndicator testID="wajub-spinner" size="large" color={theme.colors.primary} style={{ marginVertical: 48 }} />
      ) : (
        <Skeleton />
      );
    case 'load_error':
      return <LoadErrorView {...props} error={screen.error} />;
    case 'methods':
      return <MethodList {...props} />;
    case 'form': {
      const { method } = screen;
      const form =
        method.kind === 'mobile_money' ? (
          <MobileMoneyForm {...props} method={method} />
        ) : method.kind === 'card' ? (
          <CardForm {...props} method={method} />
        ) : (
          <WalletForm {...props} method={method} />
        );
      return (
        <View style={{ gap: theme.gapRow }}>
          {snapshot.methods.length > 1 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Txt variant="label">{method.kind === 'mobile_money' ? t.tabs.mobile_money : method.label}</Txt>
              <Pressable testID="wajub-change-method" accessibilityRole="button" disabled={snapshot.busy} onPress={() => controller.backToMethods()}>
                <Text style={{ color: theme.colors.link, fontFamily: theme.fontFamily }}>{t.change}</Text>
              </Pressable>
            </View>
          ) : null}
          {form}
        </View>
      );
    }
    case 'approval':
      return <WaitingOnPhone {...props} phone={screen.phone} instruction={screen.instruction} ussd={false} />;
    case 'ussd':
      return <WaitingOnPhone {...props} phone={null} instruction={screen.instruction} ussd />;
    case 'step':
      return <StepView key={screen.step.id} {...props} step={screen.step} />;
    case 'three_ds':
      return <ThreeDsView key={screen.threeDs.id} {...props} threeDs={screen.threeDs} />;
    case 'pending':
      return <PendingView {...props} url={screen.url} capped={screen.capped} />;
    case 'success':
      return <SuccessView {...props} payment={screen.payment} />;
    case 'failed':
      return <FailedView key={screen.error.code} {...props} error={screen.error} />;
    case 'expired':
      return <NoticeView {...props} title={t.expiredTitle} error={screen.error} />;
    case 'cancelled':
      return <NoticeView {...props} title={t.cancelledTitle} error={screen.error} />;
  }
}

/**
 * The payment sheet: a modal over the app, drawn with the appearance the host
 * passed over the merchant's branding, in light or dark as resolved.
 */
export function CheckoutSheet({ controller }: { controller: CheckoutController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const branding = snapshot.session?.branding;
  const theme = useResolvedTheme(controller.options.appearance, branding);
  const context = useMemo(() => ({ theme, t: sheetStrings(snapshot.lang), lang: snapshot.lang }), [theme, snapshot.lang]);
  const { colors } = theme;
  const t = context.t;
  const transaction = snapshot.session?.transaction;
  const merchant = theme.businessName;
  const loaded = snapshot.screen.name !== 'loading';

  return (
    <Modal
      visible={snapshot.visible}
      transparent
      animationType={theme.disableAnimations ? 'none' : 'slide'}
      onRequestClose={controller.dismiss}
    >
      <SheetProvider value={context}>
        <View style={[styles.backdrop, { backgroundColor: `rgba(0,0,0,${theme.scrimOpacity})` }]}>
          {/* At most 92 % of the screen; a long form scrolls inside. */}
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.frame}>
            <View
              testID="wajub-sheet"
              style={{
                backgroundColor: colors.background,
                borderTopLeftRadius: Math.max(16, theme.radius * 2),
                borderTopRightRadius: Math.max(16, theme.radius * 2),
                paddingHorizontal: theme.spacingUnit * 5,
                paddingTop: theme.spacingUnit * 4,
                paddingBottom: theme.spacingUnit * 6,
                flexShrink: 1,
                elevation: ELEVATION[theme.shadow],
                shadowColor: '#000000',
                shadowOpacity: theme.shadow === 'none' ? 0 : theme.shadow === 'high' ? 0.25 : 0.1,
                shadowRadius: ELEVATION[theme.shadow] * 2,
              }}
            >
              <View style={styles.header}>
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacingUnit * 2 }}>
                  {theme.logoUrl ? (
                    <Image testID="wajub-merchant-logo" source={{ uri: theme.logoUrl }} resizeMode="contain" style={{ height: 32, width: 96 }} accessibilityLabel={merchant ?? undefined} />
                  ) : (
                    <Txt variant="title" testID="wajub-merchant-name">
                      {merchant ?? t.title}
                    </Txt>
                  )}
                  {transaction?.sandbox ? (
                    <View style={{ backgroundColor: colors.warningBackground, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: colors.warning, fontSize: 11, fontWeight: weight(theme.fontWeightBold) }}>{t.testMode}</Text>
                    </View>
                  ) : null}
                </View>
                <Pressable testID="wajub-dismiss" accessibilityRole="button" accessibilityLabel={t.close} hitSlop={12} onPress={controller.dismiss}>
                  <Text style={{ fontSize: 20, color: colors.textSecondary }}>✕</Text>
                </Pressable>
              </View>

              {transaction && loaded ? (
                <View style={{ backgroundColor: colors.surfaceMuted, borderRadius: theme.radius, padding: theme.spacingUnit * 3, marginBottom: theme.gapRow }}>
                  <Txt variant="amount" testID="wajub-amount">
                    {formatAmount(transaction.amount_total ?? transaction.amount, transaction.currency, snapshot.lang)}
                  </Txt>
                  {transaction.description ? <Txt variant="hint">{transaction.description}</Txt> : null}
                </View>
              ) : null}

              <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={{ gap: theme.gapRow }}>
                {loaded ? (
                  <FadeIn>
                    <Content controller={controller} />
                  </FadeIn>
                ) : (
                  <Content controller={controller} />
                )}
                {snapshot.canCancel ? (
                  <Button variant="link" testID="wajub-cancel-payment" title={t.cancelPayment} loading={snapshot.cancelling} onPress={() => void controller.cancelPayment()} />
                ) : null}
              </ScrollView>

              {!theme.whiteLabel ? (
                <Text testID="wajub-secured" style={{ textAlign: 'center', marginTop: theme.spacingUnit * 3, color: colors.textPlaceholder, fontSize: theme.fontSizeHint, fontFamily: theme.fontFamily }}>
                  🔒 {t.securedBy}
                </Text>
              ) : null}
            </View>
          </KeyboardAvoidingView>
        </View>
      </SheetProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  frame: {
    maxHeight: '92%',
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
});
