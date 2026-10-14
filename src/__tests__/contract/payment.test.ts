import { AppState } from 'react-native';

import { cardFlavor } from '../../checkout/methods';
import { operatorChoices } from '../../mobileMoney/form';
import { makeController } from '../../test/checkout';
import { body, fakeApi, settle } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import type { PresentOptions, SdkFlavor } from '../../types';
import { parseSdkConfig } from '../../wire/parse';

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
});

const emit = (state: string) => (AppState as unknown as { emit(s: string): void }).emit(state);

function callbacks() {
  return {
    onStateChange: jest.fn(),
    onError: jest.fn(),
    onPaymentStarted: jest.fn(),
    onRedirect: jest.fn(),
    onSuccess: jest.fn(),
  };
}

async function sheet(routes: Record<string, Answer | Answer[]>, options: Partial<PresentOptions> = {}) {
  api = fakeApi({ 'GET /pay/status': 'status-processing', 'POST /pay/cancel': 'cancel-200', ...routes });
  const spies = callbacks();
  const { controller, openUrl } = makeController({ ...spies, ...options });
  controller.start();
  await settle();
  return { controller, openUrl, ...spies };
}

/** The CM sheet, Mobile Money chosen, MTN paying `process`. */
async function payMtn(process: Answer | Answer[], options: Partial<PresentOptions> = {}, session: Answer = 'session-cm-aggregate') {
  const s = await sheet({ 'GET /pay/session': session, 'GET /pay/sdk-config': 'sdk-config-cm-stripe', 'POST /pay/process': process }, options);
  s.controller.chooseMethod('mobile_money');
  const mtn = operatorChoices(s.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
  await s.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
  await settle();
  return s;
}

/** A card sheet whose sdk-config is `config`, paying `process`. */
async function payCard(config: string, process: Answer, fields: Record<string, string> = {}, session: Answer = 'session-cm-aggregate') {
  const s = await sheet({ 'GET /pay/session': session, 'GET /pay/sdk-config': config, 'POST /pay/process': process });
  s.controller.chooseMethod('card');
  await s.controller.payCard(fields);
  await settle();
  return s;
}

describe('CD — card', () => {
  it('CD-01 picks the card flavour', () => {
    const flavor = (name: string, sandbox = false) => cardFlavor(parseSdkConfig(body(name)).channels.card, sandbox);
    expect(flavor('sdk-config-card-paystack')).toBe('client_session');
    expect(flavor('sdk-config-card-adyen')).toBe('client_session');
    expect(flavor('sdk-config-cm-stripe')).toBe('stripe');
    expect(flavor('sdk-config-card-cinetpay')).toBe('hosted_redirect');
    expect(flavor('sdk-config-card-kkiapay')).toBe('hosted_redirect');
    expect(flavor('sdk-config-card-mollie')).toBe('hosted_redirect');
    expect(flavor('sdk-config-sandbox', true)).toBe('sandbox_form');
    // `form` in live, an Adyen or PSP-inline card without a client session, unknown values: hidden.
    expect(flavor('sdk-config-sandbox', false)).toBeNull();
    const adyen = parseSdkConfig(body('sdk-config-card-adyen')).channels.card;
    expect(cardFlavor({ ...adyen, client_session: false }, false)).toBeNull();
    // Values the 1.4 SdkFlavor type does not name still arrive from the API.
    expect(cardFlavor({ ...adyen, client_session: undefined, sdk: 'psp_inline' as SdkFlavor }, false)).toBeNull();
    expect(cardFlavor({ ...adyen, client_session: undefined, sdk: 'apple_pay' as SdkFlavor }, false)).toBeNull();
    expect(cardFlavor({ ...adyen, available: false }, false)).toBeNull();
    expect(cardFlavor(undefined, false)).toBeNull();
  });

  it('CD-02 collects hosted card required fields', async () => {
    const fields = { first_name: 'Awa', last_name: 'Ngono', email: 'awa.ngono@example.com', phone: '+2250701020304', address: 'Rue 12', city: 'Abidjan', country: 'ci', zip_code: '00225' };
    const s = await sheet({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-card-cinetpay', 'POST /pay/process': 'process-redirect-card-hosted' });
    s.controller.chooseMethod('card');
    const method = s.controller.getSnapshot().methods.find((m) => m.kind === 'card');
    expect(method?.kind === 'card' && method.fields).toEqual(['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'country', 'zip_code']);

    // One missing: stays, the field says so, nothing sent.
    await s.controller.payCard({ ...fields, city: '' });
    expect(s.controller.getSnapshot().fieldErrors).toEqual({ city: 'Ce champ est requis' });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);

    await s.controller.payCard(fields);
    await settle();
    const { channel, data } = api.callsTo('POST /pay/process')[0].body;
    expect(channel).toBe('card');
    expect({ ...data, _client: undefined }).toEqual({ ...fields, country: 'CI', _client: undefined });
    expect(s.openUrl).toHaveBeenCalledWith('https://checkout.psp.example/pay/abc123');
    s.controller.hostGone();
  });

  it('CD-03 never sends raw card data in live', async () => {
    // Live, sdk-config `form`: no card method at all.
    const live = await sheet({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-sandbox', 'POST /pay/process': 'process-422-raw-card-data-live' });
    expect(live.controller.getSnapshot().methods.some((m) => m.kind === 'card')).toBe(false);
    await live.controller.payCard({ 'card.number': '4242424242424242', cvv: '123' });
    // And a raw card number never leaves in live, whatever asks for it.
    const attempt = (live.controller as unknown as { runAttempt(c: string, m: string, d: object): Promise<void> }).runAttempt;
    await attempt.call(live.controller, 'card', 'card', { 'card.number': '4242424242424242', cvv: '123' });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    expect(live.controller.getSnapshot().banner?.code).toBe('raw_card_data_not_accepted');
    live.controller.hostGone();
    api.restore();

    // Sandbox: the test card form sends its fields.
    const sandbox = await payCard('sdk-config-sandbox', 'process-requires-3ds-sandbox', { 'card.number': '4000 0566 5566 5556', card_holder: 'Awa Ngono', expiry_month: '12', expiry_year: '30', cvv: '123' }, 'session-sandbox-cm');
    expect(api.callsTo('POST /pay/process')[0].body.data).toMatchObject({ 'card.number': '4000056655665556', cvv: '123' });
    sandbox.controller.hostGone();
  });
});

describe('WL — wallets', () => {
  it('WL-01 pays one-tap wallets', async () => {
    const s = await sheet({ 'GET /pay/session': 'session-ci-xof-wallets', 'GET /pay/sdk-config': 'sdk-config-ci-wallets', 'POST /pay/process': 'process-redirect-wallet-djamo' });
    expect(s.controller.getSnapshot().methods[0]).toMatchObject({ kind: 'wallet', slug: 'ci.djamo', label: 'Djamo' });
    s.controller.chooseMethod('ci.djamo');
    await s.controller.payWallet('ci.djamo');
    await settle();
    const sent = api.callsTo('POST /pay/process')[0].body;
    expect(sent).toEqual({ channel: 'ci.djamo', data: { _client: expect.any(Object) } });
    expect(s.onRedirect).toHaveBeenCalledWith({ url: 'https://djamo.ci/?type=payment_confirmation&id=abc', method: 'GET' });
    expect(s.openUrl).toHaveBeenCalledWith('https://djamo.ci/?type=payment_confirmation&id=abc');
    expect(s.controller.getSnapshot().state).toBe('PENDING');
    s.controller.hostGone();
  });

  it('WL-02 follows a wave redirect', async () => {
    const s = await sheet({ 'GET /pay/session': 'session-ci-xof-wallets', 'GET /pay/sdk-config': 'sdk-config-ci-wallets', 'POST /pay/process': 'process-redirect-wave' });
    s.controller.chooseMethod('mobile_money');
    const wave = operatorChoices(s.controller.getSnapshot().session!.channels, 'CI', 'en').find((c) => c.id === 'wave')!;
    // An Orange number on Wave: a wallet held whatever the operator takes it.
    await s.controller.payMobileMoney({ phone: '07 01 02 03 04', country: 'CI', choice: wave, pickedByHand: true });
    await settle();
    expect(api.callsTo('POST /pay/process')[0].body).toMatchObject({ channel: 'ci.wave', data: { phone: '+2250701020304', country: 'CI' } });
    expect(s.openUrl).toHaveBeenCalledWith('https://pay.wave.com/c/cos-1x2y3z?a=10000&c=XOF&m=Maquis');
    expect(s.controller.getSnapshot().screen).toMatchObject({ name: 'pending', url: 'https://pay.wave.com/c/cos-1x2y3z?a=10000&c=XOF&m=Maquis' });
    s.controller.hostGone();
  });
});

describe('PA — process answers', () => {
  it('PA-01 ignores message when deciding', async () => {
    // 200, succeeded, and a message that says to confirm on the phone.
    expect(body('process-succeeded-200').message).toMatch(/phone/);
    const s = await payMtn('process-succeeded-200');
    expect(s.controller.getSnapshot().state).toBe('SUCCESS');
    expect(s.onSuccess).toHaveBeenCalledWith(expect.objectContaining({ method: 'mobile_money', status: 'success' }));
    s.controller.hostGone();
  });

  it('PA-02 follows redirects', async () => {
    const hosted = await payCard('sdk-config-card-kkiapay', 'process-redirect-card-hosted', { email: 'awa.ngono@example.com' });
    expect(hosted.onRedirect).toHaveBeenCalledWith({ url: 'https://checkout.psp.example/pay/abc123', method: 'GET' });
    expect(hosted.onRedirect.mock.invocationCallOrder[0]).toBeLessThan(hosted.openUrl.mock.invocationCallOrder[0]);
    expect(hosted.controller.getSnapshot()).toMatchObject({ state: 'PENDING', screen: { name: 'pending', url: 'https://checkout.psp.example/pay/abc123' } });
    hosted.controller.hostGone();
    api.restore();

    // confirm_3ds with a URL: the bank's page, 3DS_REQUIRED while the browser is away, PENDING once back.
    const threeDs = body('process-redirect-card-hosted');
    threeDs.action = 'confirm_3ds';
    const s = await payCard('sdk-config-card-kkiapay', { status: 202, body: threeDs }, { email: 'awa.ngono@example.com' });
    expect(s.controller.getSnapshot().state).toBe('3DS_REQUIRED');
    emit('background');
    emit('active');
    expect(s.controller.getSnapshot().state).toBe('PENDING');
    s.controller.hostGone();
  });

  it('PA-03 maps unknown actions to unsupported_action', async () => {
    const unknown = body('process-requires-otp');
    unknown.action = 'card_reauth';
    const missing = body('process-requires-otp');
    delete missing.otp_id;
    for (const answer of [unknown, missing]) {
      const s = await payCard('sdk-config-card-kkiapay', { status: 202, body: answer }, { email: 'awa.ngono@example.com' });
      expect(s.controller.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { name: 'failed', error: { code: 'unsupported_action', retryable: false } } });
      expect(s.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported_action' }));
      s.controller.hostGone();
      api.restore();
    }
  });

  it('PA-04 maps declines', async () => {
    for (const name of ['process-failed-402', 'process-402-insufficient-funds-sandbox']) {
      const s = await payMtn(name);
      expect(s.controller.getSnapshot().screen).toMatchObject({
        name: 'failed',
        error: { code: 'insufficient_funds', decline_code: 'insufficient_funds', type: 'payment_error', retryable: true, message: 'Fonds insuffisants.' },
      });
      // "Try again": the form again, and the next Pay is a new attempt with a new key.
      s.controller.tryAgain();
      expect(s.controller.getSnapshot().state).toBe('COLLECTING_DETAILS');
      const mtn = operatorChoices(s.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
      await s.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      const [first, second] = api.callsTo('POST /pay/process');
      expect(second.headers['Idempotency-Key']).not.toBe(first.headers['Idempotency-Key']);
      s.controller.hostGone();
      api.restore();
    }
    const unverified = await payMtn('process-402-merchant-not-verified');
    expect(unverified.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'merchant_not_verified', retryable: false } });
    unverified.controller.hostGone();
  });

  it('PA-05 waits on a charge in progress', async () => {
    const s = await payMtn('process-409-payment-in-progress');
    expect(s.controller.getSnapshot().state).toBe('PENDING');
    expect(s.onError).not.toHaveBeenCalled();
    s.controller.dismiss();
    await expect(s.controller.result).resolves.toMatchObject({ status: 'processing' });
  });

  it('PA-06 maps validation errors to fields', async () => {
    const validation = await payMtn('process-422-validation');
    expect(validation.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', fieldErrors: { phone: 'Numéro de téléphone invalide' } });
    expect(validation.onError).not.toHaveBeenCalled();
    validation.controller.hostGone();
    api.restore();

    // An Orange number on cm.mtn (sandbox lets it through): the API's English
    // refusal becomes the SDK's own words.
    const operators = body('session-sandbox-cm');
    operators.channels = ['mtn', 'orange'].map((op) => ({ ...operators.channels[0], id: `cm.${op}`, slug: `cm.${op}`, logo: null }));
    const mismatch = await sheet(
      { 'GET /pay/session': { status: 200, body: operators }, 'GET /pay/sdk-config': 'sdk-config-sandbox', 'POST /pay/process': 'process-422-operator-mismatch' },
      { locale: 'en' },
    );
    mismatch.controller.chooseMethod('mobile_money');
    const mtn = operatorChoices(mismatch.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await mismatch.controller.payMobileMoney({ phone: '691234567', country: 'CM', choice: mtn, pickedByHand: true });
    await settle();
    expect(api.callsTo('POST /pay/process')[0].body.channel).toBe('cm.mtn');
    expect(mismatch.controller.getSnapshot().fieldErrors.phone).toBe(
      'This number belongs to Orange Money. Pick Orange Money in the list, or enter a MTN MoMo number.',
    );
    mismatch.controller.hostGone();
    api.restore();

    const testNumber = await payMtn('process-422-sandbox-invalid-test-number', {}, 'session-sandbox-cm');
    expect(testNumber.controller.getSnapshot().fieldErrors.phone).toBe('Numéro de téléphone invalide');
    testNumber.controller.hostGone();
    api.restore();

    // A refusal tied to no field: a banner, with the API's text in an English sheet.
    const limit = await payMtn('process-422-over-mobile-money-limit-sandbox', { locale: 'en' });
    expect(limit.controller.getSnapshot().banner?.message).toBe('This amount is above the limit for this payment method. Use a smaller amount or another method.');
    expect(limit.controller.getSnapshot().state).toBe('COLLECTING_DETAILS');
    limit.controller.hostGone();
  });

  it('PA-07 surfaces rate limits', async () => {
    const s = await payMtn('error-429-rate-limited', { locale: 'en' });
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    expect(s.controller.getSnapshot().screen).toMatchObject({
      name: 'failed',
      error: { code: 'rate_limited', type: 'rate_limit_error', retry_after_seconds: 300, retryable: true, message: 'Too many attempts. Please wait 300 s before trying again.' },
    });
    s.controller.hostGone();
  });

  it('PA-08 maps refusals', async () => {
    const shield = await payMtn('process-403-shield-blocked', { locale: 'en' });
    expect(shield.controller.getSnapshot().screen).toMatchObject({
      name: 'failed',
      error: { code: 'shield_blocked', block_reference: 'BLK-PLACEHOLDER', retryable: false, message: 'Payment blocked for security. Reference: BLK-PLACEHOLDER.' },
    });
    shield.controller.hostGone();
    api.restore();
    const restricted = await payMtn('process-403-restricted');
    expect(restricted.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'payment_method_restricted', type: 'payment_error' } });
    restricted.controller.hostGone();
    api.restore();
    // A 403 without a code during payment: a merchant restriction.
    const bare = await payMtn({ status: 403, body: { code: 403, status: 'Forbidden', message: 'Merchant account suspended.' } });
    expect(bare.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'merchant_restricted', retryable: false } });
    bare.controller.hostGone();
  });

  it('PA-09 handles ended sessions during payment', async () => {
    // 400: the status is read again — paid already.
    const paid = await sheet({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-cm-stripe', 'POST /pay/process': 'process-400-not-processable', 'GET /pay/status': 'status-succeeded' });
    paid.controller.chooseMethod('mobile_money');
    const mtn = operatorChoices(paid.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await paid.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle();
    expect(api.callsTo('GET /pay/status')).toHaveLength(1);
    expect(paid.controller.getSnapshot().state).toBe('SUCCESS');
    paid.controller.hostGone();
    api.restore();

    // While the status is read, Pay stays disabled: a second press sends nothing.
    let statusRead!: () => void;
    const reading = new Promise<void>((resolve) => (statusRead = resolve));
    const busy = await sheet({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-cm-stripe', 'POST /pay/process': 'process-400-not-processable', 'GET /pay/status': 'status-succeeded' });
    const realFetch = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pay/status')) await reading;
      return realFetch(url, init);
    });
    busy.controller.chooseMethod('mobile_money');
    const mtn400 = operatorChoices(busy.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    const paying = busy.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn400, pickedByHand: true });
    await settle();
    expect(busy.controller.getSnapshot()).toMatchObject({ busy: true, canCancel: false });
    await busy.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn400, pickedByHand: true });
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    statusRead();
    await paying;
    await settle();
    expect(busy.controller.getSnapshot()).toMatchObject({ state: 'SUCCESS', busy: false });
    busy.controller.hostGone();
    api.restore();

    // 400 and an attempt under way (`processing`): PENDING, watched — money may move.
    const running = await payMtn('process-400-not-processable');
    expect(running.controller.getSnapshot()).toMatchObject({ state: 'PENDING', screen: { name: 'pending' }, busy: false });
    running.controller.dismiss();
    await expect(running.controller.result).resolves.toMatchObject({ status: 'processing' });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
    api.restore();

    // 400 and a status neither ended nor processing: not_processable.
    const stuck = await sheet({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'process-400-not-processable',
      'GET /pay/status': { status: 200, body: { transaction: { reference: 'trx_PVrU8x2kQ1mNa7Lb3cDe', status: 'pending' } } },
    });
    stuck.controller.chooseMethod('mobile_money');
    const choice = operatorChoices(stuck.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await stuck.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
    await settle();
    expect(stuck.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'not_processable' } });
    stuck.controller.hostGone();
    api.restore();

    const ended = await payMtn('error-410-process-session-ended');
    expect(ended.controller.getSnapshot()).toMatchObject({ state: 'EXPIRED', screen: { name: 'expired', error: { code: 'session_terminal_expired' } } });
    ended.controller.hostGone();
  });

  it('PA-01 reads a 2xx without a transaction as an unknown outcome', async () => {
    const s = await payMtn({ status: 202, body: { code: 202, status: 'Accepted', message: 'Accepted.' } });
    // Watched, never a failure: the charge may be running.
    expect(s.controller.getSnapshot()).toMatchObject({ state: 'PENDING', screen: { name: 'pending' } });
    expect(s.onError).not.toHaveBeenCalled();
    s.controller.dismiss();
    await expect(s.controller.result).resolves.toMatchObject({ status: 'processing' });
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  it('PA-02 fires nothing after the sheet closed', async () => {
    // The browser answers only after the host went away: no failure is reported after onComplete.
    let opened!: (value: boolean) => void;
    const events: string[] = [];
    const s = await sheet(
      { 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-card-kkiapay', 'POST /pay/process': 'process-redirect-card-hosted' },
      { onError: () => events.push('error'), onComplete: (r) => events.push(`complete:${r.status}`) },
    );
    s.openUrl.mockImplementation(() => new Promise<boolean>((resolve) => (opened = resolve)));
    s.controller.chooseMethod('card');
    await s.controller.payCard({ email: 'awa.ngono@example.com' });
    await settle();
    s.controller.hostGone();
    opened(false);
    await settle();
    expect(events).toEqual(['complete:processing']);
  });

  it('PA-10 fires payment started on the first 2xx', async () => {
    const refused = await payMtn('process-422-validation');
    expect(refused.onPaymentStarted).not.toHaveBeenCalled();
    refused.controller.hostGone();
    api.restore();

    jest.useFakeTimers();
    const s = await payMtn('process-processing-mobile-money-sandbox');
    expect(s.onPaymentStarted).toHaveBeenCalledTimes(1);
    expect(s.onPaymentStarted).toHaveBeenCalledWith({ method: 'mobile_money', channel: 'cm.mobile' });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(s.onPaymentStarted).toHaveBeenCalledTimes(1);
    s.controller.hostGone();
  });
});

describe('RD — redirects', () => {
  it('RD-02 sends the return url only when given', async () => {
    const given = await payCard('sdk-config-card-kkiapay', 'process-redirect-wallet-djamo', { email: 'a@b.co' });
    expect(api.callsTo('POST /pay/process')[0].body.data.return_url).toBeUndefined();
    given.controller.hostGone();
    api.restore();

    const s = await sheet(
      { 'GET /pay/session': 'session-ci-xof-wallets', 'GET /pay/sdk-config': 'sdk-config-ci-wallets', 'POST /pay/process': 'process-redirect-wallet-djamo' },
      { returnUrl: 'https://shop.example.com/app-return' },
    );
    await s.controller.payWallet('ci.djamo');
    expect(api.callsTo('POST /pay/process')[0].body.data.return_url).toBe('https://shop.example.com/app-return');
    s.controller.hostGone();
    api.restore();

    const card = await sheet(
      { 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': 'sdk-config-card-paystack', 'POST /pay/client-session': 'client-session-start-202' },
      { returnUrl: 'https://shop.example.com/app-return' },
    );
    card.controller.chooseMethod('card');
    await card.controller.payCard({ email: 'chidi.okafor@example.com' });
    expect(api.callsTo('POST /pay/client-session')[0].body.return_url).toBe('https://shop.example.com/app-return');
    card.controller.hostGone();
  });

  it('RD-03 polls on return', async () => {
    const s = await payCard('sdk-config-card-kkiapay', 'process-redirect-card-hosted', { email: 'awa.ngono@example.com' });
    api.answer('GET /pay/status', 'status-succeeded');
    expect(api.callsTo('GET /pay/status')).toHaveLength(0);
    // The payer leaves for the browser, then comes back: the status is read at once.
    emit('background');
    emit('active');
    await settle();
    expect(api.callsTo('GET /pay/status')).toHaveLength(1);
    expect(s.controller.getSnapshot().state).toBe('SUCCESS');
    s.controller.hostGone();
  });
});

describe('CS — client sessions', () => {
  async function clientSession(start: Answer, complete: Answer = 'client-session-complete-202') {
    const s = await sheet({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-card-paystack',
      'POST /pay/client-session': start,
      'POST /pay/client-session/complete': complete,
    });
    s.controller.chooseMethod('card');
    await s.controller.payCard({ email: 'chidi.okafor@example.com' });
    await settle();
    return s;
  }

  it('CS-01 opens a client session', async () => {
    for (const name of ['client-session-start-202', 'client-session-start-202-flutterwave', 'client-session-start-reserved']) {
      const s = await clientSession(name);
      const sent = api.callsTo('POST /pay/client-session')[0].body;
      expect(sent).toMatchObject({ channel: 'card', email: 'chidi.okafor@example.com' });
      expect(sent).not.toHaveProperty('inline');
      const url = body(name).client_session.hosted_url;
      expect(s.onPaymentStarted).toHaveBeenCalledWith({ method: 'card', channel: 'card' });
      expect(s.onRedirect).toHaveBeenCalledWith({ url, method: 'GET' });
      expect(s.openUrl).toHaveBeenCalledWith(url);
      expect(s.controller.getSnapshot()).toMatchObject({ state: 'PENDING', screen: { name: 'pending', url } });
      s.controller.hostGone();
      api.restore();
    }
  });

  it('CS-02 completes a client session', async () => {
    const back = async () => {
      emit('background');
      emit('active');
      await settle();
    };
    const paid = await clientSession('client-session-start-202', 'client-session-complete-200');
    // The PSP's webhook got there too: the poll on return says succeeded as well — one success.
    api.answer('GET /pay/status', 'status-succeeded');
    await back();
    expect(api.callsTo('POST /pay/client-session/complete')[0].body).toEqual({ client_session_id: 'prc_7hQm2LxV9pR4sT1wYb3N' });
    expect(api.callsTo('GET /pay/status')).toHaveLength(1);
    expect(paid.controller.getSnapshot().state).toBe('SUCCESS');
    expect(paid.onSuccess).toHaveBeenCalledTimes(1);
    paid.controller.hostGone();
    api.restore();

    const notYet = await clientSession('client-session-start-202', 'client-session-complete-202');
    await back();
    expect(notYet.controller.getSnapshot().state).toBe('PENDING');
    notYet.controller.hostGone();
    api.restore();

    const declined = await clientSession('client-session-start-202', 'client-session-complete-402');
    await back();
    expect(declined.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { decline_code: 'failed', retryable: true } });
    declined.controller.hostGone();
    api.restore();

    const expired = await clientSession('client-session-start-202', 'client-session-complete-422-expired');
    await back();
    expect(expired.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'client_session_expired', retryable: true } });
    // Starting again replaces the session that died at the PSP.
    expired.controller.tryAgain();
    await expired.controller.payCard({ email: 'chidi.okafor@example.com' });
    const [first, second] = api.callsTo('POST /pay/client-session').map((c) => c.body);
    expect(first.restart).toBeUndefined();
    expect(second.restart).toBe(true);
    expired.controller.hostGone();
  });

  it('CS-03 reports client sessions unavailable in sandbox', async () => {
    const s = await clientSession('client-session-422-sandbox');
    expect(api.callsTo('POST /pay/client-session')).toHaveLength(1);
    expect(s.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', banner: { code: 'client_session_unavailable', retryable: false } });
    expect(s.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'client_session_unavailable' }));
    s.controller.hostGone();
  });
});
