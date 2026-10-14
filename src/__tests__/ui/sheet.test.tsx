import React, { forwardRef, useImperativeHandle } from 'react';
import { AccessibilityInfo, Animated, Linking, StyleSheet } from 'react-native';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { initStripe } from '@stripe/stripe-react-native';

import { CheckoutController } from '../../checkout/controller';
import { PayClient } from '../../client/payClient';
import { PaymentSheet, usePayment } from '../../usePayment';
import { WajubSession } from '../../WajubSession';
import { CheckoutSheet } from '../../ui/CheckoutSheet';
import { fakeApi } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import type { CheckoutResult, PresentOptions } from '../../types';

// The first render under React Native's preset can be slow on a loaded machine.
configure({ asyncUtilTimeout: 5000 });

jest.mock(
  '@react-native-async-storage/async-storage',
  () => {
    const items = new Map<string, string>();
    return { default: { getItem: async (k: string) => items.get(k) ?? null, setItem: async (k: string, v: string) => void items.set(k, v) } };
  },
  { virtual: true },
);
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn(() => 'light') }));
const useColorScheme = jest.requireMock('react-native/Libraries/Utilities/useColorScheme').default as jest.Mock;

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.restoreAllMocks();
  useColorScheme.mockReturnValue('light');
});

function routes(extra: Record<string, Answer | Answer[]> = {}) {
  return { 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-cm-stripe', 'GET /pay/status': 'status-processing', 'POST /pay/cancel': 'cancel-200', ...extra };
}

/** The sheet on the fake API, drawn; `openUrl` is the SDK's own (Linking). */
async function show(options: Partial<PresentOptions> = {}, routeAnswers: Record<string, Answer | Answer[]> = routes()) {
  api = fakeApi(routeAnswers);
  const controller = new CheckoutController(
    { sessionToken: 'tok_ui', readyTimeout: 0, autoCloseSuccess: 0, ...options },
    { client: new PayClient({ sleep: async () => undefined }), stripeInstalled: true },
  );
  render(<CheckoutSheet controller={controller} />);
  await act(async () => {
    controller.start();
  });
  return controller;
}

function backgroundOf(testID: string): string {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style).backgroundColor;
}

describe('UI — payment sheet', () => {
  it('LD-07 offers retry on load failure', async () => {
    const controller = await show({}, routes({ 'GET /pay/session': 'network' }));
    await waitFor(() => screen.getByTestId('wajub-load-error'));
    expect(screen.getByTestId('wajub-error-message').props.children).toBe(
      "We couldn't load the payment. Check your connection and try again.",
    );
    expect(screen.getByText("We couldn't load the payment")).toBeTruthy();

    // The network is back: Retry loads the payment.
    api.answer('GET /pay/session', 'session-cm-aggregate');
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-retry'));
    });
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    expect(controller.getSnapshot().state).toBe('INITIATED');
    await act(async () => controller.hostGone());
  });

  it('MM-07 falls back to brand badges', async () => {
    const controller = await show({ locale: 'en' }, routes({ 'GET /pay/session': 'session-ci-xof-wallets', 'GET /pay/sdk-config': 'sdk-config-ci-wallets' }));
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    // Logos and badges are decorative (the line's label names the operator): hidden from accessibility.
    const hidden = { includeHiddenElements: true };
    // ci.moov has no logo: its brand badge.
    expect(screen.getByTestId('wajub-badge-moov', hidden)).toBeTruthy();
    expect(screen.getByText('Moov', hidden)).toBeTruthy();
    expect(screen.getByTestId('wajub-operator-moov').props.accessibilityLabel).toBe('Moov Money');
    // MTN's logo fails to load: its badge instead.
    expect(screen.queryByTestId('wajub-badge-mtn', hidden)).toBeNull();
    await act(async () => {
      fireEvent(screen.getByTestId('wajub-logo-mtn', hidden), 'error', { nativeEvent: { error: 'unreachable' } });
    });
    expect(screen.getByTestId('wajub-badge-mtn', hidden)).toBeTruthy();
    expect(screen.getByText('MoMo', hidden)).toBeTruthy();
    await act(async () => controller.hostGone());
  });

  it('RD-01 opens provider pages in the system browser', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onRedirect = jest.fn(() => expect(openURL).not.toHaveBeenCalled());
    const controller = await show(
      { onRedirect, locale: 'en' },
      routes({ 'GET /pay/sdk-config': 'sdk-config-card-kkiapay', 'POST /pay/process': 'process-redirect-card-hosted' }),
    );
    await waitFor(() => screen.getByTestId('wajub-method-card'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-card'));
    });
    // The customer's email is already there; Pay opens the provider's page.
    expect(screen.getByTestId('wajub-field-email').props.value).toBe('awa.ngono@example.com');
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-pay'));
    });
    await waitFor(() => expect(openURL).toHaveBeenCalledWith('https://checkout.psp.example/pay/abc123'));
    expect(onRedirect).toHaveBeenCalledWith({ url: 'https://checkout.psp.example/pay/abc123', method: 'GET' });
    expect(screen.UNSAFE_queryAllByType('RNCWebView' as never)).toHaveLength(0);
    // "Continue payment" reopens it.
    expect(screen.getByText('Continue payment')).toBeTruthy();
    await act(async () => controller.hostGone());
  });

  it('AP-07 draws the loader', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    const pending = routes({ 'GET /pay/session': 'hang', 'GET /pay/sdk-config': 'hang' });

    let controller = await show({}, pending);
    expect(screen.getByTestId('wajub-skeleton')).toBeTruthy();
    expect(loop).toHaveBeenCalled();
    await act(async () => controller.hostGone());
    screen.unmount();

    loop.mockClear();
    controller = await show({ appearance: { disableAnimations: true } }, pending);
    expect(screen.getByTestId('wajub-skeleton')).toBeTruthy();
    expect(loop).not.toHaveBeenCalled();
    await act(async () => controller.hostGone());
    screen.unmount();

    // The OS asks for reduced motion: the pulse stops as soon as it says so.
    const stop = jest.fn();
    loop.mockImplementation(() => ({ start: jest.fn(), stop, reset: jest.fn() }));
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    controller = await show({}, pending);
    await act(async () => undefined);
    expect(stop).toHaveBeenCalled();
    expect(screen.getByTestId('wajub-skeleton')).toBeTruthy();
    await act(async () => controller.hostGone());
    screen.unmount();

    controller = await show({ loader: 'spinner' }, pending);
    expect(screen.getByTestId('wajub-spinner')).toBeTruthy();
    expect(screen.queryByTestId('wajub-skeleton')).toBeNull();
    await act(async () => controller.hostGone());
  });

  it('AP-08 inherits the host theme', async () => {
    // The merchant designed for light; the app is dark.
    useColorScheme.mockReturnValue('dark');
    let controller = await show({ appearance: { inherit: true } });
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    expect(backgroundOf('wajub-sheet')).toBe('#0A0A0A');
    await act(async () => controller.hostGone());
    screen.unmount();

    // Without inherit, the merchant's appearance_mode wins.
    controller = await show({});
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    expect(backgroundOf('wajub-sheet')).toBe('#FFFFFF');
    expect(screen.queryByTestId('wajub-secured')).toBeNull();
    await act(async () => controller.hostGone());
  });

  it("initialises Stripe with the payment's own key", async () => {
    (initStripe as jest.Mock).mockClear();
    const controller = await show({ locale: 'en' });
    await waitFor(() => screen.getByTestId('wajub-method-card'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-card'));
    });
    // Only the account that issues a pm_ can charge it: sdk-config's publishable key.
    expect(initStripe).toHaveBeenCalledWith({ publishableKey: 'pk_live_51Hx4mPLACEHOLDER' });
    await act(async () => controller.hostGone());
  });

  it('draws the Mobile Money form, detection and the approval screen', async () => {
    const controller = await show(
      { locale: 'fr' },
      routes({ 'GET /pay/session': 'session-sandbox-cm', 'GET /pay/sdk-config': 'sdk-config-sandbox', 'POST /pay/process': 'process-processing-mobile-money-sandbox' }),
    );
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    // An Express Union line first (no logo: its badge), then the aggregate's operators.
    expect(screen.getByTestId('wajub-operator-eu').props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-phone'), '670000000');
    });
    // Formatted as typed; Express Union takes any number, MTN is detected and preselected.
    expect(screen.getByTestId('wajub-phone').props.value).toBe('67 00 00 00 0');
    expect(screen.getByTestId('wajub-operator-mtn').props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-pay'));
    });
    await waitFor(() => screen.getByTestId('wajub-approval'));
    expect(screen.getByText('Validez le paiement sur votre téléphone')).toBeTruthy();
    // The API's English instruction, under a label in a French sheet.
    expect(screen.getByTestId('wajub-payer-instruction').props.children).toMatch(/dial \*126#/);
    expect(api.callsTo('POST /pay/process')[0].body.data).toMatchObject({ phone: '+237670000000', operator: 'mtn' });
    await act(async () => controller.hostGone());
  });
});

