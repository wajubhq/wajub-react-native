import { readFileSync } from 'fs';
import { join } from 'path';

import { sha256Hex } from '../../crypto';
import { ERROR_CATALOGUE } from '../../errorCatalogue';
import { WajubError } from '../../WajubError';
import { body, fixture } from '../../test/fakeApi';
import { parseStepVerify } from '../../wire/parse';

const ROOT = join(__dirname, '..', '..', '..');

/** errors.md §2 for every error fixture: code, type, retryable, decline_code, param, retry_after_seconds, block_reference. */
const EXPECTED: Array<[string, string, string, boolean, string | null, string | null, number | null, string | null]> = [
  ['3ds-verify-422-invalid-code', 'invalid_code', 'invalid_request_error', true, null, 'request', null, null],
  ['3ds-verify-500-invalid-code-api-bug', 'server_error', 'api_error', true, null, null, null, null],
  ['address-verify-422-missing-fields', 'validation_error', 'invalid_request_error', true, null, null, null, null],
  ['birthday-verify-422-format', 'validation_error', 'invalid_request_error', true, null, 'birthday', null, null],
  ['broadcasting-auth-403', 'merchant_restricted', 'payment_error', false, null, null, null, null],
  ['cancel-400-not-cancellable', 'not_processable', 'invalid_request_error', false, null, null, null, null],
  ['cancel-409-payment-in-progress', 'payment_in_progress', 'invalid_request_error', false, null, null, null, null],
  ['cancel-409-payment-partly-paid', 'payment_partly_paid', 'invalid_request_error', false, null, null, null, null],
  ['client-session-422-sandbox', 'client_session_unavailable', 'invalid_request_error', false, null, 'request', null, null],
  ['client-session-422-security-check-failed', 'security_check_failed', 'invalid_request_error', true, null, 'request', null, null],
  ['client-session-complete-402', 'failed', 'payment_error', true, 'failed', null, null, null],
  ['client-session-complete-422-expired', 'client_session_expired', 'invalid_request_error', true, null, 'request', null, null],
  ['error-401-invalid-token', 'session_not_found', 'authentication_error', false, null, null, null, null],
  ['error-401-missing-token', 'session_not_found', 'authentication_error', false, null, null, null, null],
  ['error-403-not-a-payment-session', 'session_not_found', 'authentication_error', false, null, null, null, null],
  ['error-410-process-session-ended', 'session_terminal_expired', 'invalid_request_error', false, null, null, null, null],
  ['error-410-session-expired', 'session_terminal_expired', 'invalid_request_error', false, null, null, null, null],
  ['error-410-session-terminal-expired', 'session_terminal_expired', 'invalid_request_error', false, null, null, null, null],
  ['error-429-rate-limited', 'rate_limited', 'rate_limit_error', true, null, null, 300, null],
  ['error-500-production', 'server_error', 'api_error', true, null, null, null, null],
  ['process-400-not-processable', 'not_processable', 'invalid_request_error', false, null, null, null, null],
  ['process-402-insufficient-funds-sandbox', 'insufficient_funds', 'payment_error', true, 'insufficient_funds', null, null, null],
  ['process-402-merchant-not-verified', 'merchant_not_verified', 'payment_error', false, 'merchant_not_verified', null, null, null],
  ['process-403-restricted', 'payment_method_restricted', 'payment_error', true, null, null, null, null],
  ['process-403-shield-blocked', 'shield_blocked', 'payment_error', false, null, null, null, 'BLK-PLACEHOLDER'],
  ['process-409-order-not-validated', 'order_not_validated', 'invalid_request_error', false, null, null, null, null],
  ['process-409-payment-in-progress', 'payment_in_progress', 'invalid_request_error', false, null, null, null, null],
  ['process-422-idempotency-key-invalid', 'validation_error', 'invalid_request_error', true, null, 'idempotency_key', null, null],
  ['process-422-operator-mismatch', 'validation_error', 'invalid_request_error', true, null, 'phone', null, null],
  ['process-422-over-mobile-money-limit-sandbox', 'validation_error', 'invalid_request_error', true, null, 'request', null, null],
  ['process-422-raw-card-data-live', 'raw_card_data_not_accepted', 'invalid_request_error', false, null, 'card', null, null],
  ['process-422-security-check-failed', 'security_check_failed', 'invalid_request_error', true, null, 'request', null, null],
  ['process-422-sandbox-invalid-test-number', 'validation_error', 'invalid_request_error', true, null, 'data.phone', null, null],
  ['process-422-unknown-channel', 'validation_error', 'invalid_request_error', true, null, 'channel', null, null],
  // Two fields at fault: no single param.
  ['process-422-validation', 'validation_error', 'invalid_request_error', true, null, null, null, null],
  ['process-failed-402', 'insufficient_funds', 'payment_error', true, 'insufficient_funds', null, null, null],
];

const STEP_FAILURES: Array<[string, string, string]> = [
  ['otp-verify-invalid', 'invalid_otp', 'invalid_request_error'],
  ['otp-verify-expired', 'otp_expired', 'invalid_request_error'],
  ['otp-verify-max-attempts', 'max_attempts_exceeded', 'payment_error'],
  ['pin-verify-invalid', 'invalid_pin', 'invalid_request_error'],
];

