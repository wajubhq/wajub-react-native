import React, { forwardRef, useEffect, useImperativeHandle } from 'react';
import { AccessibilityInfo, Animated, Linking, StyleSheet, View } from 'react-native';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { initStripe } from '@stripe/stripe-react-native';

import { CheckoutController } from '../../checkout/controller';
import { PayClient } from '../../client/payClient';
import { PaymentSheet, usePayment } from '../../usePayment';
import { WajubSession } from '../../WajubSession';
import { CheckoutSheet } from '../../ui/CheckoutSheet';
import { body, fakeApi } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import type { CheckoutResult, PresentOptions } from '../../types';
import type { WajubError } from '../../WajubError';

// The first render under React Native's preset can be slow on a loaded machine.
configure({ asyncUtilTimeout: 5000 });

/**
 * React 18 StrictMode, on a concurrent root, runs every effect's first mount
 * as effect → cleanup → effect. react-test-renderer 18 never does: when `on`,
 * this applies that behaviour to every `useEffect` (the SDK's and React
 * Native's) for one test.
 */
const mockStrictEffects = { on: false };
jest.mock('react', () => {
  const actual = jest.requireActual('react');
  const twice = (hook: typeof actual.useEffect) => (effect: () => void | (() => void), deps?: unknown[]) => {
    const ran = actual.useRef(false);
    return hook(() => {
      if (!mockStrictEffects.on || ran.current) return effect();
      ran.current = true;
      const first = effect();
      if (typeof first === 'function') first();
      return effect();
    }, deps);
  };
  const useEffect = twice(actual.useEffect);
  const useLayoutEffect = twice(actual.useLayoutEffect);
  return { __esModule: true, ...actual, useEffect, useLayoutEffect, default: { ...actual, useEffect, useLayoutEffect } };
});

jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: jest.fn(() => 'light') }));
const useColorScheme = jest.requireMock('react-native/Libraries/Utilities/useColorScheme').default as jest.Mock;

let api: FakeApi;

