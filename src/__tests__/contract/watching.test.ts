import { AppState } from 'react-native';

import type { PayClient } from '../../client/payClient';
import { decideStatus, POLLING, realtimeConfig, StatusWatcher } from '../../checkout/watcher';
import type { WatchOutcome } from '../../checkout/watcher';
import { makeController } from '../../test/checkout';
import { body, fakeApi, fixture, settle } from '../../test/fakeApi';
import type { FakeApi } from '../../test/fakeApi';
import FakePusher from '../../test/pusherMock';
import type { EchoConfig, PaymentStatus } from '../../types';
import { WajubError } from '../../WajubError';
import { parseSession, parseStatus } from '../../wire/parse';

const ECHO = parseSession(body('session-cm-aggregate')).echo!;

/** A client whose /pay/status answers `next()` — a status, or a thrown error. */
function client(next: () => PaymentStatus | Error) {
  const getStatus = jest.fn(async () => {
    const value = next();
    if (value instanceof Error) throw value;
    return value;
  });
  const broadcastingAuth = jest.fn(async () => body('broadcasting-auth-200'));
  return { getStatus, broadcastingAuth, client: { getStatus, broadcastingAuth } as unknown as PayClient };
}

const processing: PaymentStatus = { reference: 'trx_1', status: 'processing' };
const watchers: StatusWatcher[] = [];

function watch(
  c: PayClient,
  options: { echo?: EchoConfig | null; seenProcessing?: boolean; deadline?: number; realtime?: object; transactionId?: string } = {},
) {
  const outcomes: WatchOutcome[] = [];
  const watcher = new StatusWatcher({
    client: c,
    token: 'tok',
    transactionId: options.transactionId ?? 'trx_PVrU8x2kQ1mNa7Lb3cDe',
    echo: options.echo ?? null,
    realtime: options.realtime,
    lang: 'en',
    seenProcessing: options.seenProcessing ?? true,
    deadline: options.deadline ?? Date.now() + POLLING.overallCapMs,
    onOutcome: (o) => outcomes.push(o),
  });
  watchers.push(watcher);
  watcher.start();
  return { watcher, outcomes };
}

/** The times (ms after start) of every poll, up to `until`. */
async function pollTimes(getStatus: jest.Mock, until: number): Promise<number[]> {
  const start = Date.now();
  const times: number[] = [];
  getStatus.mockImplementation(async () => {
    times.push(Date.now() - start);
    return processing;
  });
  await jest.advanceTimersByTimeAsync(until);
  return times;
}

let api: FakeApi;
beforeEach(() => {
  FakePusher.instances.length = 0;
  jest.useFakeTimers();
});
afterEach(() => {
  watchers.splice(0).forEach((w) => w.stop());
  api?.restore();
  jest.useRealTimers();
});

