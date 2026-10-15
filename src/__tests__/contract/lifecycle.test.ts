import { AppState } from 'react-native';

import { operatorChoices } from '../../mobileMoney/form';
import { makeController } from '../../test/checkout';
import { body, fakeApi, settle } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import type { CheckoutState, PresentOptions } from '../../types';

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const STATES: CheckoutState[] = [
  'INITIATED', 'COLLECTING_DETAILS', 'PROCESSING', 'OTP_REQUIRED', 'PIN_REQUIRED', 'PHONE_REQUIRED', 'BIRTHDAY_REQUIRED',
  'ADDRESS_REQUIRED', '3DS_REQUIRED', 'USSD_REQUIRED', 'APPROVAL_REQUIRED', 'VERIFYING', 'PENDING', 'SUCCESS', 'FAILED',
  'EXPIRED', 'CANCELLED',
];

/** Records every callback, in order. */
function recorder() {
  const events: string[] = [];
  const record =
    (name: string, detail?: (arg: never) => string) =>
    (arg: never) =>
      events.push(detail ? `${name}:${detail(arg)}` : name);
  const options: Partial<PresentOptions> = {
    onReady: record('ready'),
    onStateChange: record('state', (e: { state: string }) => e.state),
    onLoadError: record('loadError', (e: { code: string }) => e.code),
    onPaymentStarted: record('paymentStarted'),
    onRedirect: record('redirect'),
    onSuccess: record('success'),
    onError: record('error', (e: { code: string }) => e.code),
    onCancel: record('cancel', (e: { reason: string }) => e.reason),
    onComplete: record('complete', (r: { status: string }) => r.status),
  };
  return { events, options };
}

async function sheet(routes: Record<string, Answer | Answer[]>, options: Partial<PresentOptions> = {}) {
  api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-cm-stripe', 'POST /pay/cancel': 'cancel-200', ...routes });
  const { controller, openUrl } = makeController(options);
  controller.start();
  await settle();
  return { controller, openUrl };
}

async function payMtn(controller: ReturnType<typeof makeController>['controller']) {
  controller.chooseMethod('mobile_money');
  const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
  await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
  await settle();
}

