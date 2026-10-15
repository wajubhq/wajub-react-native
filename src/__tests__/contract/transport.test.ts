import { PayClient, TIMEOUTS } from '../../client/payClient';
import { createSession } from '../../WajubSession';
import { API_URL } from '../../types';
import type { WajubStorage } from '../../types';
import { WajubError } from '../../WajubError';
import { makeController } from '../../test/checkout';
import { body, fakeApi, fixture, settle } from '../../test/fakeApi';
import { sha256Hex } from '../../crypto';
import type { Answer, FakeApi } from '../../test/fakeApi';

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

  // TR-02 (SHOULD) is not met on React Native: fetch cannot read the platform's
  // own User-Agent (okhttp/…, CFNetwork/…) to append X-Wajub-Client to it, and
  // replacing it would lose what the API's risk rules read. The SDK leaves it
  // to the platform; X-Wajub-Client and data._client.client carry the SDK's name.
  it('TR-02 leaves the platform user agent alone (it cannot be suffixed from JavaScript)', async () => {
    api = fakeApi({ 'GET /pay/status': 'status-processing' });
    await new PayClient(instant).getStatus('tok');
    expect(api.calls[0].headers['User-Agent']).toBeUndefined();
    expect(api.calls[0].headers['X-Wajub-Client']).toMatch(/^wajub-react-native\/1\.5\.0 /);
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
    // @react-native-async-storage/async-storage, through the package's own jest mock.
    const AsyncStorage = jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock');
    const load = (storage?: WajubStorage) => {
      let device!: typeof import('../../client/device');
      jest.isolateModules(() => {
        jest.doMock('@react-native-async-storage/async-storage', () => AsyncStorage);
        device = require('../../client/device');
      });
      return device.installFingerprint(storage);
    };

    const first = await load();
    // The SDK restarts (a fresh module, as after an app restart): same id from storage, same fingerprint.
    const second = await load();
    expect(second).toBe(first);
    const id = await AsyncStorage.getItem('@wajub/install-id');
    expect(id).toMatch(UUID);
    expect(first).toBe(sha256Hex(`device:${id}`));

    // The host's own storage, given to present() or createSession().
    const items = new Map<string, string>();
    const adapter: WajubStorage = {
      getItem: jest.fn(async (key: string) => items.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => void items.set(key, value)),
    };
    const hosted = await load(adapter);
    expect(await load(adapter)).toBe(hosted);
    expect(adapter.setItem).toHaveBeenCalledTimes(1);
    expect(hosted).toBe(sha256Hex(`device:${items.get('@wajub/install-id')}`));

    api = fakeApi({ 'POST /pay/process': 'process-processing-mobile-money-sandbox' });
    await createSession('tok', new PayClient(instant), { storage: adapter }).submit('cm.mobile', { phone: '+237670000000', country: 'CM' });
    await new PayClient({ ...instant, storage: adapter }).process('tok', 'cm.mobile', {});
    const fingerprints = api.callsTo('POST /pay/process').map((c) => c.body.data._client.fingerprint);
    const { installFingerprint } = require('../../client/device') as typeof import('../../client/device');
    expect(fingerprints).toEqual([await installFingerprint(adapter), await installFingerprint(adapter)]);

    // A read that fails (a busy database): an id for this run only — the stored one is never written over.
    const kept = new Map<string, string>([['@wajub/install-id', 'original-id']]);
    let failNext = true;
    const flaky: WajubStorage = {
      getItem: jest.fn(async (key: string) => {
        if (failNext) {
          failNext = false;
          throw new Error('SQLITE_BUSY');
        }
        return kept.get(key) ?? null;
      }),
      setItem: jest.fn(async (key: string, value: string) => void kept.set(key, value)),
    };
    const thisRun = await load(flaky);
    expect(thisRun).not.toBe(sha256Hex('device:original-id'));
    expect(flaky.setItem).not.toHaveBeenCalled();
    expect(kept.get('@wajub/install-id')).toBe('original-id');
    // The next run reads it again: the install's own fingerprint.
    expect(await load(flaky)).toBe(sha256Hex('device:original-id'));
  });

  it('TR-05 applies per-call timeouts', async () => {
    jest.useFakeTimers();
    api = fakeApi({ 'GET /pay/session': 'hang', 'POST /pay/process': 'hang', 'POST /pay/otp/verify': 'hang' });
    const client = new PayClient({ sleep: async () => undefined, errors: 'v2' });

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
    const pending = { status: 200, body: { ...body('status-processing'), transaction: { ...body('status-processing').transaction, status: 'pending' } } };
    const pay = async (controller: ReturnType<typeof makeController>['controller']) => {
      const choice = { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN', logo: null, label: 'MTN MoMo' };
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
      await settle();
    };

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
    await pay(controller);

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
    api.restore();

    // Still `pending` a minute after the last try: it never reached the API.
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'network',
      'GET /pay/status': pending,
    });
    const back = makeController({ onError, locale: 'en' });
    back.controller.start();
    await settle();
    back.controller.chooseMethod('mobile_money');
    onError.mockClear();
    await pay(back.controller);
    const key = api.callsTo('POST /pay/process')[0].headers['Idempotency-Key'];

    await jest.advanceTimersByTimeAsync(55_000);
    expect(back.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(back.controller.getSnapshot()).toMatchObject({
      state: 'COLLECTING_DETAILS',
      busy: false,
      banner: { code: 'network_error', retryable: true, message: 'Connection error. Check your network.' },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network_error' }));
    // The watch stopped.
    const polls = api.callsTo('GET /pay/status').length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(api.callsTo('GET /pay/status')).toHaveLength(polls);

    // The next Pay sends it again under the same key: if it had reached the API, the answer is replayed.
    api.answer('POST /pay/process', 'process-idempotent-replay');
    await pay(back.controller);
    const retried = api.callsTo('POST /pay/process');
    expect(retried[retried.length - 1].headers['Idempotency-Key']).toBe(key);
    expect(back.controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');

    // And a Pay after that gets a key of its own: the replay was an answer.
    // Here the payment is back at `pending` after it was seen processing: refused.
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(back.controller.getSnapshot().screen.name).toBe('failed');
    back.controller.tryAgain();
    api.answer('POST /pay/process', 'process-processing-mobile-money-live');
    await pay(back.controller);
    const keys = api.callsTo('POST /pay/process').map((c) => c.headers['Idempotency-Key']);
    expect(keys[keys.length - 1]).not.toBe(key);
    expect(keys.filter((k) => k === keys[keys.length - 1])).toHaveLength(1);
    back.controller.hostGone();
  });

  it('TR-09 applies the 60 s rule to 5xx answers, a 500 included', async () => {
    jest.useFakeTimers();
    const processing = body('status-processing');
    const pending = { status: 200, body: { ...processing, transaction: { ...processing.transaction, status: 'pending' } } };
    const choice = { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN', logo: null, label: 'MTN MoMo' };
    for (const [answer, tries] of [
      ['error-500-production', 1],
      [{ status: 502 }, 3],
      [{ status: 503 }, 3],
      [{ status: 504 }, 3],
    ] as Array<[Answer, number]>) {
      api = fakeApi({
        'GET /pay/session': 'session-cm-aggregate',
        'GET /pay/sdk-config': 'sdk-config-cm-stripe',
        'POST /pay/process': answer,
        'GET /pay/status': pending,
      });
      const onError = jest.fn();
      const { controller } = makeController({ onError, locale: 'en' });
      controller.start();
      await settle();
      controller.chooseMethod('mobile_money');
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
      await settle();
      // A 500 is not retried, a 502–504 is; either way the outcome is unknown: PENDING, no failure.
      expect(api.callsTo('POST /pay/process')).toHaveLength(tries);
      expect(controller.getSnapshot().state).toBe('PENDING');
      expect(onError).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', banner: { code: 'network_error', retryable: true } });
      const key = api.callsTo('POST /pay/process')[0].headers['Idempotency-Key'];
      api.answer('POST /pay/process', 'process-idempotent-replay');
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
      await settle();
      const calls = api.callsTo('POST /pay/process');
      expect(calls[calls.length - 1].headers['Idempotency-Key']).toBe(key);
      controller.hostGone();
      api.restore();
    }
  });

  it('TR-09 a decline the payment already carried does not hold the 60 s rule; a new one fails the attempt', async () => {
    jest.useFakeTimers();
    const processing = body('status-processing');
    const pendingWith = (code: string) => ({
      status: 200,
      body: { ...processing, transaction: { ...processing.transaction, status: 'pending', error_code: code, payer_message: 'Not enough money.' } },
    });
    const pay = async (controller: ReturnType<typeof makeController>['controller']) => {
      const choice = { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN', logo: null, label: 'MTN MoMo' };
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
      await settle();
    };

    // The status carries the decline of an earlier try, from before this sheet, and the session (a
    // 2.0 answer, without `transaction.error_code`) did not say: unknown — the 60 s rule still applies.
    const older = body('session-cm-aggregate');
    delete older.transaction.error_code;
    api = fakeApi({
      'GET /pay/session': { status: 200, body: older },
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'network',
      'GET /pay/status': pendingWith('insufficient_funds'),
    });
    const leftover = makeController({ locale: 'en' });
    leftover.controller.start();
    await settle();
    leftover.controller.chooseMethod('mobile_money');
    await pay(leftover.controller);
    expect(leftover.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(leftover.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', banner: { code: 'network_error' } });
    leftover.controller.hostGone();
    api.restore();

    // This sheet saw one decline; the status then shows another code: this attempt was refused.
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': ['process-402-insufficient-funds-sandbox', 'network'],
      'GET /pay/status': pendingWith('transaction_limit_exceeded'),
    });
    const fresh = makeController({ locale: 'en' });
    fresh.controller.start();
    await settle();
    fresh.controller.chooseMethod('mobile_money');
    await pay(fresh.controller);
    expect(fresh.controller.getSnapshot().screen.name).toBe('failed');
    fresh.controller.tryAgain();
    await pay(fresh.controller);
    expect(fresh.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(fresh.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { retryable: true } });
    fresh.controller.hostGone();
    api.restore();

    // The same code as the decline this sheet saw: an earlier try's, the 60 s rule applies.
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': ['process-402-insufficient-funds-sandbox', 'network'],
      'GET /pay/status': pendingWith('insufficient_funds'),
    });
    const same = makeController({ locale: 'en' });
    same.controller.start();
    await settle();
    same.controller.chooseMethod('mobile_money');
    await pay(same.controller);
    same.controller.tryAgain();
    await pay(same.controller);
    await jest.advanceTimersByTimeAsync(55_000);
    expect(same.controller.getSnapshot().state).toBe('PENDING');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(same.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', banner: { code: 'network_error' } });
    same.controller.hostGone();
  });

  it('TR-10 defaults to the production api', async () => {
    expect(API_URL).toBe('https://api.wajub.com');
    api = fakeApi({ 'GET /pay/status': 'status-processing' });
    await new PayClient().getStatus('tok');
    expect(api.fetch.mock.calls[0][0]).toBe('https://api.wajub.com/pay/status');
    expect(body('status-processing').transaction.status).toBe('processing');
  });
});