// React Native's components load (and compile, with a cold cache) on first
// render: once here, outside any test's own time.
beforeAll(async () => {
  api = fakeApi({ 'GET /pay/session': 'hang', 'GET /pay/sdk-config': 'hang' });
  const warm = new CheckoutController({ sessionToken: 'tok_warm', readyTimeout: 0 }, { client: new PayClient({ sleep: async () => undefined }) });
  render(<CheckoutSheet controller={warm} />);
  await act(async () => warm.start());
  await act(async () => warm.hostGone());
  screen.unmount();
  api.restore();
}, 120_000);

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
    // MTN's logo is an SVG, which the sheet cannot draw, and there is no PNG: its badge.
    expect(screen.queryByTestId('wajub-logo-mtn', hidden)).toBeNull();
    expect(screen.getByTestId('wajub-badge-mtn', hidden)).toBeTruthy();
    expect(screen.getByText('MoMo', hidden)).toBeTruthy();
    await act(async () => controller.hostGone());
  });

  it('CH-06 prefers logo_png where SVG cannot be drawn', async () => {
    const controller = await show({ locale: 'en' }, routes());
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    const hidden = { includeHiddenElements: true };
    const session = body('session-cm-aggregate');
    const aggregate = session.channels.find((c: { slug: string }) => c.slug === 'cm.mobile');
    // The method list: Mobile Money's PNG; card has an SVG only — its badge.
    expect(screen.getByTestId('wajub-logo-mobile_money', hidden).props.source).toEqual({ uri: aggregate.logo_png });
    expect(screen.queryByTestId('wajub-logo-card', hidden)).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    // Each operator's PNG, never its SVG.
    for (const operator of aggregate.operators) {
      const image = screen.getByTestId(`wajub-logo-${operator.operator}`, hidden);
      expect(image.props.source).toEqual({ uri: operator.logo_png });
      expect(operator.logo).toMatch(/\.svg$/);
    }
    // A PNG that fails to load: the brand badge.
    await act(async () => {
      fireEvent(screen.getByTestId('wajub-logo-orange', hidden), 'error', { nativeEvent: { error: 'unreachable' } });
    });
    expect(screen.getByTestId('wajub-badge-orange', hidden)).toBeTruthy();
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

  it("AP-01 draws Wajub.js's floating labels", async () => {
    // The floating label is hidden from accessibility (the field carries its name): include it.
    const label = () => screen.getByTestId('wajub-field-email-label', { includeHiddenElements: true });
    const flat = (_: string) => StyleSheet.flatten(label().props.style);
    // The default: the label above the field.
    await show({ locale: 'en' }, routes({ 'GET /pay/sdk-config': 'sdk-config-card-kkiapay' }));
    await waitFor(() => screen.getByTestId('wajub-method-card'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-card'));
    });
    expect(flat('wajub-field-email-label').position).toBeUndefined();
    screen.unmount();
    api.restore();

    // `labels: 'floating'`: inside the box while empty, on its border with focus or a value.
    await show({ locale: 'en', appearance: { labels: 'floating', disableAnimations: true } }, routes({ 'GET /pay/sdk-config': 'sdk-config-card-kkiapay' }));
    await waitFor(() => screen.getByTestId('wajub-method-card'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-card'));
    });
    // Prefilled with the customer's email: raised. Emptied: back inside the box.
    expect(flat('wajub-field-email-label').top).toBe(0);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-field-email'), '');
    });
    const resting = flat('wajub-field-email-label');
    expect(resting.position).toBe('absolute');
    expect(resting.top).toBeGreaterThan(0);
    expect(label().props.children).toBe('Email');
    await act(async () => {
      fireEvent(screen.getByTestId('wajub-field-email'), 'focus');
    });
    const focused = flat('wajub-field-email-label');
    expect(focused.top).toBe(0);
    expect(focused.fontSize).toBeLessThan(resting.fontSize as number);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-field-email'), 'awa@example.com');
      fireEvent(screen.getByTestId('wajub-field-email'), 'blur');
    });
    expect(flat('wajub-field-email-label').top).toBe(0);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-field-email'), '');
    });
    expect(flat('wajub-field-email-label').top).toBe(resting.top);
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

  it("initialises Stripe with the payment's own key, and puts the app's back", async () => {
    const init = initStripe as jest.Mock;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const appPublishableKey of [undefined, 'pk_live_app']) {
      init.mockClear();
      warn.mockClear();
      const controller = await show({ locale: 'en', stripe: { appPublishableKey } });
      await waitFor(() => screen.getByTestId('wajub-method-card'));
      await act(async () => {
        fireEvent.press(screen.getByTestId('wajub-method-card'));
      });
      // Only the account that issues a pm_ can charge it: sdk-config's publishable key.
      expect(init.mock.calls).toEqual([[{ publishableKey: 'pk_live_51Hx4mPLACEHOLDER' }]]);
      await act(async () => controller.hostGone());
      screen.unmount();
      if (appPublishableKey) {
        // The app said which key is its own: it is back once the card form is gone.
        expect(init.mock.calls[1]).toEqual([{ publishableKey: 'pk_live_app' }]);
        expect(warn).not.toHaveBeenCalled();
      } else {
        // It did not: nothing to put back, and a warning in development says so.
        expect(init).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('appPublishableKey'));
      }
    }
  });

  it('MM-03 preselects again from the number typed when the payer changes country', async () => {
    // Cameroon's aggregate and Côte d'Ivoire's operators, in one payment.
    const session = body('session-cm-aggregate');
    const ivorian = body('session-ci-xof-wallets').channels.filter((c: { slug: string }) => ['ci.mtn', 'ci.orange'].includes(c.slug));
    session.channels = [...session.channels, ...ivorian];
    await show({ locale: 'en', mobileMoney: { country: 'CM' } }, routes({ 'GET /pay/session': { status: 200, body: session } }));
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    // An Ivorian Orange number, typed while Cameroon is selected: nothing to detect there.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-phone'), '0712345678');
    });
    expect(screen.getByTestId('wajub-operator-mtn').props.accessibilityState).toMatchObject({ selected: true });
    // Côte d'Ivoire: the number names Orange there, before the payer presses Pay.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-country-CI'));
    });
    expect(screen.getByTestId('wajub-operator-orange').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId('wajub-operator-mtn').props.accessibilityState).toMatchObject({ selected: false });
  });

  it('MM-01 reads a number typed with Arabic-Indic digits', async () => {
    await show({ locale: 'en' }, routes({ 'POST /pay/process': 'process-processing-mobile-money-live' }));
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-phone'), '٦٩١٢٣٤٥٦٧');
    });
    // Shown as the digits read, its operator detected, and sent.
    expect(screen.getByTestId('wajub-phone').props.value).toBe('69 12 34 56 7');
    expect(screen.getByTestId('wajub-operator-orange').props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-pay'));
    });
    await waitFor(() => expect(api.callsTo('POST /pay/process')).toHaveLength(1));
    expect(api.callsTo('POST /pay/process')[0].body.data.phone).toBe('+237691234567');
    expect(screen.queryByTestId('wajub-phone-error')).toBeNull();
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