describe('CN — cancel and dismiss', () => {
  it('CN-01 cancels on request', async () => {
    const { events, options } = recorder();
    const { controller } = await sheet({}, options);
    expect(controller.getSnapshot().canCancel).toBe(true);
    await controller.cancelPayment();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
    const result = await controller.result;
    expect(result).toEqual({ status: 'cancelled', reason: 'payer_cancelled', redirectUrl: body('cancel-200').redirect_url, cancelled: true });
    expect(events.slice(-2)).toEqual(['cancel:payer_cancelled', 'complete:cancelled']);
  });

  it('CN-01 takes nothing while the cancel runs', async () => {
    for (const refused of [false, true]) {
      // The cancel (or, once refused, the status read that follows) has not answered yet.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const { events, options } = recorder();
      const { controller } = await sheet(
        {
          'POST /pay/cancel': refused ? 'cancel-400-not-cancellable' : 'cancel-200',
          'GET /pay/status': { status: 200, body: { transaction: { reference: 'CMD-4172', status: 'cancelled' } } },
          'POST /pay/process': 'process-processing-mobile-money-live',
        },
        options,
      );
      const realFetch = api.fetch.getMockImplementation()!;
      api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith(refused ? '/pay/status' : '/pay/cancel')) await held;
        return realFetch(url, init);
      });
      controller.chooseMethod('mobile_money');
      const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
      const cancelling = controller.cancelPayment();
      await settle();
      expect(controller.getSnapshot()).toMatchObject({ cancelling: true, busy: true });

      // Pay, X, Cancel again, another method, Stripe's button: all ignored.
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      controller.beginCardPayment();
      controller.backToMethods();
      controller.chooseMethod('card');
      controller.dismiss();
      await controller.cancelPayment();
      await settle();
      // Every request, answered or not.
      const sent = (path: string) => api.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
      expect(sent('/pay/process')).toBe(0);
      expect(sent('/pay/cancel')).toBe(1);
      expect(controller.getSnapshot()).toMatchObject({ cancelling: true, state: 'COLLECTING_DETAILS', screen: { name: 'form', method: { kind: 'mobile_money' } } });
      expect(controller.closed).toBe(false);

      release();
      await cancelling;
      await settle();
      await expect(controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'payer_cancelled' });
      expect(events.filter((e) => e.startsWith('paymentStarted'))).toHaveLength(0);
      api.restore();
    }

    // The cancel a dismiss sends: the sheet is hidden, and still takes nothing until it settles.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { controller } = await sheet({ 'POST /pay/process': 'process-processing-mobile-money-live', 'POST /pay/client-session': 'client-session-start-202' });
    const realFetch = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pay/cancel')) await held;
      return realFetch(url, init);
    });
    controller.chooseMethod('mobile_money');
    const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    controller.dismiss();
    expect(controller.getSnapshot()).toMatchObject({ visible: false, cancelling: true });
    await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    controller.beginCardPayment();
    await controller.payStripe('pm_late');
    await controller.cancelPayment();
    await settle();
    const sent = (path: string) => api.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)).length;
    expect(sent('/pay/process')).toBe(0);
    expect(sent('/pay/cancel')).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', busy: false });
    release();
    await expect(controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
    expect(sent('/pay/process')).toBe(0);
  });

  it('CN-02 cancels on dismiss before any attempt', async () => {
    const dismissed = await sheet({});
    dismissed.controller.dismiss();
    expect(dismissed.controller.getSnapshot().visible).toBe(false);
    await expect(dismissed.controller.result).resolves.toEqual({
      status: 'cancelled',
      reason: 'dismissed',
      redirectUrl: body('cancel-200').redirect_url,
      cancelled: true,
    });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
    api.restore();

    // A failed cancel changes nothing for the payer.
    const failing = await sheet({ 'POST /pay/cancel': 'network' });
    failing.controller.dismiss();
    await expect(failing.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed', redirectUrl: null });
    api.restore();

    const kept = await sheet({}, { cancelOnDismiss: false });
    kept.controller.dismiss();
    await expect(kept.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed', redirectUrl: null });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // Closed while the payment is still loading: nothing is known of it, so nothing is cancelled blind.
    const loading = await sheet({ 'GET /pay/session': 'hang' });
    loading.controller.dismiss();
    await expect(loading.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed', redirectUrl: null });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('CN-02 releases the order when the payer closes a failure', async () => {
    // A decline: the failure screen, the payment `pending` again.
    const { events, options } = recorder();
    const declined = await sheet({ 'POST /pay/process': 'process-402-insufficient-funds-sandbox' }, options);
    await payMtn(declined.controller);
    const shown = declined.controller.getSnapshot().screen;
    expect(shown).toMatchObject({ name: 'failed', error: { decline_code: 'insufficient_funds' } });
    declined.controller.dismiss();
    // `failed`, with the error the payer saw; the cancel goes too, and onCancel does not fire.
    await expect(declined.controller.result).resolves.toMatchObject({ status: 'failed', error: shown.name === 'failed' ? { code: shown.error.code } : {} });
    await settle();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('cancel'))).toEqual([]);
    expect(events.slice(-1)).toEqual(['complete:failed']);
    api.restore();

    // With cancelOnDismiss: false, nothing is cancelled.
    const kept = await sheet({ 'POST /pay/process': 'process-402-insufficient-funds-sandbox' }, { cancelOnDismiss: false });
    await payMtn(kept.controller);
    kept.controller.dismiss();
    await expect(kept.controller.result).resolves.toMatchObject({ status: 'failed' });
    await settle();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // A payment that ended (`failed` status): nothing to release, no call.
    jest.useFakeTimers();
    const ended = await sheet({
      'POST /pay/process': 'process-processing-mobile-money-live',
      'GET /pay/status': { status: 200, body: { transaction: { reference: 'CMD-4172', status: 'failed' } } },
    });
    await payMtn(ended.controller);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(ended.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'payment_failed' } });
    ended.controller.dismiss();
    await expect(ended.controller.result).resolves.toMatchObject({ status: 'failed', error: { code: 'payment_failed' } });
    await settle();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();
    jest.useRealTimers();

    // "Try again", then closed on the form: a dismiss before any attempt.
    const again = await sheet({ 'POST /pay/process': 'process-402-insufficient-funds-sandbox' });
    await payMtn(again.controller);
    again.controller.tryAgain();
    again.controller.dismiss();
    await expect(again.controller.result).resolves.toEqual({
      status: 'cancelled',
      reason: 'dismissed',
      redirectUrl: body('cancel-200').redirect_url,
      cancelled: true,
    });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
  });

  it('CN-03 dismiss after start resolves processing', async () => {
    jest.useFakeTimers();
    const { events, options } = recorder();
    const { controller } = await sheet({ 'POST /pay/process': 'process-processing-mobile-money-sandbox', 'GET /pay/status': 'status-processing' }, options);
    await payMtn(controller);
    expect(events).toContain('paymentStarted');
    expect(controller.getSnapshot().canCancel).toBe(false);
    controller.dismiss();
    await expect(controller.result).resolves.toMatchObject({
      status: 'processing',
      transaction: { id: 'trx_test_PVrU8x2kQ1mNa7Lb3cDe' },
      instruction: body('process-processing-mobile-money-sandbox').transaction.processing_context.payer_instruction,
    });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // Stripe: the attempt is under way from the Pay press, while Stripe creates the PaymentMethod.
    jest.useRealTimers();
    const stripe = await sheet({ 'POST /pay/process': 'process-succeeded-200' });
    stripe.controller.chooseMethod('card');
    stripe.controller.beginCardPayment();
    expect(stripe.controller.getSnapshot()).toMatchObject({ state: 'PROCESSING', busy: true, canCancel: false });
    stripe.controller.dismiss();
    await expect(stripe.controller.result).resolves.toMatchObject({ status: 'processing' });
    // The PaymentMethod arrives after the sheet closed: nothing is charged.
    await stripe.controller.payStripe('pm_late');
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // Stripe refused the card: back to the form, and a dismiss then cancels as before any attempt.
    const refused = await sheet({});
    refused.controller.chooseMethod('card');
    refused.controller.beginCardPayment();
    refused.controller.cardPaymentFailed();
    expect(refused.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', busy: false, canCancel: true });
    refused.controller.dismiss();
    await expect(refused.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed' });
  });

  it('CN-04 handles a refused cancel', async () => {
    const { controller } = await sheet({ 'POST /pay/cancel': 'cancel-400-not-cancellable', 'GET /pay/status': 'status-succeeded' });
    await controller.cancelPayment();
    await settle();
    expect(api.callsTo('GET /pay/status')).toHaveLength(1);
    // Paid already: the success, then `complete`.
    expect(controller.getSnapshot().state).toBe('SUCCESS');
    controller.dismiss();
    await expect(controller.result).resolves.toMatchObject({ status: 'complete' });
    api.restore();

    const viaDismiss = await sheet({ 'POST /pay/cancel': 'cancel-400-not-cancellable', 'GET /pay/status': 'status-succeeded' });
    viaDismiss.controller.dismiss();
    await expect(viaDismiss.controller.result).resolves.toMatchObject({ status: 'complete', payment: { status: 'success' } });
    api.restore();

    // Refused, and the status cannot be read: the payment may be under way — processing, not cancelled.
    for (const close of ['cancelPayment', 'dismiss'] as const) {
      const unknown = await sheet({ 'POST /pay/cancel': 'cancel-400-not-cancellable', 'GET /pay/status': 'network' });
      await unknown.controller[close]();
      await expect(unknown.controller.result).resolves.toMatchObject({ status: 'processing', transaction: { id: 'trx_PVrU8x2kQ1mNa7Lb3cDe' } });
      api.restore();
    }
  });
});