function mapped(name: string, lang: 'en' | 'fr' = 'en'): WajubError {
  const f = fixture(name);
  const headers = { ...(f.response_headers ?? {}), 'X-Request-Id': 'req_5f0c2b1e' };
  return WajubError.fromResponse({
    status: f.http_status,
    body: f.body,
    headers: { get: (n: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? null },
    phase: f.request?.path === '/pay/session' ? 'load' : 'payment',
    lang,
  });
}

describe('ER — errors', () => {
  it('ER-01 exposes the error shape', () => {
    const error = mapped('process-403-shield-blocked');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WajubError');
    expect(Object.keys(error.toJSON()).sort()).toEqual(
      ['name', 'type', 'code', 'message', 'decline_code', 'retryable', 'param', 'http_status', 'correlation_id', 'retry_after_seconds', 'details', 'block_reference', 'api_message'].sort(),
    );
    expect(error.toJSON()).toMatchObject({ http_status: 403, correlation_id: 'req_5f0c2b1e', api_message: body('process-403-shield-blocked').message });
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toJSON());
  });

  it('ER-02 maps every error fixture', () => {
    for (const [name, code, type, retryable, decline, param, retryAfter, block] of EXPECTED) {
      const error = mapped(name);
      expect([name, error.code, error.type, error.retryable, error.decline_code, error.param, error.retry_after_seconds, error.block_reference]).toEqual([
        name, code, type, retryable, decline, param, retryAfter, block,
      ]);
      expect([name, error.correlation_id, error.http_status]).toEqual([name, 'req_5f0c2b1e', fixture(name).http_status]);
    }
    expect(mapped('address-verify-422-missing-fields').details).toEqual({
      city: 'The city field is required.',
      state: 'The state field is required.',
      zip_code: 'The zip code field is required.',
    });
    // Every error fixture is in the table.
    const { readdirSync } = jest.requireActual('fs') as typeof import('fs');
    const errors = readdirSync(join(ROOT, 'src', '__fixtures__'))
      .filter((f) => f.endsWith('.json') && f !== 'mobile-money.vectors.json')
      .map((f) => f.replace(/\.json$/, ''))
      .filter((f) => fixture(f).http_status >= 400);
    expect(errors.sort()).toEqual(EXPECTED.map(([n]) => n).sort());

    for (const [name, code, type] of STEP_FAILURES) {
      const answer = parseStepVerify(body(name));
      if (answer.status !== 'failed') throw new Error(name);
      const error = WajubError.fromStepFailure(answer);
      expect([name, error.code, error.type, error.retryable, error.http_status]).toEqual([name, code, type, true, 200]);
    }
  });

  it('ER-03 localises error messages', () => {
    expect(mapped('process-failed-402').message).toBe('Insufficient funds.');
    expect(mapped('process-failed-402', 'fr').message).toBe('Fonds insuffisants.');
    // A PSP code the catalogue does not know: the generic decline text.
    expect(mapped('client-session-complete-402').message).toBe('This payment could not be completed. Try again or use another payment method.');
    expect(mapped('client-session-complete-402', 'fr').message).toBe("Ce paiement n'a pas abouti. Réessayez ou utilisez un autre moyen de paiement.");
    // A code of the catalogue: its text in the sheet's language.
    expect(mapped('error-429-rate-limited', 'fr').message).toBe('Trop de tentatives. Merci de patienter 300 s avant de réessayer.');
    expect(mapped('process-403-shield-blocked', 'fr').message).toBe('Paiement bloqué pour sécurité. Référence : BLK-PLACEHOLDER.');
    // Unknown, not a decline: the API's text in English, the catalogue's fallback in French.
    expect(mapped('process-409-payment-in-progress').message).toBe(body('process-409-payment-in-progress').message);
    expect(mapped('process-409-payment-in-progress', 'fr').message).toBe(ERROR_CATALOGUE.server_error.fr);
    expect(mapped('process-422-over-mobile-money-limit-sandbox', 'fr').message).toBe('Vérifiez les informations saisies.');
    expect(mapped('process-422-over-mobile-money-limit-sandbox').message).toBe(body('process-422-over-mobile-money-limit-sandbox').message);
    // And the same error, shown in the other language.
    expect(mapped('process-failed-402').localized('fr').message).toBe('Fonds insuffisants.');
    const step = parseStepVerify(body('otp-verify-invalid'));
    expect(step.status === 'failed' && WajubError.fromStepFailure(step, 'fr').message).toBe('Code incorrect. Encore 2 essais.');
    for (const entry of Object.values(ERROR_CATALOGUE)) {
      expect(entry.en.length).toBeGreaterThan(0);
      expect(entry.fr.length).toBeGreaterThan(0);
    }
  });
});

describe('SY — spec sync', () => {
  it('SY-01 uses the synced spec files', () => {
    const manifest = readFileSync(join(ROOT, 'src', '__fixtures__', 'spec.sha256'), 'utf8').trim().split('\n');
    expect(manifest.length).toBeGreaterThanOrEqual(94);
    for (const line of manifest) {
      const [hash, path] = line.split(/\s+/);
      const content = readFileSync(join(ROOT, path), 'utf8');
      expect([path, sha256Hex(content)]).toEqual([path, hash]);
    }
    expect(manifest.some((l) => l.endsWith('src/data/mobile-money.json'))).toBe(true);
  });
});