describe('UI — cancelling', () => {
  it('disables Pay, the close button and Cancel while the cancel runs', async () => {
    const controller = await show({ locale: 'en' });
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const realFetch = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pay/cancel')) await held;
      return realFetch(url, init);
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-cancel-payment'));
    });
    expect(screen.getByTestId('wajub-dismiss').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId('wajub-cancel-payment').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(screen.getByTestId('wajub-pay').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-phone'), '670000000');
      fireEvent.press(screen.getByTestId('wajub-pay'));
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
      fireEvent.press(screen.getByTestId('wajub-cancel-payment'));
    });
    const sent = (path: string) => api.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
    expect(sent('/pay/process')).toBe(0);
    expect(sent('/pay/cancel')).toBe(1);
    expect(controller.closed).toBe(false);
    await act(async () => {
      release();
      await controller.result;
    });
    await expect(controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'payer_cancelled' });
  });
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

  it("keeps the deprecated PaymentSheet's 1.4 callbacks", async () => {
    api = fakeApi(routes({ 'GET /pay/session': 'session-sandbox-cm', 'GET /pay/sdk-config': 'sdk-config-sandbox', 'POST /pay/process': 'process-processing-mobile-money-sandbox' }));
    const props = { visible: true, locale: 'en', onSubmit: jest.fn(), onDismiss: jest.fn(), onResult: jest.fn() };
    render(<PaymentSheet {...props} session={new WajubSession('tok_legacy_cb')} />);
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-method-mobile_money'));
    });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('wajub-phone'), '670000000');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-pay'));
    });
    // onSubmit as the payer submits, as in 1.4.
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => screen.getByTestId('wajub-approval'));
    // Closed during the attempt: 1.4's onResult(processing), as its sheet reported a 202.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    expect(props.onResult).toHaveBeenCalledTimes(1);
    expect(props.onResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'processing', transaction: expect.objectContaining({ reference: expect.any(String) }) }),
    );
    expect(props.onDismiss).not.toHaveBeenCalled();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    screen.unmount();

    // Closed before any attempt: onDismiss, and the payment is left open.
    const early = { visible: true, locale: 'en', onSubmit: jest.fn(), onDismiss: jest.fn(), onResult: jest.fn() };
    render(<PaymentSheet {...early} session={new WajubSession('tok_legacy_early')} />);
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    expect(early.onDismiss).toHaveBeenCalledTimes(1);
    expect(early.onResult).not.toHaveBeenCalled();
    expect(early.onSubmit).not.toHaveBeenCalled();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('opens a sheet right after the previous one settled', async () => {
    api = fakeApi(routes());
    const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
    render(<Host ref={host} />);
    // From onComplete, in the same tick as the settle.
    let second!: Promise<CheckoutResult>;
    let first!: Promise<CheckoutResult>;
    await act(async () => {
      first = host.current!.present({
        sessionToken: 'tok_first',
        readyTimeout: 0,
        cancelOnDismiss: false,
        onComplete: () => {
          second = host.current!.present({ sessionToken: 'tok_second', readyTimeout: 0, cancelOnDismiss: false });
        },
      });
    });
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    await waitFor(() => expect(api.calls.filter((c) => c.headers.Authorization === 'Bearer tok_second').length).toBeGreaterThan(0));
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(second).resolves.toMatchObject({ status: 'cancelled' });
    screen.unmount();

    // A host swapped for another in one commit, which presents as it mounts.
    function Swapped({ token }: { token: string }) {
      const { present, PaymentSheet: element } = usePayment();
      useEffect(() => {
        void present({ sessionToken: token, readyTimeout: 0, cancelOnDismiss: false }).then((r) => results.push(`${token}:${r.status}`));
      }, [present, token]);
      return element;
    }
    const results: string[] = [];
    // A stable parent: the swap happens below the root RNTL queries from.
    const { rerender } = render(<View><Swapped key="a" token="tok_a" /></View>);
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    rerender(<View><Swapped key="b" token="tok_b" /></View>);
    await waitFor(() => expect(api.calls.filter((c) => c.headers.Authorization === 'Bearer tok_b').length).toBeGreaterThan(0));
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await waitFor(() => expect(results).toEqual(['tok_a:cancelled', 'tok_b:cancelled']));
  });

  it("survives React 18 StrictMode's effects run twice", async () => {
    api = fakeApi(routes());
    mockStrictEffects.on = true;
    try {
      const effects: string[] = [];
      function Probe() {
        useEffect(() => {
          effects.push('mount');
          return () => void effects.push('unmount');
        }, []);
        return null;
      }
      const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
      const onDismiss = jest.fn();
      render(
        <React.StrictMode>
          <Probe />
          <Host ref={host} />
          <PaymentSheet visible session={new WajubSession('tok_strict')} onSubmit={() => {}} onDismiss={onDismiss} onResult={() => {}} />
        </React.StrictMode>,
      );
      // The scenario is real: the effects mounted, unmounted and mounted again.
      expect(effects).toEqual(['mount', 'unmount', 'mount']);
      await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      // The deprecated component's sheet is the one it opened, still open; the payment loaded once.
      expect(onDismiss).not.toHaveBeenCalled();
      expect(api.callsTo('GET /pay/session').filter((c) => c.headers.Authorization === 'Bearer tok_strict')).toHaveLength(1);

      await act(async () => {
        fireEvent.press(screen.getByTestId('wajub-dismiss'));
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);

      // usePayment() in the same tree: its host was never "gone", present() works.
      let result!: Promise<CheckoutResult>;
      await act(async () => {
        result = host.current!.present({ sessionToken: 'tok_strict_hook', readyTimeout: 0, cancelOnDismiss: false });
      });
      await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      await act(async () => {
        fireEvent.press(screen.getByTestId('wajub-dismiss'));
      });
      await expect(result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
      screen.unmount();

      // Presenting right away, while the clean-up of the first run is still due: the host is there.
      render(
        <React.StrictMode>
          <Host ref={host} />
        </React.StrictMode>,
      );
      let early!: Promise<CheckoutResult>;
      act(() => {
        early = host.current!.present({ sessionToken: 'tok_strict_early', readyTimeout: 0, cancelOnDismiss: false });
      });
      await waitFor(() => screen.getByTestId('wajub-dismiss'));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(screen.getByTestId('wajub-dismiss')).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByTestId('wajub-dismiss'));
      });
      await expect(early).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
    } finally {
      mockStrictEffects.on = false;
    }
  });

  it('keeps the deprecated PaymentSheet when its host remounts', async () => {
    api = fakeApi(routes());
    const props = { visible: true, onSubmit: jest.fn(), onDismiss: jest.fn(), onResult: jest.fn() };
    const { rerender } = render(<View><PaymentSheet key="first" {...props} session={new WajubSession('tok_remount')} /></View>);
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    // A new instance for the same payment, in one commit: it takes the open sheet over.
    rerender(<View><PaymentSheet key="second" {...props} session={new WajubSession('tok_remount')} /></View>);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(props.onDismiss).not.toHaveBeenCalled();
    expect(api.callsTo('GET /pay/session')).toHaveLength(1);
    expect(screen.getByTestId('wajub-method-mobile_money')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
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

  it('settles a present() called after its host unmounted at once', async () => {
    api = fakeApi(routes());
    const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
    render(<Host ref={host} />);
    const present = host.current!.present;
    // The app awaited something, and the screen went away meanwhile.
    screen.unmount();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    const onCancel = jest.fn();
    const onComplete = jest.fn();
    await expect(present({ sessionToken: 'tok_late', readyTimeout: 0, onCancel, onComplete })).resolves.toEqual({
      status: 'cancelled',
      reason: 'host_gone',
      redirectUrl: null,
      cancelled: true,
    });
    expect(onCancel).toHaveBeenCalledWith({ reason: 'host_gone', redirectUrl: null });
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled', reason: 'host_gone' }));
    // No API call, and no sheet holds the app: the next host presents.
    expect(api.calls).toHaveLength(0);
    render(<Host ref={host} />);
    let next!: Promise<CheckoutResult>;
    await act(async () => {
      next = host.current!.present({ sessionToken: 'tok_next', readyTimeout: 0, cancelOnDismiss: false });
    });
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(next).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
  });

  it('settles the sheet of a host replaced in the same commit before the new host presents', async () => {
    api = fakeApi(routes());
    const results: string[] = [];
    function Swapped({ token }: { token: string }) {
      const { present, PaymentSheet: element } = usePayment();
      useEffect(() => {
        present({ sessionToken: token, readyTimeout: 0, cancelOnDismiss: false }).then(
          (r) => results.push(`${token}:${r.status}:${'reason' in r ? r.reason : ''}`),
          (e: WajubError) => results.push(`${token}:rejected:${e.code}`),
        );
      }, [present, token]);
      return element;
    }
    const { rerender } = render(<View><Swapped key="a" token="tok_a" /></View>);
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    // The first host's sheet is still open as the second host mounts and presents.
    rerender(<View><Swapped key="b" token="tok_b" /></View>);
    await waitFor(() => expect(api.calls.filter((c) => c.headers.Authorization === 'Bearer tok_b').length).toBeGreaterThan(0));
    expect(results).toEqual(['tok_a:cancelled:host_gone']);
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await waitFor(() => expect(results).toEqual(['tok_a:cancelled:host_gone', 'tok_b:cancelled:dismissed']));
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('opens the deprecated PaymentSheet once the sheet open before it closes', async () => {
    api = fakeApi(routes());
    const host = React.createRef<{ present(o: PresentOptions): Promise<CheckoutResult> }>();
    const legacy = { onSubmit: jest.fn(), onDismiss: jest.fn(), onResult: jest.fn() };
    const legacyCalls = () => api.calls.filter((c) => c.headers.Authorization === 'Bearer tok_waiting').length;
    const { rerender } = render(<View><Host ref={host} /></View>);
    let first!: Promise<CheckoutResult>;
    await act(async () => {
      first = host.current!.present({ sessionToken: 'tok_hook', readyTimeout: 0, cancelOnDismiss: false });
    });
    await waitFor(() => screen.getByTestId('wajub-dismiss'));

    // Made visible while the other sheet is open: it waits, without a word.
    rerender(<View><Host ref={host} /><PaymentSheet visible session={new WajubSession('tok_waiting')} {...legacy} /></View>);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getAllByTestId('wajub-dismiss')).toHaveLength(1);
    expect(legacyCalls()).toBe(0);

    // The other one closes: it opens, and reports as usual.
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(first).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
    await waitFor(() => expect(legacyCalls()).toBeGreaterThan(0));
    await waitFor(() => screen.getByTestId('wajub-method-mobile_money'));
    expect(legacy.onDismiss).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    expect(legacy.onDismiss).toHaveBeenCalledTimes(1);
    expect(legacy.onResult).not.toHaveBeenCalled();
    screen.unmount();

    // Hidden again while it waits: it does not open later.
    const hidden = { onSubmit: jest.fn(), onDismiss: jest.fn(), onResult: jest.fn() };
    const hiddenCalls = () => api.calls.filter((c) => c.headers.Authorization === 'Bearer tok_hidden').length;
    const second = render(<View><Host ref={host} /></View>);
    let other!: Promise<CheckoutResult>;
    await act(async () => {
      other = host.current!.present({ sessionToken: 'tok_hook_2', readyTimeout: 0, cancelOnDismiss: false });
    });
    await waitFor(() => screen.getByTestId('wajub-dismiss'));
    second.rerender(<View><Host ref={host} /><PaymentSheet visible session={new WajubSession('tok_hidden')} {...hidden} /></View>);
    second.rerender(<View><Host ref={host} /><PaymentSheet visible={false} session={new WajubSession('tok_hidden')} {...hidden} /></View>);
    await act(async () => {
      fireEvent.press(screen.getByTestId('wajub-dismiss'));
    });
    await expect(other).resolves.toMatchObject({ status: 'cancelled' });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(hiddenCalls()).toBe(0);
    expect(screen.queryAllByTestId('wajub-dismiss')).toHaveLength(0);
  });
});
