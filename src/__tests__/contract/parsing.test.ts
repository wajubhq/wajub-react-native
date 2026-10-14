import { readdirSync } from 'fs';

import { WajubError } from '../../WajubError';
import { body, fixture, FIXTURES_DIR } from '../../test/fakeApi';
import {
  parseApiError,
  parseBroadcastAuth,
  parseCancel,
  parseProcess,
  parseSdkConfig,
  parseSession,
  parseStatus,
  parseStepVerify,
  WajubParseError,
} from '../../wire/parse';

const names = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'mobile-money.vectors.json')
  .map((f) => f.replace(/\.json$/, ''));

/** Parses a fixture body with the reader its endpoint uses. */
function parseByEndpoint(name: string): unknown {
  const f = fixture(name);
  if (f.event) return [parseStatus(f.data), parseStatus(JSON.stringify(f.data))];
  const path = f.request?.path ?? '';
  if (f.http_status >= 400) return WajubError.fromResponse({ status: f.http_status, body: f.body, phase: path === '/pay/session' ? 'load' : 'payment' });
  if (path === '/pay/session') return parseSession(f.body);
  if (path === '/pay/sdk-config') return parseSdkConfig(f.body);
  if (path === '/pay/status') return parseStatus(f.body);
  if (path === '/pay/cancel') return parseCancel(f.body);
  if (path === '/pay/broadcasting/auth') return parseBroadcastAuth(f.body);
  if (/^\/pay\/(otp|pin|phone|birthday|address)\/verify$/.test(path)) return parseStepVerify(f.body);
  return parseProcess(f.body);
}