describe('WT — watching', () => {
  it('WT-01 polls on schedule', async () => {
    // Every 5 s; after 2 minutes without a change, ×1.5 per poll up to 15 s.
    const plain = client(() => processing);
    watch(plain.client);
    const times = await pollTimes(plain.getStatus, 200_000);
    expect(times.slice(0, 3)).toEqual([5_000, 10_000, 15_000]);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(gaps.filter((g) => g === 5_000).length).toBe(23);
    expect(gaps.slice(23, 27)).toEqual([7_500, 11_250, 15_000, 15_000]);

    // 15 s while the socket is connected.
    const socket = client(() => processing);
    watch(socket.client, { echo: ECHO });
    FakePusher.instances[0].connect();
    const withSocket = await pollTimes(socket.getStatus, 46_000);
    expect(withSocket.slice(1).map((t, i) => t - withSocket[i])).toEqual([15_000, 15_000]);

    // Errors: min(5 s × 2^n, 60 s) ± 20 %, n consecutive failures; the schedule again on
    // success (here 7.5 s: more than 2 minutes without a change).
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    let n = 0;
    const failing = client(() => (++n <= 5 ? WajubError.create('network_error') : processing));
    watch(failing.client);
    const start = Date.now();
    const at: number[] = [];
    failing.getStatus.mockImplementation(async () => {
      at.push(Date.now() - start);
      if (++n <= 5) throw WajubError.create('network_error');
      return processing;
    });
    n = 0;
    await jest.advanceTimersByTimeAsync(300_000);
    expect(at.slice(0, 7)).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000, 202_500]);

    // The 15-minute cap: polling stops, the outcome is "still processing".
    const capped = client(() => processing);
    const { outcomes } = watch(capped.client, { deadline: Date.now() + POLLING.overallCapMs });
    await jest.advanceTimersByTimeAsync(POLLING.overallCapMs);
    expect(outcomes).toEqual([{ kind: 'cap' }]);
    const polls = capped.getStatus.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(capped.getStatus).toHaveBeenCalledTimes(polls);
  });

  it('WT-02 decides on status', async () => {
    const status = (name: string): PaymentStatus => parseStatus(body(name));
    expect(decideStatus(status('status-succeeded'), true, 'en')).toEqual({ kind: 'success' });
    for (const s of ['refunded', 'partially_refunded']) expect(decideStatus({ reference: 'x', status: s }, false, 'en')).toEqual({ kind: 'success' });
    expect(decideStatus(status('status-processing'), false, 'en')).toBeNull();
    expect(decideStatus({ reference: 'x', status: 'partial' }, true, 'en')).toBeNull();
    expect(decideStatus({ reference: 'x', status: 'failed' }, true, 'en')).toMatchObject({ kind: 'failed', error: { code: 'payment_failed', retryable: false } });
    expect(decideStatus({ reference: 'x', status: 'cancelled' }, true, 'en')).toMatchObject({ kind: 'cancelled', error: { code: 'payment_cancelled' } });
    expect(decideStatus({ reference: 'x', status: 'expired' }, true, 'en')).toMatchObject({ kind: 'expired', error: { code: 'session_expired' } });

    // `pending` before this attempt was seen processing: the last attempt's leftover.
    expect(decideStatus(status('status-pending-attempt-refused'), false, 'en')).toBeNull();
    // After: the attempt ended without charging.
    for (const name of ['status-pending-attempt-refused', 'status-pending-attempt-refused-live']) {
      expect(decideStatus(status(name), true, 'en')).toMatchObject({
        kind: 'failed',
        error: { code: 'insufficient_funds', decline_code: 'insufficient_funds', retryable: true, message: 'Insufficient funds.' },
      });
    }
    expect(decideStatus({ reference: 'x', status: 'pending' }, true, 'fr')).toMatchObject({ kind: 'failed', error: { code: 'payment_attempt_ended', retryable: true } });

    // The watcher itself: pending seen first is ignored, then processing, then pending ends it.
    const sequence = ['status-pending-attempt-refused', 'status-processing', 'status-pending-attempt-refused'].map(status);
    const flow = client(() => sequence.shift() ?? processing);
    const { outcomes } = watch(flow.client, { seenProcessing: false });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(outcomes).toMatchObject([{ kind: 'failed', error: { code: 'insufficient_funds' } }]);

    // An ended session: 410 → EXPIRED, 401 → session_not_found; no more polls.
    for (const [name, kind, code] of [
      ['error-410-session-terminal-expired', 'expired', 'session_terminal_expired'],
      ['error-401-invalid-token', 'failed', 'session_not_found'],
    ]) {
      const f = fixture(name);
      const ended = client(() => WajubError.fromResponse({ status: f.http_status, body: f.body }));
      const watched = watch(ended.client);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(watched.outcomes).toMatchObject([{ kind, error: { code } }]);
      expect(ended.getStatus).toHaveBeenCalledTimes(1);
    }
  });

  it('WT-03 subscribes to the payment channel', async () => {
    // Self-hosted Reverb, hosted Pusher, and a Reverb behind another hostname.
    expect(realtimeConfig(ECHO, undefined)).toEqual({ key: 'wajub-app-key', host: 'ws.wajub.com', port: 443, tls: true, channelPrefix: 'private-payment.' });
    const pusher = parseSession(body('session-ci-xof-wallets')).echo!;
    expect(realtimeConfig(pusher, undefined)).toMatchObject({ key: 'pusher-app-key', host: 'ws-eu.pusher.com', port: 443, tls: true });
    expect(realtimeConfig(ECHO, { host: 'reverb.shop.example', port: 8080, tls: false })).toMatchObject({ host: 'reverb.shop.example', port: 8080, tls: false });
    expect(realtimeConfig({ ...ECHO, ws_host: 'ws://localhost', ws_port: 6001 }, undefined)).toMatchObject({ host: 'localhost', port: 6001, tls: false });

    const c = client(() => processing);
    watch(c.client, { echo: ECHO, realtime: { host: 'reverb.shop.example', port: 8080, tls: false } });
    const socket = FakePusher.instances[0];
    expect(socket.key).toBe('wajub-app-key');
    expect(socket.options).toMatchObject({ wsHost: 'reverb.shop.example', wsPort: 8080, wssPort: 8080, forceTLS: false });
    // pusher-js names its TLS socket "ws" too (with forceTLS): it must stay enabled.
    expect(socket.options.enabledTransports).toEqual(['ws', 'wss']);
    watch(c.client, { echo: ECHO });
    expect(FakePusher.instances[1].options).toMatchObject({ wsHost: 'ws.wajub.com', wsPort: 443, wssPort: 443, forceTLS: true, enabledTransports: ['ws', 'wss'] });
    FakePusher.instances.length = 1;
    expect([...socket.channels.keys()]).toEqual(['private-payment.trx_PVrU8x2kQ1mNa7Lb3cDe']);
    expect(socket.channels.get('private-payment.trx_PVrU8x2kQ1mNa7Lb3cDe')!.bind).toHaveBeenCalledWith('PaymentStatusUpdated', expect.any(Function));

    // Authorized by /pay/broadcasting/auth with the session's bearer token.
    api = fakeApi({ 'POST /pay/broadcasting/auth': 'broadcasting-auth-200' });
    const { PayClient } = jest.requireActual('../../client/payClient') as typeof import('../../client/payClient');
    const real = new PayClient();
    watch(real, { echo: ECHO });
    const authorize = (FakePusher.instances[1].options as { channelAuthorization: { customHandler: Function } }).channelAuthorization.customHandler;
    const callback = jest.fn();
    authorize({ socketId: '1234.5678', channelName: 'private-payment.trx_PVrU8x2kQ1mNa7Lb3cDe' }, callback);
    await settle();
    const call = api.callsTo('POST /pay/broadcasting/auth')[0];
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.body).toEqual({ socket_id: '1234.5678', channel_name: 'private-payment.trx_PVrU8x2kQ1mNa7Lb3cDe' });
    expect(callback).toHaveBeenCalledWith(null, { auth: 'wajub-app-key:SIGNATURE' });
  });

  it('WT-04 falls back to polling', async () => {
    // `key: null` (sandbox), no echo, realtime turned off: no socket, polling at 5 s.
    for (const echo of [parseSession(body('session-sandbox-cm')).echo!, null]) {
      const c = client(() => processing);
      watch(c.client, { echo });
      expect(FakePusher.instances).toHaveLength(0);
      expect(await pollTimes(c.getStatus, 15_000)).toEqual([5_000, 10_000, 15_000]);
    }
    const off = client(() => processing);
    watch(off.client, { echo: ECHO, realtime: { enabled: false } });
    expect(FakePusher.instances).toHaveLength(0);

    // A socket that never connects (or drops) leaves polling at 5 s.
    const never = client(() => processing);
    watch(never.client, { echo: ECHO });
    expect(await pollTimes(never.getStatus, 15_000)).toEqual([5_000, 10_000, 15_000]);
  });

  it('WT-05 decides on realtime events', async () => {
    for (const [name, expected] of [
      ['realtime-payment-status-updated-succeeded', 'success'],
      ['realtime-payment-status-updated-failed', 'failed'],
      ['realtime-payment-status-updated-refused', 'failed'],
    ] as const) {
      for (const encode of [(d: unknown) => d, (d: unknown) => JSON.stringify(d)]) {
        const f = fixture(name);
        const c = client(() => processing);
        const { outcomes } = watch(c.client, { echo: ECHO, transactionId: f.channel!.replace('private-payment.', '') });
        const socket = FakePusher.instances[FakePusher.instances.length - 1];
        socket.emit(f.channel!, f.event!, encode(f.data));
        expect(outcomes).toMatchObject([{ kind: expected }]);
      }
    }
    const f = fixture('realtime-payment-status-updated-processing');
    const c = client(() => processing);
    const { outcomes } = watch(c.client, { echo: ECHO, transactionId: f.channel!.replace('private-payment.', '') });
    FakePusher.instances[FakePusher.instances.length - 1].emit(f.channel!, f.event!, JSON.stringify(f.data));
    expect(outcomes).toEqual([]);
  });

  it('WT-06 stops watching on close', async () => {
    api = fakeApi({
      'GET /pay/session': 'session-cm-aggregate',
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': 'process-processing-mobile-money-live',
      'GET /pay/status': 'status-processing',
    });
    for (const close of ['dismiss', 'hostGone'] as const) {
      FakePusher.instances.length = 0;
      const { controller } = makeController();
      controller.start();
      await settle();
      controller.chooseMethod('mobile_money');
      const mtn = { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN', logo: null, label: 'MTN MoMo' };
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      await jest.advanceTimersByTimeAsync(5_000);
      const polls = api.callsTo('GET /pay/status').length;
      expect(polls).toBeGreaterThan(0);
      const socket = FakePusher.instances[0];

      controller[close]();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(api.callsTo('GET /pay/status')).toHaveLength(polls);
      expect(socket.disconnect).toHaveBeenCalled();
      expect(socket.unsubscribe).toHaveBeenCalledWith('private-payment.trx_PVrU8x2kQ1mNa7Lb3cDe');
      api.calls.length = 0;
    }
    // Paused in the background, polled at once on the way back.
    const c = client(() => processing);
    watch(c.client);
    (AppState as unknown as { emit(s: string): void }).emit('background');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(c.getStatus).not.toHaveBeenCalled();
    (AppState as unknown as { emit(s: string): void }).emit('active');
    await jest.advanceTimersByTimeAsync(0);
    expect(c.getStatus).toHaveBeenCalledTimes(1);
  });
});