/** A host screen that opens the sheet with `usePayment()`. */
const Host = forwardRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>(function Host(_, ref) {
  const { present, PaymentSheet } = usePayment();
  useImperativeHandle(ref, () => ({ present }), [present]);
  return PaymentSheet;
});

describe('UI — usePayment', () => {
  it('ST-04 settles when the host goes away', async () => {
    api = fakeApi(routes());
    const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
    render(<Host ref={host} />);
    let result!: Promise<CheckoutResult>;
    await act(async () => {
      result = host.current!.present({ sessionToken: 'tok_ui', readyTimeout: 0 });
    });
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));

    // The screen that presented the sheet unmounts: present() still settles, and nothing is cancelled.
    screen.unmount();
    await expect(result).resolves.toEqual({ status: 'cancelled', reason: 'host_gone', redirectUrl: null, cancelled: true });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('keeps the deprecated PaymentSheet open when its effect runs again', async () => {
    api = fakeApi(routes());
    const onDismiss = jest.fn();
    const props = { visible: true, locale: 'en', onSubmit: jest.fn(), onDismiss, onResult: jest.fn() };
    // StrictMode runs effects twice, and a new session object each render must not close the sheet.
    const { rerender } = render(
      <React.StrictMode>
        <PaymentSheet {...props} session={new WajubSession('tok_legacy')} />
      </React.StrictMode>,
    );
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    rerender(
      <React.StrictMode>
        <PaymentSheet {...props} session={new WajubSession('tok_legacy')} />
      </React.StrictMode>,
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(api.callsTo('GET /pay/session')).toHaveLength(1);
    expect(screen.getByTestId('wajub-method-mobile_money')).toBeTruthy();

    // Closed by the payer: 1.4's onDismiss, the payment left open.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('ST-05 rejects a second present', async () => {
    api = fakeApi(routes());
    const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
    render(<Host ref={host} />);
    let first!: Promise<CheckoutResult>;
    await act(async () => {
      first = host.current!.present({ sessionToken: 'tok_ui', readyTimeout: 0, cancelOnDismiss: false });
    });
    await expect(host.current!.present({ sessionToken: 'tok_other' })).rejects.toMatchObject({
      name: 'WajubError',
      type: 'invalid_request_error',
      code: 'sheet_already_presented',
      message: 'A Wajub payment sheet is already presented.',
    });
    // The open sheet is left alone, and closes as usual.
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(first).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
  });
});
