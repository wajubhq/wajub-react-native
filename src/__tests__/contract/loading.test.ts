import { availableMethods, mobileMoneyConfig } from '../../checkout/methods';
import { operatorChoices } from '../../mobileMoney/form';
import type { MethodEntry } from '../../checkout/methods';
import { makeController } from '../../test/checkout';
import { body, fakeApi, settle } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import { parseSdkConfig, parseSession } from '../../wire/parse';

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
});

async function load(session: Answer, config: Answer = 'sdk-config-cm-stripe', options = {}) {
  api = fakeApi({ 'GET /pay/session': session, 'GET /pay/sdk-config': config, 'POST /pay/cancel': 'cancel-200', 'GET /pay/status': 'status-processing' });
  const callbacks = { onReady: jest.fn(), onStateChange: jest.fn(), onLoadError: jest.fn(), onSuccess: jest.fn(), onError: jest.fn() };
  const { controller } = makeController({ ...callbacks, ...options });
  controller.start();
  await settle();
  return { controller, ...callbacks };
}

function methods(session: string, config: string, lang: 'en' | 'fr' = 'en'): MethodEntry[] {
  return availableMethods(parseSession(body(session)), parseSdkConfig(body(config)), lang, true);
}

describe('LD — loading', () => {
  it('LD-01 loads session and sdk-config in parallel', async () => {
    api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate', 'GET /pay/sdk-config': { status: 500, body: { code: 500 } } });
    const { controller } = makeController();
    controller.start();
    // Both requests are out before either answers.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /pay/session', 'GET /pay/sdk-config']);
    await settle();

    // sdk-config failed (after its retries): Mobile Money still shows, card (it needs sdk-config) does not.
    expect(api.callsTo('GET /pay/sdk-config')).toHaveLength(4);
    expect(controller.getSnapshot().methods.map((m) => m.id)).toEqual(['mobile_money']);
    expect(controller.getSnapshot().state).toBe('COLLECTING_DETAILS');
    controller.hostGone();
    api.restore();

    // A slow sdk-config: Mobile Money shows after a short grace, card joins when it lands.
    jest.useFakeTimers();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate' });
    api.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/pay/sdk-config')) await slow;
      const name = url.endsWith('/pay/sdk-config') ? 'sdk-config-cm-stripe' : 'session-cm-aggregate';
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body(name)) };
    });
    const late = makeController();
    late.controller.start();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(late.controller.getSnapshot().screen.name).toBe('loading');
    await jest.advanceTimersByTimeAsync(1);
    expect(late.controller.getSnapshot().methods.map((m) => m.id)).toEqual(['mobile_money']);
    release();
    await settle();
    expect(late.controller.getSnapshot().methods.map((m) => m.id)).toEqual(['card', 'mobile_money']);
    late.controller.hostGone();
    api.restore();

    // Card only, or wallets only: they need sdk-config — the sheet waits for it, never a lasting no_payment_method.
    const cardOnly = body('session-cm-aggregate');
    cardOnly.channels = [cardOnly.channels[0]];
    const walletOnly = body('session-ci-xof-wallets');
    walletOnly.channels = [walletOnly.channels[0]];
    for (const [session, config, method] of [
      [cardOnly, 'sdk-config-cm-stripe', 'card'],
      [walletOnly, 'sdk-config-ci-wallets', 'ci.djamo'],
    ] as const) {
      let configArrives!: () => void;
      const slowConfig = new Promise<void>((resolve) => (configArrives = resolve));
      api = fakeApi({ 'GET /pay/session': { status: 200, body: session } });
      api.fetch.mockImplementation(async (url: string) => {
        if (url.endsWith('/pay/sdk-config')) await slowConfig;
        const answer = url.endsWith('/pay/sdk-config') ? body(config) : session;
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(answer) };
      });
      const onLoadError = jest.fn();
      const waiting = makeController({ readyTimeout: 15_000, onLoadError });
      waiting.controller.start();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(waiting.controller.getSnapshot().screen.name).toBe('loading');
      // Past the ready timer: the retryable timeout, not "no payment method".
      await jest.advanceTimersByTimeAsync(5_000);
      expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ready_timeout' }));
      configArrives();
      await settle();
      expect(waiting.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', screen: { name: 'form', method: { id: method } } });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      waiting.controller.hostGone();
      api.restore();

      // sdk-config fails for good (after its retries): a load error with Retry, which reloads.
      api = fakeApi({ 'GET /pay/session': { status: 200, body: session }, 'GET /pay/sdk-config': { status: 503 } });
      const failing = makeController({ onLoadError });
      failing.controller.start();
      await settle();
      expect(failing.controller.getSnapshot().screen).toMatchObject({ name: 'load_error', error: { code: 'load_error', retryable: true } });
      expect(failing.controller.getSnapshot().methods).toEqual([]);
      api.answer('GET /pay/sdk-config', config);
      failing.controller.retryLoad();
      await settle();
      expect(failing.controller.getSnapshot().screen).toMatchObject({ name: 'form', method: { id: method } });
      failing.controller.hostGone();
      api.restore();
    }
  });

  it('LD-02 maps unknown sessions to session_not_found', async () => {
    for (const name of ['error-401-invalid-token', 'error-401-missing-token', 'error-403-not-a-payment-session']) {
      const { controller, onLoadError, onReady } = await load(name);
      const screen = controller.getSnapshot().screen;
      expect(screen).toMatchObject({ name: 'load_error', error: { code: 'session_not_found', type: 'authentication_error', retryable: false } });
      expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_not_found' }));
      expect(onReady).not.toHaveBeenCalled();
      controller.dismiss();
      await expect(controller.result).resolves.toMatchObject({ status: 'failed', error: { code: 'session_not_found' } });
      api.restore();
    }
  });

  it('LD-03 maps both 410s to session_terminal_expired', async () => {
    for (const name of ['error-410-session-terminal-expired', 'error-410-session-expired']) {
      const { controller, onLoadError } = await load(name);
      expect(controller.getSnapshot().screen).toMatchObject({ name: 'load_error', error: { code: 'session_terminal_expired', retryable: false } });
      expect(onLoadError).toHaveBeenCalledTimes(1);
      controller.hostGone();
      api.restore();
    }
  });

  it('LD-04 shows an already paid session as success', async () => {
    const { controller, onReady, onLoadError, onSuccess, onStateChange } = await load('session-terminal-succeeded');
    expect(controller.getSnapshot().screen.name).toBe('success');
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith({ state: 'SUCCESS', method: 'unknown' });
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'trx_TerminalSucc0000000000', method: 'unknown', status: 'success', receipt_url: expect.stringMatching(/^https:/) }),
    );
    expect(onLoadError).not.toHaveBeenCalled();
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    controller.dismiss();
    await expect(controller.result).resolves.toMatchObject({ status: 'complete', payment: { method: 'unknown' } });
  });

  it('LD-05 reports ended sessions with Wajub.js codes', async () => {
    for (const [name, code, state] of [
      ['session-terminal-failed', 'session_terminal_failed', 'FAILED'],
      ['session-terminal-cancelled', 'session_terminal_cancelled', 'CANCELLED'],
      ['session-terminal-expired', 'session_terminal_expired', 'EXPIRED'],
    ]) {
      const { controller, onLoadError, onReady } = await load(name);
      expect(controller.getSnapshot().state).toBe(state);
      expect(['failed', 'cancelled', 'expired']).toContain(controller.getSnapshot().screen.name);
      expect(onReady).toHaveBeenCalled();
      expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ code, retryable: false }));
      controller.dismiss();
      await expect(controller.result).resolves.toMatchObject({ status: 'failed', error: { code } });
      api.restore();
    }
  });

  it('LD-06 restores a pending approval', async () => {
    jest.useFakeTimers();
    for (const name of ['session-processing-mobile-money', 'session-processing-mobile-money-live']) {
      const { controller } = await load(name);
      const snapshot = controller.getSnapshot();
      expect(snapshot.state).toBe('APPROVAL_REQUIRED');
      expect(snapshot.screen).toMatchObject({ name: 'approval', instruction: body(name).transaction.processing_context.payer_instruction });
      await jest.advanceTimersByTimeAsync(5000);
      expect(api.callsTo('GET /pay/status').length).toBeGreaterThanOrEqual(1);
      // An attempt is in flight: closing resolves processing, and cancels nothing.
      controller.dismiss();
      await expect(controller.result).resolves.toMatchObject({ status: 'processing' });
      expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
      api.restore();
    }
  });

  it('LD-06 restores a payment from the session alone, without sdk-config', async () => {
    jest.useFakeTimers();
    // Card only, under way at a provider: nothing of sdk-config is needed to draw it.
    const cardOnly = body('session-processing-mobile-money');
    cardOnly.channels = cardOnly.channels.filter((c: { type: string }) => c.type === 'card');
    cardOnly.transaction.processing_context = {
      ...cardOnly.transaction.processing_context,
      channel_slug: 'card',
      is_mobile_money: false,
      payer_instruction: null,
    };
    for (const config of [{ status: 500, body: { code: 500 } }, 'network', 'hang'] as Answer[]) {
      const { controller, onLoadError, onReady } = await load({ status: 200, body: cardOnly }, config);
      // At once: no grace waited for, and no load error when sdk-config fails.
      expect(controller.getSnapshot()).toMatchObject({ state: 'PENDING', screen: { name: 'pending' } });
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onLoadError).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5000);
      expect(api.callsTo('GET /pay/status').length).toBeGreaterThanOrEqual(1);
      expect(controller.getSnapshot().screen.name).toBe('pending');
      controller.dismiss();
      await expect(controller.result).resolves.toMatchObject({ status: 'processing' });
      expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
      api.restore();
    }

    // Paid or ended at load: its screen at once too, with sdk-config still on its way.
    for (const [name, state] of [
      ['session-terminal-succeeded', 'SUCCESS'],
      ['session-terminal-failed', 'FAILED'],
      ['session-terminal-cancelled', 'CANCELLED'],
      ['session-terminal-expired', 'EXPIRED'],
    ]) {
      const { controller, onLoadError } = await load(name, 'hang');
      expect([name, controller.getSnapshot().state]).toEqual([name, state]);
      expect(onLoadError).toHaveBeenCalledTimes(state === 'SUCCESS' ? 0 : 1);
      controller.hostGone();
      api.restore();
    }

    // Refused later, back on the form: sdk-config that came meanwhile brings its methods.
    const late = body('session-processing-mobile-money');
    const { controller } = await load({ status: 200, body: late }, 'sdk-config-cm-stripe');
    expect(controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    await settle();
    expect(controller.getSnapshot().methods.map((m) => m.kind).sort()).toEqual(['card', 'mobile_money']);
    controller.hostGone();
  });

  it('LD-10 reads the refusal left at load', async () => {
    jest.useFakeTimers();
    const pay = async (controller: ReturnType<typeof makeController>['controller']) => {
      controller.chooseMethod('mobile_money');
      const choice = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
      await controller.payMobileMoney({ phone: '670000000', country: 'CM', choice, pickedByHand: true });
      await settle();
    };

    // Back at `pending` after a refusal: the form opens, nothing failed, no error.
    api = fakeApi({
      'GET /pay/session': 'session-pending-after-refusal',
      'GET /pay/sdk-config': 'sdk-config-sandbox',
      'POST /pay/process': 'network',
      'GET /pay/status': 'status-pending-attempt-refused',
    });
    const onError = jest.fn();
    const onLoadError = jest.fn();
    const left = makeController({ onError, onLoadError, locale: 'en' });
    left.controller.start();
    await settle();
    expect(left.controller.getSnapshot().screen.name).toBe('methods');
    expect(onError).not.toHaveBeenCalled();
    expect(onLoadError).not.toHaveBeenCalled();
    // A request that got no answer, then the same code on the status: the old refusal, not this
    // attempt's — watched until the 60 s rule sends the payer back to the form.
    await pay(left.controller);
    expect(left.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(55_000);
    expect(left.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(left.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', banner: { code: 'network_error' } });
    left.controller.hostGone();
    api.restore();

    // No refusal at load (`error_code: null`): the same status is this attempt's refusal, at once.
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'network',
      'GET /pay/status': 'status-pending-attempt-refused',
    });
    const fresh = makeController({ locale: 'en' });
    fresh.controller.start();
    await settle();
    await pay(fresh.controller);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(fresh.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { retryable: true } });
    fresh.controller.hostGone();
  });

  it('LD-08 raises ready_timeout', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const late = new Promise<void>((resolve) => (release = resolve));
    api = fakeApi({ 'GET /pay/session': 'hang', 'GET /pay/sdk-config': 'sdk-config-cm-stripe' });
    // The session answers after 20 s.
    api.fetch.mockImplementationOnce(async () => {
      await late;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body('session-cm-aggregate')) };
    });
    const onLoadError = jest.fn();
    const onReady = jest.fn();
    const { controller } = makeController({ readyTimeout: 15_000, onLoadError, onReady });
    controller.start();

    await jest.advanceTimersByTimeAsync(14_999);
    expect(onLoadError).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(onLoadError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'api_error', code: 'ready_timeout', retryable: true, api_message: 'Payment sheet not ready after 15000 ms' }),
    );
    expect(controller.getSnapshot().screen).toMatchObject({ name: 'load_error', error: { code: 'ready_timeout' } });

    // The data arrives while the error shows: the sheet becomes ready.
    release();
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1);
    // Card and Mobile Money: the method list.
    expect(controller.getSnapshot().state).toBe('INITIATED');
    controller.hostGone();
  });

  it('LD-09 resolves the sheet language', async () => {
    const lang = async (session: string, locale?: string) => {
      const { controller } = await load(session, 'sdk-config-cm-stripe', { locale });
      const value = controller.getSnapshot().lang;
      controller.hostGone();
      api.restore();
      return value;
    };
    expect(await lang('session-cm-aggregate')).toBe('fr');
    expect(await lang('session-cm-aggregate', 'en')).toBe('en');
    expect(await lang('session-ci-xof-wallets', 'fr-CI')).toBe('fr');
    expect(await lang('session-ci-xof-wallets', 'pt')).toBe('en');
    // locale null on the session: the device's (fr_CM in these tests).
    expect(await lang('session-ci-xof-wallets')).toBe('fr');
  });
});