describe('CN — what may be cancelled', () => {
  it('CN-04 never cancels a payment that may be under way', async () => {
    // The session answered, sdk-config has not: its status decides a dismiss at once.
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ['session-processing-mobile-money', { status: 'processing', transaction: { status: 'processing' } }, 0],
      ['session-terminal-succeeded', { status: 'complete', payment: { method: 'unknown' } }, 0],
      ['session-terminal-failed', { status: 'failed', error: { code: 'session_terminal_failed' } }, 0],
      ['session-cm-aggregate', { status: 'cancelled', reason: 'dismissed', redirectUrl: body('cancel-200').redirect_url }, 1],
    ];
    for (const [session, result, cancels] of cases) {
      const { controller } = await sheet({ 'GET /pay/session': session, 'GET /pay/sdk-config': 'hang' });
      expect(controller.getSnapshot().screen.name).toBe('loading');
      controller.dismiss();
      await expect(controller.result).resolves.toMatchObject(result);
      expect([session, api.callsTo('POST /pay/cancel').length]).toEqual([session, cancels]);
      api.restore();
    }
    // The host going away there: the same, never a call.
    const gone = await sheet({ 'GET /pay/session': 'session-processing-mobile-money', 'GET /pay/sdk-config': 'hang' });
    gone.controller.hostGone();
    await expect(gone.controller.result).resolves.toMatchObject({ status: 'processing' });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // An attempt is undecided from its request to a definitive answer: no "Cancel payment", a dismiss calls nothing.
    jest.useFakeTimers();
    const refused = await sheet({
      'POST /pay/process': 'process-processing-mobile-money-live',
      'GET /pay/status': 'status-pending-attempt-refused',
    });
    await payMtn(refused.controller);
    expect(refused.controller.getSnapshot()).toMatchObject({ state: 'APPROVAL_REQUIRED', canCancel: false });
    await refused.controller.cancelPayment();
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    // Refused (`pending` with a new error_code, after it was seen processing): pending again —
    // "Cancel payment" is back, and a dismiss cancels as before any attempt.
    await jest.advanceTimersByTimeAsync(5_000);
    expect(refused.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { retryable: true } });
    refused.controller.tryAgain();
    expect(refused.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', canCancel: true });
    refused.controller.dismiss();
    await expect(refused.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'dismissed', redirectUrl: body('cancel-200').redirect_url });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
    api.restore();

    // A step that fails for good is a definitive refusal too.
    const step = await sheet({
      'GET /pay/sdk-config': 'sdk-config-card-kkiapay',
      'POST /pay/process': 'process-requires-otp',
      'POST /pay/otp/verify': 'otp-verify-max-attempts',
      'GET /pay/status': 'status-processing',
    });
    step.controller.chooseMethod('card');
    await step.controller.payCard({ email: 'awa.ngono@example.com' });
    await settle();
    expect(step.controller.getSnapshot()).toMatchObject({ state: 'OTP_REQUIRED', canCancel: false });
    await step.controller.submitStep({ code: '000000' });
    step.controller.tryAgain();
    expect(step.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', canCancel: true });
    step.controller.hostGone();
    api.restore();
    jest.useRealTimers();

    // A decline answered at once never ran: the payment can still be cancelled.
    const declined = await sheet({ 'POST /pay/process': 'process-402-insufficient-funds-sandbox' });
    await payMtn(declined.controller);
    declined.controller.tryAgain();
    expect(declined.controller.getSnapshot().canCancel).toBe(true);
    await declined.controller.cancelPayment();
    await expect(declined.controller.result).resolves.toMatchObject({ status: 'cancelled', reason: 'payer_cancelled' });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(1);
  });
});

