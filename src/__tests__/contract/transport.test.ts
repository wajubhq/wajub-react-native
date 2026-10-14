import { PayClient, TIMEOUTS } from '../../client/payClient';
import { API_URL } from '../../types';
import { WajubError } from '../../WajubError';
import { makeController } from '../../test/checkout';
import { body, fakeApi, fixture, settle } from '../../test/fakeApi';
import type { FakeApi } from '../../test/fakeApi';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const instant = { sleep: async () => undefined };

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
});

describe('TR — transport', () => {
  it('TR-01 sends the common headers', async () => {
    api = fakeApi({ 'GET /pay/session': 'session-cm-aggregate', 'POST /pay/process': 'process-processing-mobile-money-sandbox' });
    const client = new PayClient(instant);
    await client.getSession('tok_1');
    await client.process('tok_1', 'cm.mobile', { phone: '+237670000000', country: 'CM' });

    for (const call of api.calls) {
      expect(call.headers.Authorization).toBe('Bearer tok_1');
      expect(call.headers.Accept).toBe('application/json');
      expect(call.headers['X-Request-Id']).toMatch(UUID);
      expect(call.headers['X-Wajub-Client']).toBe('wajub-react-native/1.5.0 (android 15)');
      // The device's languages, region first: fr-CM, fr;q=0.9, …
      expect(call.headers['Accept-Language']).toMatch(/^fr-CM, fr;q=0\.9/);
    }
    expect(api.calls[0].headers['X-Request-Id']).not.toBe(api.calls[1].headers['X-Request-Id']);
    expect(api.calls[0].headers['Content-Type']).toBeUndefined();
    expect(api.calls[1].headers['Content-Type']).toBe('application/json');
  });

  it('TR-03 sends device signals', async () => {
    api = fakeApi({ 'POST /pay/process': 'process-processing-mobile-money-sandbox' });
    await new PayClient(instant).process('tok', 'cm.mobile', { phone: '+237670000000', country: 'CM' });
    await new PayClient(instant).process('tok', 'cm.mobile', { phone: '+237670000000', country: 'CM' });

    const [first, second] = api.callsTo('POST /pay/process').map((c) => c.body.data._client);
    const reference = (fixture('process-processing-mobile-money-sandbox').request!.body as { data: { _client: object } }).data._client;
    expect(Object.keys(first).sort()).toEqual([...Object.keys(reference), 'client'].sort());
    expect(first).toMatchObject({ language: 'fr-CM', screen: '1080x2400', color_depth: 24, client: 'wajub-react-native/1.5.0 (android 15)' });
    expect(typeof first.timezone).toBe('string');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{16,64}$/);
    // Two SDK instances, one install: one fingerprint.
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('TR-04 keeps a stable install fingerprint', async () => {
    const storage = new Map<string, string>();
    jest.doMock(
      '@react-native-async-storage/async-storage',
      () => ({
        default: {
          getItem: async (key: string) => storage.get(key) ?? null,
          setItem: async (key: string, value: string) => void storage.set(key, value),
        },
      }),
      { virtual: true },
    );
    const load = () => {
      let device!: typeof import('../../client/device');
      jest.isolateModules(() => {
        device = require('../../client/device');
      });
      return device.installFingerprint();
    };

    const first = await load();
    // The SDK restarts (a fresh module, as after an app restart): same id from storage, same fingerprint.
    const second = await load();
    jest.dontMock('@react-native-async-storage/async-storage');

    expect(second).toBe(first);
    const id = storage.get('@wajub/install-id')!;
    expect(id).toMatch(UUID);
    const { sha256Hex } = require('../../crypto');
    expect(first).toBe(sha256Hex(`device:${id}`));
  });

  it('TR-05 applies per-call timeouts', async () => {
    jest.useFakeTimers();
    api = fakeApi({ 'GET /pay/session': 'hang', 'POST /pay/process': 'hang', 'POST /pay/otp/verify': 'hang' });
    const client = new PayClient({ sleep: async () => undefined });

    const read = client.getSession('tok').catch((e: WajubError) => e);
    await jest.advanceTimersByTimeAsync(TIMEOUTS.requestMs - 1);
    expect(api.calls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    // Timed out at 30 s, and retried.
    expect(api.calls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(TIMEOUTS.requestMs * 3);
    expect((await read) as WajubError).toMatchObject({ code: 'timeout', type: 'api_error', retryable: true });

    const verify = client.verifyStep('tok', 'otp', { otp_id: 'prc_1', code: '123456' }).catch((e: WajubError) => e);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(api.callsTo('POST /pay/otp/verify')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(TIMEOUTS.paymentRequestMs - 30_000);
    expect(((await verify) as WajubError).code).toBe('timeout');

    // A charge gets 60 s: a provider may take 20 s and fail over.
    const charge = client.process('tok', 'cm.mobile', { _client: {} }).catch((e: WajubError) => e);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(api.callsTo('POST /pay/process')).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(((await charge) as WajubError).code).toBe('timeout');
  });

  it('TR-06 retries process with the same idempotency key', async () => {
    api = fakeApi({
      'POST /pay/process': ['network', { status: 503, body: { code: 503, status: 'Service Unavailable' } }, 'process-idempotent-replay'],
    });
    const client = new PayClient(instant);
    const result = await client.process('tok', 'cm.mobile', { phone: '+237670000000', country: 'CM' });
    expect(result.transaction?.status).toBe('processing');

    const calls = api.callsTo('POST /pay/process');
    expect(calls).toHaveLength(3);
    const key = calls[0].headers['Idempotency-Key'];
    expect(key).toMatch(UUID);
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual([key, key, key]);
    expect(calls.map((c) => c.raw)).toEqual([calls[0].raw, calls[0].raw, calls[0].raw]);

    // A new press of Pay is a new attempt: a new key.
    api.answer('POST /pay/process', 'process-processing-mobile-money-sandbox');
    await client.process('tok', 'cm.mobile', { phone: '+237670000000', country: 'CM' });
    expect(api.callsTo('POST /pay/process')[3].headers['Idempotency-Key']).not.toBe(key);
  });

  it('TR-07 does not retry non-retryable posts', async () => {
    const client = new PayClient(instant);
    for (const answer of ['process-failed-402', 'process-422-validation', 'error-500-production']) {
      api = fakeApi({ 'POST /pay/process': answer });
      await expect(client.process('tok', 'cm.mobile', {})).rejects.toBeInstanceOf(WajubError);
      expect(api.callsTo('POST /pay/process')).toHaveLength(1);
      api.restore();
    }
    for (const answer of ['network', { status: 503 }] as const) {
      api = fakeApi({ 'POST /pay/otp/verify': answer });
      await expect(client.verifyStep('tok', 'otp', { otp_id: 'prc_1', code: '000000' })).rejects.toBeInstanceOf(WajubError);
      expect(api.callsTo('POST /pay/otp/verify')).toHaveLength(1);
      api.restore();
    }
    // An answered verify (HTTP 200 failure) is an answer, not an error.
    api = fakeApi({ 'POST /pay/otp/verify': 'otp-verify-invalid' });
    await expect(client.verifyStep('tok', 'otp', { otp_id: 'prc_1', code: '000000' })).resolves.toMatchObject({ status: 'failed' });
    expect(api.calls).toHaveLength(1);
  });

  it('TR-08 retries idempotent reads', async () => {
    const sleeps: number[] = [];
    const client = new PayClient({ sleep: async (ms) => void sleeps.push(ms) });
    api = fakeApi({ 'GET /pay/session': [{ status: 503 }, { status: 503 }, 'session-cm-aggregate'] });
    await expect(client.getSession('tok')).resolves.toMatchObject({ transaction: { id: 'trx_PVrU8x2kQ1mNa7Lb3cDe' } });
    expect(api.callsTo('GET /pay/session')).toHaveLength(3);
    // min(1 s × 2^n, 10 s) ± 30 %.
    expect(sleeps[0]).toBeGreaterThanOrEqual(700);
    expect(sleeps[0]).toBeLessThanOrEqual(1300);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1400);
    expect(sleeps[1]).toBeLessThanOrEqual(2600);
    api.restore();

    for (const status of [408, 500, 502, 504]) {
      api = fakeApi({ 'GET /pay/status': [{ status }, 'status-processing'] });
      await expect(client.getStatus('tok')).resolves.toMatchObject({ status: 'processing' });
      api.restore();
    }

    // Three retries at most.
    api = fakeApi({ 'GET /pay/sdk-config': 'network' });
    await expect(client.getSdkConfig('tok')).rejects.toMatchObject({ code: 'network_error' });
    expect(api.calls).toHaveLength(4);
    api.restore();

    // 429: Retry-After waited when ≤ 10 s, else rate_limited at once.
    sleeps.length = 0;
    api = fakeApi({ 'GET /pay/status': [{ status: 429, headers: { 'Retry-After': '3' } }, 'status-processing'] });
    await expect(client.getStatus('tok')).resolves.toMatchObject({ status: 'processing' });
    expect(sleeps).toEqual([3000]);
    api.restore();
    api = fakeApi({ 'GET /pay/status': 'error-429-rate-limited' });
    await expect(client.getStatus('tok')).rejects.toMatchObject({ code: 'rate_limited', retry_after_seconds: 300 });
    expect(api.calls).toHaveLength(1);
  });

  it('TR-09 treats an unanswered process as pending', async () => {
    jest.useFakeTimers();
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'network',
      'GET /pay/status': ['status-processing', 'status-succeeded'],
    });
    const onError = jest.fn();
    const { controller } = makeController({ onError });
    controller.start();
    await settle();
    controller.chooseMethod('mobile_money');
    const choice = { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN', logo: null, label: 'MTN MoMo' };
    await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
    await settle();

    // Three tries, no answer: not a failure — PENDING, and the status is watched.
    expect(api.callsTo('POST /pay/process')).toHaveLength(3);
    expect(controller.getSnapshot().state).toBe('PENDING');
    expect(onError).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5000);
    expect(controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(controller.getSnapshot().state).toBe('SUCCESS');
    expect(onError).not.toHaveBeenCalled();
    controller.dismiss();
  });

  it('TR-10 defaults to the production api', async () => {
    expect(API_URL).toBe('https://api.wajub.com');
    api = fakeApi({ 'GET /pay/status': 'status-processing' });
    await new PayClient().getStatus('tok');
    expect(api.fetch.mock.calls[0][0]).toBe('https://api.wajub.com/pay/status');
    expect(body('status-processing').transaction.status).toBe('processing');
  });
});
