import { makeController } from '../../test/checkout';
import { body, fakeApi, settle } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import type { ConfirmStepKind } from '../../types';

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
});

/** A card payment (hosted page, Kkiapay) whose /pay/process answers `process`, then the step's endpoints. */
async function step(process: string, routes: Record<string, Answer | Answer[]> = {}, options = {}) {
  api = fakeApi({
    'GET /pay/session': 'session-cm-aggregate',
    'GET /pay/sdk-config': 'sdk-config-card-kkiapay',
    'POST /pay/process': process,
    'GET /pay/status': 'status-processing',
    ...routes,
  });
  const onStateChange = jest.fn();
  const onError = jest.fn();
  const { controller } = makeController({ onStateChange, onError, ...options });
  controller.start();
  await settle();
  controller.chooseMethod('card');
  await controller.payCard({ email: 'awa.ngono@example.com' });
  await settle();
  return { controller, onStateChange, onError };
}

const STEPS: Array<[ConfirmStepKind, string, Record<string, string>, Record<string, string>]> = [
  ['otp', 'OTP_REQUIRED', { code: '123456' }, { otp_id: 'prc_7hQm2LxV9pR4sT1wYb3N', code: '123456' }],
  ['pin', 'PIN_REQUIRED', { pin: '1234' }, { pin_id: 'prc_7hQm2LxV9pR4sT1wYb3N', pin: '1234' }],
  ['phone', 'PHONE_REQUIRED', { phone: '08012345678' }, { phone_id: 'prc_7hQm2LxV9pR4sT1wYb3N', phone: '08012345678' }],
  ['birthday', 'BIRTHDAY_REQUIRED', { birthday: '1990-04-21' }, { birthday_id: 'prc_7hQm2LxV9pR4sT1wYb3N', birthday: '1990-04-21' }],
  [
    'address',
    'ADDRESS_REQUIRED',
    { address: '12 Admiralty Way', city: 'Lagos', state: 'Lagos', zip_code: '101233' },
    { address_id: 'prc_7hQm2LxV9pR4sT1wYb3N', address: '12 Admiralty Way', city: 'Lagos', state: 'Lagos', zip_code: '101233' },
  ],
];