describe('ST — states, callbacks, results', () => {
  it('ST-01 reports Wajub.js states', async () => {
    const seen: string[] = [];
    const flows: Array<[string, string, string]> = [
      ['process-processing-mobile-money-sandbox', 'sdk-config-cm-stripe', 'APPROVAL_REQUIRED'],
      ['process-requires-otp', 'sdk-config-card-kkiapay', 'OTP_REQUIRED'],
      ['process-redirect-card-hosted', 'sdk-config-card-kkiapay', 'PENDING'],
    ];
    for (const [process, config, expected] of flows) {
      const { controller } = await sheet(
        { 'GET /pay/sdk-config': config, 'POST /pay/process': process, 'GET /pay/status': 'status-processing' },
        { onStateChange: ({ state }) => seen.push(state) },
      );
      if (config === 'sdk-config-cm-stripe') await payMtn(controller);
      else {
        controller.chooseMethod('card');
        await controller.payCard({ email: 'a@b.co' });
        await settle();
      }
      expect(controller.getSnapshot().state).toBe(expected);
      controller.hostGone();
      api.restore();
    }
    expect(seen.every((s) => STATES.includes(s as CheckoutState))).toBe(true);
    expect(seen).toEqual(expect.arrayContaining(['INITIATED', 'COLLECTING_DETAILS', 'PROCESSING', 'APPROVAL_REQUIRED', 'OTP_REQUIRED', 'PENDING']));
  });

  it('ST-02 fires callbacks in order', async () => {
    jest.useFakeTimers();
    const { events, options } = recorder();
    const { controller } = await sheet(
      { 'POST /pay/process': 'process-processing-mobile-money-sandbox', 'GET /pay/status': ['status-processing', 'status-succeeded'] },
      { ...options, autoCloseSuccess: 3000 },
    );
    await payMtn(controller);
    await jest.advanceTimersByTimeAsync(10_000);
    await settle();
    await jest.advanceTimersByTimeAsync(3_000);
    await controller.result;
    expect(events).toEqual([
      'ready',
      'state:INITIATED',
      'state:COLLECTING_DETAILS',
      'state:PROCESSING',
      'paymentStarted',
      'state:APPROVAL_REQUIRED',
      'state:SUCCESS',
      'success',
      'complete:complete',
    ]);
  });

  it('ST-03 resolves present once', async () => {
    const onComplete = jest.fn();
    const { controller } = await sheet({}, { onComplete, cancelOnDismiss: false });
    controller.dismiss();
    controller.dismiss();
    controller.hostGone();
    await controller.cancelPayment();
    const first = await controller.result;
    expect(await controller.result).toBe(first);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(first);
  });

  it('ST-04 settles when the host goes away', async () => {
    const before = await sheet({});
    before.controller.hostGone();
    await expect(before.controller.result).resolves.toEqual({ status: 'cancelled', reason: 'host_gone', redirectUrl: null, cancelled: true });
    api.restore();

    jest.useFakeTimers();
    const during = await sheet({ 'POST /pay/process': 'process-processing-mobile-money-sandbox', 'GET /pay/status': 'status-processing' });
    await payMtn(during.controller);
    during.controller.hostGone();
    await expect(during.controller.result).resolves.toMatchObject({ status: 'processing' });
    const polls = api.callsTo('GET /pay/status').length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo('GET /pay/status')).toHaveLength(polls);
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    const after = await sheet({ 'POST /pay/process': 'process-succeeded-200' });
    await payMtn(after.controller);
    after.controller.hostGone();
    await expect(after.controller.result).resolves.toMatchObject({ status: 'complete' });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('ST-06 builds PaymentSuccess', async () => {
    const { controller } = await sheet({ 'GET /pay/sdk-config': 'sdk-config-card-paystack', 'POST /pay/client-session': 'client-session-start-202', 'POST /pay/client-session/complete': 'client-session-complete-200' });
    controller.chooseMethod('card');
    await controller.payCard({ email: 'chidi.okafor@example.com' });
    await settle();
    // Back from the PSP's page.
    const app = AppState as unknown as { emit(s: string): void };
    app.emit('background');
    app.emit('active');
    await settle();
    controller.dismiss();
    const result = await controller.result;
    const paid = body('client-session-complete-200').transaction;
    expect(result).toMatchObject({
      status: 'complete',
      payment: {
        id: paid.id,
        reference: paid.reference,
        amount: paid.amount_total,
        currency: paid.currency,
        method: 'card',
        status: 'success',
        timestamp: paid.terminal_at,
        receipt_url: paid.receipt_url,
      },
    });
    api.restore();

    // The payer bears the fee: the amount is what they paid, the session's amount_total (10 350 for 10 000).
    const session = body('session-payer-bears-fee');
    const paidWithFee = { ...body('process-succeeded-200'), transaction: { ...session.transaction, status: 'succeeded' } };
    const fee = await sheet({ 'GET /pay/session': { status: 200, body: session }, 'POST /pay/process': { status: 200, body: paidWithFee } });
    await payMtn(fee.controller);
    fee.controller.dismiss();
    const withFee = await fee.controller.result;
    expect(withFee).toMatchObject({ status: 'complete', payment: { amount: 10350, currency: 'XAF', method: 'mobile_money' } });
    expect(session.transaction.amount).toBe(10000);
  });

  it('ST-07 survives throwing callbacks', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = () => {
      throw new Error('host bug');
    };
    const { controller } = await sheet(
      { 'POST /pay/process': 'process-succeeded-200' },
      { onReady: boom, onStateChange: boom, onPaymentStarted: boom, onSuccess: boom, onComplete: boom },
    );
    await payMtn(controller);
    expect(controller.getSnapshot().state).toBe('SUCCESS');
    controller.dismiss();
    await expect(controller.result).resolves.toMatchObject({ status: 'complete' });
    expect(warn).toHaveBeenCalled();
  });
});