describe('PR — parsing', () => {
  it('PR-01 parses every fixture', () => {
    expect(names.length).toBeGreaterThanOrEqual(92);
    for (const name of names) {
      expect(() => parseByEndpoint(name)).not.toThrow();
    }
    expect(parseSession(body('session-cm-aggregate')).transaction.id).toBe('trx_PVrU8x2kQ1mNa7Lb3cDe');
    expect(parseStatus(body('status-processing'))).toEqual({ reference: 'trx_test_PVrU8x2kQ1mNa7Lb3cDe', status: 'processing' });
    expect(parseStepVerify(body('otp-verify-invalid'))).toMatchObject({ status: 'failed', attempts_remaining: 2, error: { code: 'invalid_otp' } });
    expect(parseProcess(body('process-requires-otp'))).toMatchObject({ action: 'confirm_otp', otp_id: 'prc_7hQm2LxV9pR4sT1wYb3N' });
    expect(parseCancel(body('cancel-200')).redirect_url).toMatch(/status=cancelled/);
    expect(parseBroadcastAuth(body('broadcasting-auth-200')).auth).toBe('wajub-app-key:SIGNATURE');
    expect(parseApiError(body('error-429-rate-limited')).retry_after).toBe(300);
  });

  it('PR-02 ignores unknown keys', () => {
    const raw = body('session-cm-aggregate');
    const injected = body('session-cm-aggregate');
    injected.future_key = { nested: true };
    injected.transaction.future_key = 'x';
    injected.branding.future_key = 42;
    injected.channels[0].future_key = [1, 2];
    injected.channels[1].operators[0].future_key = null;

    // `branding` itself is the API's object, as 1.4 handed it over; its reading is `parsedBranding`.
    const withoutRaw = (body: unknown) => ({ ...parseSession(body), branding: undefined });
    expect(withoutRaw(injected)).toEqual(withoutRaw(raw));
    expect(parseSession(raw).branding).toEqual(raw.branding);
  });

  it('PR-03 accepts numbers as int, double or numeric string', () => {
    const fee = parseSession(body('session-payer-bears-fee')).transaction;
    expect(fee.amount).toBe(10000);
    expect(fee.amount_total).toBe(10350);
    expect(fee.fee).toEqual({ amount: 350, rate: 0.035, description: 'Platform fee' });

    for (const amount of [25000, 25000.0, '25000', '25000.00']) {
      const raw = body('session-payer-bears-fee');
      raw.transaction.amount = amount;
      raw.channels[1].min_amount = String(amount);
      const session = parseSession(raw);
      expect(session.transaction.amount).toBe(25000);
      expect(session.channels[1].min_amount).toBe(25000);
    }

    const optional = body('session-payer-bears-fee');
    optional.transaction.fee.rate = 'n/a';
    optional.channels[1].max_amount = 'unlimited';
    const parsed = parseSession(optional);
    expect(parsed.transaction.fee?.rate).toBeNull();
    expect(parsed.channels[1].max_amount).toBeUndefined();

    for (const amount of ['abc', null]) {
      const raw = body('session-payer-bears-fee');
      raw.transaction.amount = amount;
      expect(() => parseSession(raw)).toThrow(WajubParseError);
    }
  });

  it('PR-04 accepts booleans in every encoding', () => {
    expect(parseSession(body('session-cm-aggregate')).parsedBranding?.white_label).toBe(true);
    for (const [value, expected] of [
      [true, true],
      [1, true],
      ['true', true],
      [false, false],
      [0, false],
      ['false', false],
    ] as const) {
      const raw = body('session-cm-aggregate');
      raw.branding.white_label = value;
      raw.transaction.sandbox = value;
      const session = parseSession(raw);
      expect(session.parsedBranding?.white_label).toBe(expected);
      expect(session.transaction.sandbox).toBe(expected);
    }
    const config = body('sdk-config-cm-stripe');
    config.channels.card.available = 1;
    config.channels.card.client_session = 'false';
    expect(parseSdkConfig(config).channels.card).toMatchObject({ available: true, client_session: false });
  });

  it('PR-05 parses branding with mixed types', () => {
    const branding = parseSession(body('session-cm-aggregate')).parsedBranding!;
    expect(branding.white_label).toBe(true);
    expect(branding.overlay_intensity).toBe(40);
    expect(branding.font_weight_heading).toBe(600);
    expect(branding.font_weight_body).toBe(400);
    expect(branding.primary_color).toBe('#0F766E');
    expect(parseSession(body('session-ci-xof-wallets')).parsedBranding?.business_name).toBe('Maquis Plateau');

    const object = body('session-cm-aggregate');
    object.branding.white_label = { enabled: true, brand_name: 'Akwa Pay' };
    expect(parseSession(object).parsedBranding?.white_label).toMatchObject({ enabled: true, brand_name: 'Akwa Pay' });

    for (const branding of [{}, undefined, null]) {
      const raw = body('session-cm-aggregate');
      raw.branding = branding;
      expect(() => parseSession(raw)).not.toThrow();
    }
  });

  it('PR-06 reads dotted keys literally', () => {
    const session = parseSession(body('session-cm-aggregate'));
    expect(session.channels[0]['name.fr']).toBe('Carte bancaire');
    expect(session.parsedBranding?.['card.background_color']).toBe('#FFFFFF');
    expect(session.parsedBranding?.['card.border_color']).toBe('#E5E7EB');
    expect(parseSession(body('session-sandbox-cm')).channels[2]).toMatchObject({ name: 'Card', 'name.fr': 'Carte bancaire' });
  });

  it('PR-07 accepts null optionals', () => {
    const wallets = parseSession(body('session-ci-xof-wallets'));
    expect(wallets.transaction.customer).toBeNull();
    expect(wallets.transaction.fee).toBeNull();
    expect(wallets.transaction.receipt_url).toBeNull();
    expect(wallets.channels.find((c) => c.slug === 'ci.moov')?.logo).toBeNull();
    expect(wallets.channels[0].min_amount).toBeUndefined();
    expect(wallets.locale).toBeUndefined();

    const sandbox = parseSession(body('session-sandbox-cm'));
    expect(sandbox.echo?.key).toBe('');
    expect(sandbox.altcha).toBeNull();
  });

  it('PR-08 accepts absent optional objects', () => {
    const session = parseSession(body('session-cm-aggregate'));
    expect(session.transaction.processing_context).toBeUndefined();
    expect(session.saved_methods).toBeUndefined();

    const noEcho = body('session-cm-aggregate');
    delete noEcho.echo;
    expect(parseSession(noEcho).echo).toBeUndefined();

    expect(parseSdkConfig(body('sdk-config-sandbox')).channels.card.client_session).toBeUndefined();
    expect(parseProcess(body('process-processing-mobile-money-sandbox')).action).toBeUndefined();
  });
});