describe('CF — confirmation steps', () => {
  it('CF-01 opens each confirmation step', async () => {
    for (const [kind, state, values, sent] of STEPS) {
      const { controller, onStateChange } = await step(`process-requires-${kind}`, { [`POST /pay/${kind}/verify`]: `${kind}-verify-success` });
      const raw = body(`process-requires-${kind}`);
      expect(controller.getSnapshot()).toMatchObject({
        state,
        screen: { name: 'step', step: { kind, id: 'prc_7hQm2LxV9pR4sT1wYb3N', hint: kind === 'otp' ? raw.otp_masked_contact : raw[`${kind}_instruction`] } },
      });
      expect(onStateChange).toHaveBeenCalledWith({ state, method: 'card' });

      await controller.submitStep(values);
      expect(api.callsTo(`POST /pay/${kind}/verify`)[0].body).toEqual(sent);
      controller.hostGone();
      api.restore();
    }
  });

  it('CF-02 reads the transaction after a step', async () => {
    jest.useFakeTimers();
    for (const [kind, , values] of STEPS) {
      const { controller, onStateChange } = await step(`process-requires-${kind}`, { [`POST /pay/${kind}/verify`]: `${kind}-verify-success` });
      await controller.submitStep(values);
      await settle();
      // `success` with a transaction still processing: PENDING, and the watch goes on.
      expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'VERIFYING' }));
      expect(controller.getSnapshot().state).toBe('PENDING');
      api.answer('GET /pay/status', 'status-succeeded');
      await jest.advanceTimersByTimeAsync(5000);
      await settle();
      expect(controller.getSnapshot().state).toBe('SUCCESS');
      controller.hostGone();
      api.restore();
    }

    // A `success` already succeeded: SUCCESS at once.
    const paid = body('otp-verify-success');
    paid.transaction.status = 'succeeded';
    const { controller } = await step('process-requires-otp', { 'POST /pay/otp/verify': { status: 200, body: paid } });
    await controller.submitStep({ code: '123456' });
    expect(controller.getSnapshot().state).toBe('SUCCESS');
    controller.hostGone();
  });

  it('CF-03 handles step refusals', async () => {
    const otp = await step('process-requires-otp', { 'POST /pay/otp/verify': 'otp-verify-invalid' }, { locale: 'en' });
    await otp.controller.submitStep({ code: '000000' });
    expect(otp.controller.getSnapshot()).toMatchObject({ state: 'OTP_REQUIRED', screen: { name: 'step', step: { error: 'Incorrect code. 2 attempts left.' } } });
    otp.controller.hostGone();
    api.restore();

    const pin = await step('process-requires-pin', { 'POST /pay/pin/verify': 'pin-verify-invalid' });
    await pin.controller.submitStep({ pin: '0000' });
    expect(pin.controller.getSnapshot()).toMatchObject({ state: 'PIN_REQUIRED', screen: { step: { error: 'Code PIN incorrect. Encore 2 essais.' } } });
    pin.controller.hostGone();
    api.restore();

    for (const [name, code] of [
      ['otp-verify-max-attempts', 'max_attempts_exceeded'],
      ['otp-verify-expired', 'otp_expired'],
    ]) {
      const s = await step('process-requires-otp', { 'POST /pay/otp/verify': name });
      await s.controller.submitStep({ code: '000000' });
      expect(s.controller.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { name: 'failed', error: { code, retryable: true } } });
      // Retryable: the payer starts again from the method's form.
      s.controller.tryAgain();
      expect(s.controller.getSnapshot().state).toBe('COLLECTING_DETAILS');
      s.controller.hostGone();
      api.restore();
    }
  });

  it('CF-03 treats a 5xx or no answer on a verify like a network failure', async () => {
    for (const failure of [{ status: 500 }, { status: 503 }, 'error-500-production', 'network'] as Answer[]) {
      const { controller, onStateChange } = await step('process-requires-otp', { 'POST /pay/otp/verify': [failure, 'otp-verify-success'] });
      const polls = api.callsTo('GET /pay/status').length;
      await controller.submitStep({ code: '123456' });
      await settle();
      // Not a failure: the same step, the payer may submit again, and the status is read at once.
      expect(controller.getSnapshot()).toMatchObject({ state: 'OTP_REQUIRED', busy: false, screen: { name: 'step', step: { kind: 'otp' } } });
      expect(onStateChange).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'FAILED' }));
      expect(api.callsTo('POST /pay/otp/verify')).toHaveLength(1);
      expect(api.callsTo('GET /pay/status').length).toBeGreaterThan(polls);
      await controller.submitStep({ code: '123456' });
      expect(api.callsTo('POST /pay/otp/verify')).toHaveLength(2);
      expect(controller.getSnapshot().state).toBe('PENDING');
      controller.hostGone();
      api.restore();
    }

    // The status the poll reads decides: paid meanwhile.
    const paid = await step('process-requires-otp', { 'POST /pay/otp/verify': { status: 502 }, 'GET /pay/status': 'status-processing' });
    api.answer('GET /pay/status', 'status-succeeded');
    await paid.controller.submitStep({ code: '123456' });
    await settle();
    expect(paid.controller.getSnapshot().state).toBe('SUCCESS');
    paid.controller.hostGone();
  });

  it('CF-04 shows step validation errors', async () => {
    const address = await step('process-requires-address', { 'POST /pay/address/verify': 'address-verify-422-missing-fields' }, { locale: 'en' });
    await address.controller.submitStep({ address: '12 Admiralty Way', city: 'Lagos', state: 'Lagos', zip_code: '101233' });
    expect(address.controller.getSnapshot()).toMatchObject({
      state: 'ADDRESS_REQUIRED',
      fieldErrors: { city: 'The city field is required.', state: 'The state field is required.', zip_code: 'The zip code field is required.' },
    });
    address.controller.hostGone();
    api.restore();

    const birthday = await step('process-requires-birthday', { 'POST /pay/birthday/verify': 'birthday-verify-422-format' }, { locale: 'en' });
    await birthday.controller.submitStep({ birthday: '1990-04-21' });
    expect(birthday.controller.getSnapshot()).toMatchObject({ state: 'BIRTHDAY_REQUIRED', fieldErrors: { birthday: 'The birthday field must match the format Y-m-d.' } });
    // The same check, before sending: nothing goes out.
    await birthday.controller.submitStep({ birthday: '21/04/1990' });
    expect(api.callsTo('POST /pay/birthday/verify')).toHaveLength(1);
    birthday.controller.hostGone();
  });

  it('CF-05 resends after the countdown', async () => {
    jest.useFakeTimers();
    const { controller } = await step('process-requires-otp', { 'POST /pay/otp/resend': 'otp-resend-200' });
    const screen = controller.getSnapshot().screen;
    expect(screen.name === 'step' && screen.step.resendAt - Date.now()).toBe(60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    await controller.resendStep();
    expect(api.callsTo('POST /pay/otp/resend')[0].body).toEqual({ otp_id: 'prc_7hQm2LxV9pR4sT1wYb3N' });
    // The countdown starts over.
    const after = controller.getSnapshot().screen;
    expect(after.name === 'step' && after.step.resendAt - Date.now()).toBe(60_000);

    // Not while a code is being verified: its answer still lands on this screen.
    api.answer('POST /pay/otp/verify', 'otp-verify-invalid');
    await jest.advanceTimersByTimeAsync(60_000);
    const verifying = controller.submitStep({ code: '000000' });
    await controller.resendStep();
    await verifying;
    expect(api.callsTo('POST /pay/otp/resend')).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ busy: false, state: 'OTP_REQUIRED', screen: { step: { error: 'Code incorrect. Encore 2 essais.' } } });
    controller.hostGone();
  });

  it('CF-06 handles the sandbox 3ds code', async () => {
    jest.useFakeTimers();
    const threeDs = async (verify: Answer | Answer[]) => {
      api = fakeApi({
        'GET /pay/session': 'session-sandbox-cm',
        'GET /pay/sdk-config': 'sdk-config-sandbox',
        'POST /pay/process': 'process-requires-3ds-sandbox',
        'POST /pay/3ds/verify': verify,
        'POST /pay/3ds/send': '3ds-send-200',
        'GET /pay/status': 'status-processing',
      });
      const { controller } = makeController({ locale: 'en' });
      controller.start();
      await settle();
      controller.chooseMethod('card');
      await controller.payCard({ 'card.number': '4000056655665556', card_holder: 'Awa Ngono', expiry_month: '12', expiry_year: '30', cvv: '123' });
      await settle();
      return controller;
    };

    const accepted = await threeDs('3ds-verify-202');
    expect(accepted.getSnapshot()).toMatchObject({ state: '3DS_REQUIRED', screen: { name: 'three_ds', threeDs: { maskedEmail: 'aw*******@example.com' } } });
    await accepted.submit3ds('123456');
    expect(api.callsTo('POST /pay/3ds/verify')[0].body).toEqual({ three_ds_id: '5f0c2b1e-8d4a-4c3b-9e7f-1a2b3c4d5e6f', code: '123456' });
    expect(accepted.getSnapshot()).toMatchObject({ state: 'VERIFYING', screen: { threeDs: { accepted: true } } });
    api.answer('GET /pay/status', 'status-succeeded');
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(accepted.getSnapshot().state).toBe('SUCCESS');
    accepted.hostGone();
    api.restore();

    // A wrong code: 422 as designed, 500 as the API answers today — the same screen.
    for (const wrong of ['3ds-verify-422-invalid-code', '3ds-verify-500-invalid-code-api-bug']) {
      const controller = await threeDs(wrong);
      await controller.submit3ds('000000');
      expect(controller.getSnapshot()).toMatchObject({ state: '3DS_REQUIRED', screen: { name: 'three_ds', threeDs: { error: 'Invalid verification code.' } } });
      expect(api.callsTo('POST /pay/3ds/verify')).toHaveLength(1);
      controller.hostGone();
      api.restore();
    }

    // Too many wrong codes: the status says failed before the (500) answer comes back — which then changes nothing.
    let answer!: (value: unknown) => void;
    const stale = await threeDs('3ds-verify-202');
    api.fetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const pending = stale.submit3ds('000000');
    api.answer('GET /pay/status', { status: 200, body: { transaction: { reference: 'trx_test_PVrU8x2kQ1mNa7Lb3cDe', status: 'failed' } } });
    await jest.advanceTimersByTimeAsync(5000);
    expect(stale.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { error: { code: 'payment_failed' } } });
    answer({ ok: false, status: 500, headers: { get: () => null }, text: async () => '{}' });
    await pending;
    expect(stale.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { name: 'failed' } });
    stale.hostGone();
    api.restore();

    // A refusal that ends the step.
    const rejected = body('3ds-verify-422-invalid-code');
    rejected.error = { code: '3ds_rejected', message: 'Rejected.', retryable: false };
    const failed = await threeDs({ status: 422, body: rejected });
    await failed.submit3ds('000000');
    expect(failed.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { error: { code: '3ds_rejected' } } });
    failed.hostGone();
    api.restore();

    // A new code by email, after the countdown.
    const resend = await threeDs('3ds-verify-202');
    await jest.advanceTimersByTimeAsync(60_000);
    await resend.resendStep();
    expect(api.callsTo('POST /pay/3ds/send')[0].body).toEqual({ three_ds_id: '5f0c2b1e-8d4a-4c3b-9e7f-1a2b3c4d5e6f' });
    resend.hostGone();
    api.restore();

    // `three_ds_timeout` (600 s) elapsed: 3ds_timeout.
    const late = await threeDs('3ds-verify-202');
    await jest.advanceTimersByTimeAsync(600_000);
    expect(late.getSnapshot()).toMatchObject({ state: 'FAILED', screen: { error: { code: '3ds_timeout' } } });
    late.hostGone();
  });
});