describe('CH — channels', () => {
  it('CH-01 shows only supported channels', async () => {
    const ci = methods('session-ci-xof-wallets', 'sdk-config-ci-wallets');
    expect(ci.map((m) => m.id)).toEqual(['ci.djamo', 'mobile_money']);
    expect(ci[1]).toMatchObject({ slugs: ['ci.mtn', 'ci.moov', 'ci.orange', 'ci.wave'] });

    const sandbox = methods('session-sandbox-cm', 'sdk-config-sandbox');
    // In the API's order (2.1 sends card first here).
    expect(sandbox.map((m) => `${m.kind}:${m.kind === 'card' ? m.flavor : ''}`)).toEqual(['card:sandbox_form', 'mobile_money:']);

    // Types v2 does not offer are hidden; nothing left is a load error.
    const raw = body('session-ci-xof-wallets');
    raw.channels = [
      { id: 'btc', slug: 'crypto.btc', name: 'Bitcoin', 'name.fr': 'Bitcoin', type: 'crypto', countries: [], currency: 'XOF' },
      { id: 'ussd', slug: 'ci.ussd', name: 'USSD', 'name.fr': 'USSD', type: 'ussd', countries: ['CI'], currency: 'XOF' },
    ];
    const { controller, onLoadError } = await load({ status: 200, body: raw }, 'sdk-config-ci-wallets');
    expect(controller.getSnapshot().methods).toEqual([]);
    expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ code: 'no_payment_method' }));
    controller.hostGone();
  });

  it('CH-02 localises channel names', () => {
    const card = (lang: 'en' | 'fr') => methods('session-sandbox-cm', 'sdk-config-sandbox', lang).find((m) => m.kind === 'card')?.label;
    expect(card('en')).toBe('Card');
    expect(card('fr')).toBe('Carte bancaire');
  });

  it('CH-03 resolves sdk-config for aggregates', () => {
    const session = parseSession(body('session-cm-aggregate'));
    const aggregate = session.channels.find((c) => c.slug === 'cm.mobile')!;

    // 2.1: the aggregate has its own entry, beside its members'.
    const config = parseSdkConfig(body('sdk-config-cm-stripe'));
    expect(config.channels['cm.mobile']).toBeDefined();
    expect(mobileMoneyConfig(aggregate, config)).toBe(config.channels['cm.mobile']);
    // The operator picked: its member's entry.
    expect(mobileMoneyConfig(aggregate, config, 'orange')).toBe(config.channels['cm.orange']);
    // The aggregate's own entry unavailable: Mobile Money is not offered.
    const off = parseSdkConfig(body('sdk-config-cm-stripe'));
    off.channels['cm.mobile'].available = false;
    expect(availableMethods(session, off, 'en', true).some((m) => m.kind === 'mobile_money')).toBe(false);

    // 2.0: members only — a member's entry.
    const members = body('sdk-config-cm-stripe');
    delete members.channels['cm.mobile'];
    const old = parseSdkConfig(members);
    expect(mobileMoneyConfig(aggregate, old)).toBe(old.channels['cm.mtn']);
    expect(mobileMoneyConfig(aggregate, old, 'orange')).toBe(old.channels['cm.orange']);

    // A member sdk-config marks unavailable leaves the aggregate's list.
    for (const answer of [config, old]) {
      const copy = { channels: { ...answer.channels, 'cm.orange': { ...answer.channels['cm.orange'], available: false } } };
      const momo = availableMethods(session, copy, 'en', true).find((m) => m.kind === 'mobile_money');
      expect(momo?.kind === 'mobile_money' && momo.channels[0].operators?.map((o) => o.operator)).toEqual(['mtn']);
    }
  });

  it('CH-04 defaults mobile money without sdk-config', async () => {
    // 2.1: the sandbox's Mobile Money entries (a phone form); a 2.0 answer had none: a phone form all the same.
    const withEntries = body('sdk-config-sandbox');
    expect(withEntries.channels['cm.mobile']).toMatchObject({ sdk: 'form', required_fields: ['phone'] });
    const without = body('sdk-config-sandbox');
    for (const slug of Object.keys(without.channels)) if (slug.startsWith('cm.')) delete without.channels[slug];
    for (const config of [withEntries, without]) {
      const { controller } = await load('session-sandbox-cm', { status: 200, body: config });
      expect(controller.getSnapshot().methods.find((m) => m.kind === 'mobile_money')).toMatchObject({ slugs: ['cm.eu', 'cm.mobile'] });
      controller.chooseMethod('mobile_money');
      expect(controller.getSnapshot().screen).toMatchObject({ name: 'form', method: { kind: 'mobile_money' } });
      controller.hostGone();
      api.restore();
    }
  });

  it('CH-05 disables channels out of their limits', () => {
    const raw = body('session-cm-aggregate');
    raw.channels[1].min_amount = 50_000;
    raw.channels[0].max_amount = 1_000;
    const list = availableMethods(parseSession(raw), parseSdkConfig(body('sdk-config-cm-stripe')), 'en', true);
    expect(list.find((m) => m.kind === 'mobile_money')?.limit).toEqual({ min: 50_000 });
    expect(list.find((m) => m.kind === 'card')?.limit).toEqual({ max: 1_000 });
  });

  it('CH-05 checks the limits against the channel\'s own total', () => {
    // The payer's fee follows the channel: the card's 10 450 is over its 10 300, the payment's 10 200 is not.
    const raw = body('session-payer-fee-per-channel');
    const card = raw.channels.find((c: { slug: string }) => c.slug === 'card');
    card.max_amount = 10_300;
    card.amount_total = 10_450;
    const config = parseSdkConfig(body('sdk-config-cm-stripe'));
    expect(availableMethods(parseSession(raw), config, 'en', true).find((m) => m.kind === 'card')?.limit).toEqual({ max: 10_300 });
    delete card.amount_total;
    expect(availableMethods(parseSession(raw), config, 'en', true).find((m) => m.kind === 'card')?.limit).toBeNull();
  });

  it('CH-07 shows the amount of the selected operator, channel, or payment', async () => {
    const { controller } = await load('session-payer-fee-per-channel');
    const due = () => controller.getSnapshot().amountDue;
    const session = controller.getSnapshot().session!;
    expect(session.channels[0].operators?.map((o) => [o.operator, o.fee_amount, o.amount_total])).toEqual([
      ['mtn', 200, 10_200],
      ['orange', 450, 10_450],
    ]);
    // No method chosen: the payment's total.
    expect(controller.getSnapshot().screen.name).toBe('methods');
    expect(due()).toBe(10_200);
    controller.chooseMethod('mobile_money');
    expect(due()).toBe(10_200);
    // It follows the selection live: an Orange number turns 10 200 into 10 450.
    controller.selectMobileMoney('cm.mobile', 'mtn');
    expect(due()).toBe(10_200);
    controller.selectMobileMoney('cm.mobile', 'orange');
    expect(due()).toBe(10_450);
    controller.backToMethods();
    expect(due()).toBe(10_200);
    // The card channel's own total.
    controller.chooseMethod('card');
    expect(due()).toBe(10_200);
    controller.hostGone();
    api.restore();
    const raw = body('session-payer-fee-per-channel');
    raw.channels.find((c: { slug: string }) => c.slug === 'card').amount_total = 10_300;
    const card = await load({ status: 200, body: raw });
    card.controller.chooseMethod('card');
    expect(card.controller.getSnapshot().amountDue).toBe(10_300);
    card.controller.hostGone();
    api.restore();

    // The merchant bears the fee: the payment's total, whatever is selected.
    const plain = await load('session-cm-aggregate');
    plain.controller.chooseMethod('mobile_money');
    const total = body('session-cm-aggregate').transaction.amount_total;
    for (const operator of ['mtn', 'orange']) {
      plain.controller.selectMobileMoney('cm.mobile', operator);
      expect(plain.controller.getSnapshot().amountDue).toBe(total);
    }
    plain.controller.hostGone();
  });

  it('CH-07 shows what the charge took once a request is accepted', async () => {
    jest.useFakeTimers();
    const { controller } = await load('session-payer-fee-per-channel');
    api.answer('POST /pay/process', 'process-payer-fee-on-channel-sandbox');
    controller.chooseMethod('mobile_money');
    const orange = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en').find((c) => c.id === 'orange')!;
    controller.selectMobileMoney(orange.channel, orange.id);
    await controller.payMobileMoney({ phone: '690000000', country: 'CM', choice: orange, pickedByHand: false });
    await settle();
    // Nothing is sent back: the API prices the charge itself.
    const sent = api.callsTo('POST /pay/process')[0].body;
    const reference = body('process-payer-fee-on-channel-sandbox');
    expect({ ...sent.data, _client: undefined }).toEqual({ phone: '+237690000000', country: 'CM', operator: 'orange', _client: undefined });
    expect(controller.getSnapshot()).toMatchObject({ state: 'APPROVAL_REQUIRED', amountDue: reference.transaction.amount_total });
    expect(reference.transaction.amount_total).toBe(10_450);
    controller.hostGone();
  });

  it('CH-05 does not open an only method that is out of its limits', async () => {
    const raw = body('session-cm-aggregate');
    raw.channels = [{ ...raw.channels[1], min_amount: 50_000 }];
    const { controller } = await load({ status: 200, body: raw });
    // The list, with Mobile Money disabled and its limit — not a form that cannot pay.
    expect(controller.getSnapshot()).toMatchObject({ state: 'INITIATED', screen: { name: 'methods' } });
    expect(controller.getSnapshot().methods[0].limit).toEqual({ min: 50_000 });
    controller.chooseMethod('mobile_money');
    expect(controller.getSnapshot().screen.name).toBe('methods');
    controller.hostGone();
  });
});
