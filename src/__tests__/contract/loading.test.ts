import { availableMethods, mobileMoneyConfig } from '../../checkout/methods';
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
    expect(sandbox.map((m) => `${m.kind}:${m.kind === 'card' ? m.flavor : ''}`)).toEqual(['mobile_money:', 'card:sandbox_form']);

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
    const config = parseSdkConfig(body('sdk-config-cm-stripe'));
    const aggregate = session.channels.find((c) => c.slug === 'cm.mobile')!;
    expect(config.channels['cm.mobile']).toBeUndefined();
    expect(mobileMoneyConfig(aggregate, config)).toBe(config.channels['cm.mtn']);
    expect(mobileMoneyConfig(aggregate, config, 'orange')).toBe(config.channels['cm.orange']);

    // A member sdk-config marks unavailable leaves the aggregate's list.
    config.channels['cm.orange'].available = false;
    const momo = availableMethods(session, config, 'en', true).find((m) => m.kind === 'mobile_money');
    expect(momo?.kind === 'mobile_money' && momo.channels[0].operators?.map((o) => o.operator)).toEqual(['mtn']);
  });

  it('CH-04 defaults mobile money without sdk-config', async () => {
    // Sandbox sdk-config has no Mobile Money entry: a phone form all the same.
    const { controller } = await load('session-sandbox-cm', 'sdk-config-sandbox');
    expect(controller.getSnapshot().methods.find((m) => m.kind === 'mobile_money')).toMatchObject({ slugs: ['cm.eu', 'cm.mobile'] });
    controller.chooseMethod('mobile_money');
    expect(controller.getSnapshot().screen).toMatchObject({ name: 'form', method: { kind: 'mobile_money' } });
    controller.hostGone();
  });

  it('CH-05 disables channels out of their limits', () => {
    const raw = body('session-cm-aggregate');
    raw.channels[1].min_amount = 50_000;
    raw.channels[0].max_amount = 1_000;
    const list = availableMethods(parseSession(raw), parseSdkConfig(body('sdk-config-cm-stripe')), 'en', true);
    expect(list.find((m) => m.kind === 'mobile_money')?.limit).toEqual({ min: 50_000 });
    expect(list.find((m) => m.kind === 'card')?.limit).toEqual({ max: 1_000 });
  });
});
