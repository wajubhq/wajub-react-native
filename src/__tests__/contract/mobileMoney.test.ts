import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { sha256Hex } from '../../crypto';
import rawData from '../../data/mobile-money.json';
import {
  detectOperator,
  formatAsYouType,
  isValidNumber,
  loadMobileMoneyData,
  mobileMoneyData,
  nationalDigits,
  operatorLabel,
  sandboxTestNumber,
  toE164,
} from '../../mobileMoney/data';
import { initialChoice, operatorChoices, operatorHint, preselect, validateMobileMoney } from '../../mobileMoney/form';
import type { OperatorChoice } from '../../mobileMoney/form';
import { makeController } from '../../test/checkout';
import { body, fakeApi, fixture, settle } from '../../test/fakeApi';
import type { Answer, FakeApi } from '../../test/fakeApi';
import { parseSession } from '../../wire/parse';

const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', '__fixtures__', 'mobile-money.vectors.json'), 'utf8'));

function choice(id: string, viaAggregate = false): OperatorChoice {
  return { id, channel: viaAggregate ? 'cm.mobile' : `xx.${id}`, viaAggregate, name: id, logo: null, label: operatorLabel(id, id) };
}

let api: FakeApi;
afterEach(() => {
  api?.restore();
  jest.useRealTimers();
});

async function sheet(session: Answer | Answer[], process: Answer | Answer[], options = {}) {
  api = fakeApi({
    'GET /pay/session': session,
    'GET /pay/sdk-config': 'sdk-config-cm-stripe',
    'POST /pay/process': process,
    'GET /pay/status': 'status-processing',
  });
  const callbacks = { onStateChange: jest.fn(), onError: jest.fn(), onPaymentStarted: jest.fn() };
  const { controller, openUrl } = makeController({ ...callbacks, ...options });
  controller.start();
  await settle();
  controller.chooseMethod('mobile_money');
  return { controller, openUrl, ...callbacks };
}

describe('MM — Mobile Money', () => {
  it('MM-01 matches the number vectors', () => {
    for (const v of vectors.numbers) {
      expect([v.input, nationalDigits(v.input, v.country)]).toEqual([v.input, v.national_digits]);
      expect([v.input, isValidNumber(v.input, v.country)]).toEqual([v.input, v.valid]);
      expect([v.input, detectOperator(v.input, v.country)]).toEqual([v.input, v.detected_operator]);
      expect([v.input, toE164(v.input, v.country)]).toEqual([v.input, v.e164]);
      expect([v.input, formatAsYouType(v.input)]).toEqual([v.input, v.formatted]);
    }
    // Devanagari and full-width digits, and the astral mathematical ones, read as ASCII too.
    expect(nationalDigits('०७०७०००००० ', 'CI')).toBe('0707000000');
    expect(nationalDigits('６７７１２３４５６', 'CM')).toBe('677123456');
    expect(nationalDigits('𝟔𝟕𝟕𝟏𝟐𝟑𝟒𝟓𝟔', 'CM')).toBe('677123456');
    // Arabic-Indic and Persian keyboards type other digits: the same number is read.
    expect(nationalDigits('٦٧٧ ١٢ ٣٤ ٥٦', 'CM')).toBe('677123456');
    expect(isValidNumber('٦٧٧١٢٣٤٥٦', 'CM')).toBe(true);
    expect(detectOperator('٦٧٧١٢٣٤٥٦', 'CM')).toBe('mtn');
    expect(toE164('۰۷ ۱۲ ۳۴ ۵۶ ۷۸', 'CI')).toBe('+2250712345678');
    expect(formatAsYouType('+٢٣٧ ٦٧٧١٢٣٤٥٦')).toBe('23 76 77 12 34 56');
    // A country outside the tables keeps an international number valid E.164.
    expect(toE164('+33612345678', 'FR')).toBe('+33612345678');
    expect(toE164('0033 6 12 34 56 78', 'FR')).toBe('+33612345678');
  });

  it('MM-10 takes the sandbox test numbers', async () => {
    for (const v of vectors.sandbox_numbers) {
      const test = sandboxTestNumber(v.input, v.country);
      expect([v.input, v.country, test]).toEqual([v.input, v.country, v.operator ? { operator: v.operator, e164: v.e164 } : null]);
      if (!v.operator) continue;
      // In a sandbox session: valid, the prefix's operator, sent as read.
      expect([v.input, isValidNumber(v.input, v.country, true)]).toEqual([v.input, true]);
      expect([v.input, detectOperator(v.input, v.country, true)]).toEqual([v.input, v.operator]);
      expect([v.input, toE164(v.input, v.country, true)]).toEqual([v.input, v.e164]);
    }

    // Outside a sandbox session the prefixes mean nothing: the numbering plan decides.
    // Test numbers no plan allows are refused…
    for (const [input, country] of [['+229900000000', 'BJ'], ['+225070000000', 'CI'], ['07000000', 'CI'], ['0000000', 'GA'], ['+2376700000000', 'CM']]) {
      expect([input, isValidNumber(input, country, true)]).toEqual([input, true]);
      expect([input, isValidNumber(input, country)]).toEqual([input, false]);
    }
    // …a test prefix names the operator of the plan's range, not the sandbox's…
    const readings: Array<[string, string, string, string | null]> = [
      ['+22991000000', 'BJ', 'moov', 'mtn'],
      ['680000000', 'CM', 'eu', 'mtn'],
      ['03 00 00 00 09', 'CI', 'wave', null],
    ];
    for (const [input, country, test, plan] of readings) {
      expect([input, detectOperator(input, country, true)]).toEqual([input, test]);
      expect([input, detectOperator(input, country)]).toEqual([input, plan]);
    }
    // …and a number is sent in the plan's form, not as read.
    expect(toE164('0000000', 'GA', true)).toBe('+2410000000');
    expect(toE164('0000000', 'GA')).not.toBe('+2410000000');

    // Through the sheet: a test number the plan refuses goes out as read in a sandbox session…
    const sandbox = await sheet('session-sandbox-cm', 'process-processing-mobile-money-sandbox');
    const mtn = operatorChoices(sandbox.controller.getSnapshot().session!.channels, 'CM', 'en').find((c) => c.id === 'mtn')!;
    await sandbox.controller.payMobileMoney({ phone: '+2376700000000', country: 'CM', choice: mtn, pickedByHand: true });
    await settle();
    expect(api.callsTo('POST /pay/process')[0].body.data).toMatchObject({ phone: '+2376700000000', country: 'CM' });
    sandbox.controller.hostGone();
    api.restore();

    // A sandbox session stays one when a later answer leaves the key out: after a refusal, a test
    // number the plan refuses is still taken, and the payment's transaction still says sandbox.
    api.restore();
    jest.useFakeTimers();
    const keyless = body('process-processing-mobile-money-sandbox');
    delete keyless.transaction.sandbox;
    const kept = await sheet('session-sandbox-cm', [{ status: 202, body: keyless }, 'process-processing-mobile-money-sandbox']);
    const keptMtn = operatorChoices(kept.controller.getSnapshot().session!.channels, 'CM', 'en').find((c) => c.id === 'mtn')!;
    await kept.controller.payMobileMoney({ phone: '670000000', country: 'CM', choice: keptMtn, pickedByHand: true });
    await settle();
    api.answer('GET /pay/status', 'status-pending-attempt-refused');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(kept.controller.getSnapshot().screen.name).toBe('failed');
    kept.controller.tryAgain();
    api.answer('GET /pay/status', 'status-processing');
    await kept.controller.payMobileMoney({ phone: '+2376700000000', country: 'CM', choice: keptMtn, pickedByHand: true });
    await settle();
    expect(api.callsTo('POST /pay/process').map((c) => c.body.data.phone)).toEqual(['+237670000000', '+2376700000000']);
    kept.controller.dismiss();
    await expect(kept.controller.result).resolves.toMatchObject({ status: 'processing', transaction: { sandbox: true } });
    api.restore();
    jest.useRealTimers();

    // …and is refused in a live one.
    const live = await sheet('session-cm-aggregate', 'process-processing-mobile-money-live', { locale: 'en' });
    const liveMtn = operatorChoices(live.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await live.controller.payMobileMoney({ phone: '+2376700000000', country: 'CM', choice: liveMtn, pickedByHand: true });
    await settle();
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    expect(live.controller.getSnapshot().fieldErrors.phone).toBeTruthy();
    live.controller.hostGone();
  });

  it('MM-02 matches the mismatch vectors', () => {
    for (const v of vectors.validation_and_mismatch) {
      const choices = v.choices.map((id: string) => choice(id));
      const sandbox = v.sandbox === true;
      const problem = validateMobileMoney(v.phone, v.country, choices, v.selected, sandbox);
      expect([v.phone, v.selected, problem?.code ?? null]).toEqual([v.phone, v.selected, v.expected]);
      expect(detectOperator(v.phone, v.country, sandbox)).toBe(v.detected);
      if (problem?.code === 'operator_mismatch') {
        expect(problem.detected).toBe(v.detected);
        expect(problem.detectedLabel).toBe(operatorLabel(v.detected, v.detected));
      }
    }
    // No operator selected at all.
    expect(validateMobileMoney('677123456', 'CM', [choice('mtn')], null)?.code).toBe('operator_required');
  });

  it('MM-03 matches the preselection vectors', () => {
    for (const v of vectors.preselection) {
      const choices = v.choices.map((id: string) => choice(id));
      // Before any number: the first network operator, never a wallet held whatever the operator.
      const current = v.picked_by_hand ?? initialChoice(choices);
      expect([v.phone, preselect(current, v.picked_by_hand !== null, v.phone, v.country, choices)]).toEqual([v.phone, v.expected_selection]);
    }
    // Every choice a wallet held whatever the operator: the first; none at all: nothing.
    expect(initialChoice([choice('eu'), choice('mtn')])).toBe('mtn');
    expect(initialChoice([choice('wave'), choice('eu')])).toBe('wave');
    expect(initialChoice([])).toBeNull();
  });

  it('MM-04 lists aggregate operators', () => {
    const cm = operatorChoices(parseSession(body('session-cm-aggregate')).channels, 'CM', 'fr');
    expect(cm).toEqual([
      // The image the sheet can draw: the operator's PNG (CH-06).
      { id: 'mtn', channel: 'cm.mobile', viaAggregate: true, name: 'MTN Mobile Money', logo: 'https://api.wajub.com/img/channels/momo.png', label: 'MTN MoMo' },
      { id: 'orange', channel: 'cm.mobile', viaAggregate: true, name: 'Orange Money', logo: 'https://api.wajub.com/img/channels/om.png', label: 'Orange Money' },
    ]);
    // SVG logos without a PNG (a 2.0 answer): none the sheet can draw — brand badges.
    const ci = operatorChoices(parseSession(body('session-ci-xof-wallets')).channels, 'CI', 'en');
    expect(ci.map((c) => [c.id, c.channel, c.viaAggregate, c.logo])).toEqual([
      ['mtn', 'ci.mtn', false, null],
      ['moov', 'ci.moov', false, null],
      ['orange', 'ci.orange', false, null],
      ['wave', 'ci.wave', false, null],
    ]);
  });

  it('MM-05 builds the mobile money request', async () => {
    for (const v of vectors.operator_hint) {
      const c = choice(v.selected, v.channel.endsWith('.mobile'));
      expect([v.channel, operatorHint(c, v.picked_by_hand, v.detected)]).toEqual([v.channel, v.send_operator]);
    }

    // The fixture's request: cm.mobile, E.164, the operator read from the number.
    const { controller } = await sheet('session-sandbox-cm', 'process-processing-mobile-money-sandbox');
    const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en').find((c) => c.id === 'mtn')!;
    await controller.payMobileMoney({ phone: '67 00 00 00 0', country: 'CM', choice: mtn, pickedByHand: false });
    const sent = api.callsTo('POST /pay/process')[0].body;
    const reference = fixture('process-processing-mobile-money-sandbox').request!.body as { channel: string; data: Record<string, unknown> };
    expect(sent.channel).toBe(reference.channel);
    expect({ ...sent.data, _client: undefined }).toEqual({ ...reference.data, _client: undefined });
    controller.hostGone();
  });

  it('MM-06 shows the approval screen', async () => {
    jest.useFakeTimers();
    for (const name of ['process-processing-mobile-money-live', 'process-processing-mobile-money-sandbox']) {
      const { controller, onStateChange } = await sheet('session-cm-aggregate', name);
      const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      await settle();
      const instruction = body(name).transaction.processing_context.payer_instruction;
      expect(controller.getSnapshot().screen).toEqual({ name: 'approval', phone: '+237677123456', instruction });
      expect(onStateChange).toHaveBeenLastCalledWith({ state: 'APPROVAL_REQUIRED', method: 'mobile_money' });
      // Watching; Pay is not offered again.
      await jest.advanceTimersByTimeAsync(5000);
      expect(api.callsTo('GET /pay/status')).toHaveLength(1);
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      expect(api.callsTo('POST /pay/process')).toHaveLength(1);
      controller.hostGone();
      api.restore();
    }
  });

  it('MM-08 reads mismatches in sandbox from the test number', async () => {
    // Sandbox: an MTN test number on Orange stops on the field, as the sandbox would refuse it…
    const sandbox = await sheet('session-sandbox-cm', 'process-processing-mobile-money-sandbox', { locale: 'en' });
    const choices = operatorChoices(sandbox.controller.getSnapshot().session!.channels, 'CM', 'en');
    const orange = choices.find((c) => c.id === 'orange')!;
    const mtn = choices.find((c) => c.id === 'mtn')!;
    await sandbox.controller.payMobileMoney({ phone: '670000000', country: 'CM', choice: orange, pickedByHand: true });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    expect(sandbox.controller.getSnapshot().fieldErrors.phone).toMatch(/MTN MoMo/);
    // …+23768… tests Express Union there, where the plan has MTN: not an MTN number…
    await sandbox.controller.payMobileMoney({ phone: '680000000', country: 'CM', choice: mtn, pickedByHand: true });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    // …and an MTN test number on MTN goes out.
    await sandbox.controller.payMobileMoney({ phone: '670000000', country: 'CM', choice: mtn, pickedByHand: true });
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    sandbox.controller.hostGone();
    api.restore();

    // Live: the same mismatch stops on the field, in the payer's language.
    const live = await sheet('session-cm-aggregate', 'process-processing-mobile-money-live');
    await live.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: { ...orange, channel: 'cm.mobile' }, pickedByHand: true });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    expect(live.controller.getSnapshot().fieldErrors.phone).toBe(
      'Ce numéro est un numéro MTN MoMo. Choisissez MTN MoMo dans la liste, ou saisissez un numéro Orange Money.',
    );
    expect(live.onError).not.toHaveBeenCalled();
    live.controller.hostGone();
  });

  it('MM-09 loads the shared data file', () => {
    expect(mobileMoneyData()).toBe(loadMobileMoneyData(rawData));
    expect(mobileMoneyData().schema_version).toBe(2);
    expect(() => loadMobileMoneyData({ ...rawData, schema_version: 1 })).toThrow(/schema_version/);
    expect(() => loadMobileMoneyData({ ...rawData, schema_version: 3 })).toThrow(/schema_version/);
    expect(() => loadMobileMoneyData(null)).toThrow(/schema_version/);

    // No second copy of the tables in code: no brand colour, no dial code, no prefix list.
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return ['__tests__', '__fixtures__', 'test', 'data'].includes(name) ? [] : sources(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    for (const file of sources(join(__dirname, '..', '..'))) {
      const source = readFileSync(file, 'utf8');
      expect([file, /#FFCC00|'\+237'|'\+225'|'677'|starts_with: \[/i.test(source)]).toEqual([file, false]);
    }
  });
});

describe('AL — Altcha', () => {
  it('AL-01 solves altcha challenges', async () => {
    const salt = 'a1b2c3d4e5?expires=1760434200';
    const raw = body('session-cm-aggregate');
    raw.altcha = { algorithm: 'SHA-256', challenge: sha256Hex(`${salt}4242`), salt, signature: 'SIGNATURE', maxnumber: 10_000 };
    const { controller } = await sheet({ status: 200, body: raw }, 'process-processing-mobile-money-live');
    const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle();

    expect(api.callsTo('POST /pay/process')[0].body.data.altcha).toEqual({
      algorithm: 'SHA-256',
      challenge: raw.altcha.challenge,
      number: 4242,
      salt,
      signature: 'SIGNATURE',
    });
    controller.hostGone();
    api.restore();

    // Refused (422): the session is read again for a new challenge, solved, and the request sent once more.
    // The API names no error_code: a malformed solution comes under `data.altcha`, a wrong one only by its message.
    const refused = {
      status: 422,
      body: { code: 422, status: 'Unprocessable Content', message: 'The data.altcha field must be an array.', errors: { 'data.altcha': ['The data.altcha field must be an array.'] } },
    };
    const fresh = body('session-cm-aggregate');
    fresh.altcha = { ...raw.altcha, challenge: sha256Hex(`${salt}77`) };
    api = fakeApi({
      'GET /pay/session': [{ status: 200, body: raw }, { status: 200, body: fresh }],
      'GET /pay/sdk-config': 'sdk-config-card-paystack',
      'POST /pay/client-session': [refused, 'client-session-start-202'],
      'GET /pay/status': 'status-processing',
    });
    const card = makeController();
    card.controller.start();
    await settle();
    card.controller.chooseMethod('card');
    await card.controller.payCard({ email: 'chidi.okafor@example.com' });
    await settle(30);
    const sent = api.callsTo('POST /pay/client-session').map((c) => c.body.altcha.number);
    expect(sent).toEqual([4242, 77]);
    expect(card.controller.getSnapshot().state).toBe('PENDING');
    card.controller.hostGone();
    api.restore();

    // Refused by message only (a wrong solution), twice: security_check_failed, retryable.
    const wrong = {
      status: 422,
      body: {
        code: 422,
        status: 'Unprocessable Entity',
        message: 'Security challenge verification failed. Please refresh the page and try again.',
        errors: { request: ['Security challenge verification failed. Please refresh the page and try again.'] },
      },
    };
    api = fakeApi({
      'GET /pay/session': [{ status: 200, body: raw }, { status: 200, body: fresh }],
      'GET /pay/sdk-config': 'sdk-config-cm-stripe',
      'POST /pay/process': [wrong, wrong, 'process-processing-mobile-money-live'],
      'GET /pay/status': 'status-processing',
    });
    const twice = makeController();
    twice.controller.start();
    await settle();
    twice.controller.chooseMethod('mobile_money');
    const mtn2 = operatorChoices(twice.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await twice.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn2, pickedByHand: true });
    await settle(30);
    expect(api.callsTo('POST /pay/process')).toHaveLength(2);
    expect(twice.controller.getSnapshot().screen).toMatchObject({ name: 'failed', error: { code: 'security_check_failed', retryable: true } });
    // Try again: a new attempt with a new challenge, not the solution already sent.
    twice.controller.tryAgain();
    await settle(30);
    await twice.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn2, pickedByHand: true });
    await settle();
    const numbers = api.callsTo('POST /pay/process').map((c) => `${c.body.data.altcha.challenge}:${c.body.data.altcha.number}`);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(2);
    expect(numbers[2]).not.toBe(numbers[0]);
    expect(twice.controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    twice.controller.hostGone();
    api.restore();

    // Closed while the challenge is still being solved: the attempt began at the Pay press, as
    // while Stripe tokenizes — `processing`; nothing is sent, nothing cancelled.
    const hard = body('session-cm-aggregate');
    hard.altcha = { ...raw.altcha, challenge: sha256Hex(`${salt}9999`) };
    const closing = await sheet({ status: 200, body: hard }, 'process-processing-mobile-money-live');
    closing.controller.chooseMethod('mobile_money');
    const choice = operatorChoices(closing.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    api.answer('POST /pay/cancel', 'cancel-200');
    const paying = closing.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice, pickedByHand: true });
    closing.controller.dismiss();
    await paying;
    await settle();
    await expect(closing.controller.result).resolves.toMatchObject({ status: 'processing' });
    expect(api.callsTo('POST /pay/process')).toHaveLength(0);
    // Pay was pressed: the attempt is undecided from then on, nothing is cancelled (README §14).
    expect(api.callsTo('POST /pay/cancel')).toHaveLength(0);
  });

  /**
   * An Altcha server: every session read issues a challenge of its own, and
   * /pay/process takes one solution once, for a challenge it issued.
   */
  function altchaServer(process: Answer[], options: { altcha?: boolean } = {}) {
    const salt = 'a1b2c3d4e5?expires=1760434200';
    let next = 11;
    let altcha = options.altcha ?? true;
    const issued = new Set<string>();
    const used = new Set<string>();
    const refused = {
      status: 422,
      body: {
        code: 422,
        status: 'Unprocessable Entity',
        message: 'Security challenge verification failed. Please refresh the page and try again.',
        errors: { request: ['Security challenge verification failed. Please refresh the page and try again.'] },
      },
    };
    const sessionRead: Answer = () => {
      const raw = body('session-cm-aggregate');
      if (altcha) {
        const n = next++;
        raw.altcha = { algorithm: 'SHA-256', challenge: sha256Hex(`${salt}${n}`), salt, signature: `SIG-${n}`, maxnumber: 10_000 };
        issued.add(raw.altcha.challenge);
      }
      return { status: 200, body: raw };
    };
    const answers = [...process];
    const processCall: Answer = (call) => {
      if (altcha) {
        const solution = call.body.data.altcha;
        const valid =
          solution &&
          issued.has(solution.challenge) &&
          !used.has(solution.challenge) &&
          sha256Hex(`${solution.salt}${solution.number}`) === solution.challenge;
        if (!valid) return refused;
        used.add(solution.challenge);
      }
      return answers.length > 1 ? answers.shift()! : answers[0];
    };
    return {
      sessionRead,
      processCall,
      issued,
      used,
      turnOn: () => {
        altcha = true;
      },
    };
  }
  const decline = 'process-402-insufficient-funds-sandbox';

  it('AL-01 sends each challenge once, and nothing without a solution', async () => {
    // Declined twice, then accepted: three attempts, three challenges, each issued for it.
    const server = altchaServer([decline, decline, 'process-processing-mobile-money-live']);
    const { controller } = await sheet(server.sessionRead, server.processCall);
    const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    for (let i = 0; i < 3; i++) {
      if (i > 0) controller.tryAgain();
      await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
      await settle(30);
    }
    const sent = api.callsTo('POST /pay/process').map((c) => c.body.data.altcha?.challenge);
    expect(sent).toHaveLength(3);
    expect(sent.every((challenge) => server.issued.has(challenge))).toBe(true);
    expect(new Set(sent).size).toBe(3);
    expect(server.used.size).toBe(3);
    expect(controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    controller.hostGone();
    api.restore();

    // Pay again before the next challenge is back: the request waits for it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = altchaServer([decline, 'process-processing-mobile-money-live']);
    let reads = 0;
    const second = await sheet(
      (call) => {
        reads += 1;
        return slow.sessionRead(call);
      },
      slow.processCall,
    );
    const realFetch = api.fetch.getMockImplementation()!;
    api.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pay/session') && reads >= 1) await held;
      return realFetch(url, init);
    });
    await second.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    expect(second.controller.getSnapshot().screen.name).toBe('failed');
    second.controller.tryAgain();
    const paying = second.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    expect(second.controller.getSnapshot()).toMatchObject({ state: 'PROCESSING', busy: true });
    release();
    await paying;
    await settle(30);
    const challenges = api.callsTo('POST /pay/process').map((c) => c.body.data.altcha?.challenge);
    expect(challenges).toHaveLength(2);
    expect(challenges[1]).toBeDefined();
    expect(challenges[1]).not.toBe(challenges[0]);
    expect(second.controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    second.controller.hostGone();
    api.restore();

    // The next challenge cannot be had: nothing is sent, the form says so; the next Pay asks again.
    const down = altchaServer([decline, 'process-processing-mobile-money-live']);
    // Four tries for the one fetched ahead after the first Pay, four more when the second Pay asks again.
    const unavailable: Answer[] = Array.from({ length: 8 }, () => ({ status: 503 }));
    const failing = await sheet([down.sessionRead, ...unavailable, down.sessionRead], down.processCall);
    await failing.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    failing.controller.tryAgain();
    await failing.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    expect(failing.controller.getSnapshot()).toMatchObject({ state: 'COLLECTING_DETAILS', busy: false, banner: { retryable: true } });
    expect(failing.onError).toHaveBeenLastCalledWith(expect.objectContaining({ retryable: true }));
    expect(api.callsTo('GET /pay/session')).toHaveLength(9);
    await failing.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    const after = api.callsTo('POST /pay/process');
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.body.data.altcha && down.issued.has(c.body.data.altcha.challenge))).toBe(true);
    expect(after[1].body.data.altcha.challenge).not.toBe(after[0].body.data.altcha.challenge);
    expect(failing.controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    failing.controller.hostGone();
  });

  it('AL-02 recognises the altcha refusal by its code', async () => {
    const salt = 'a1b2c3d4e5?expires=1760434200';
    const withChallenge = (n: number) => {
      const raw = body('session-cm-aggregate');
      raw.altcha = { algorithm: 'SHA-256', challenge: sha256Hex(`${salt}${n}`), salt, signature: `SIG-${n}`, maxnumber: 10_000 };
      return { status: 200, body: raw };
    };
    const refusal = 'process-422-security-check-failed';

    // Refused once: the session read again for a new challenge, solved, sent again under a new key.
    const once = await sheet([withChallenge(31), withChallenge(32)], [refusal, 'process-processing-mobile-money-live']);
    const mtn = operatorChoices(once.controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await once.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    const calls = api.callsTo('POST /pay/process');
    expect(calls.map((c) => c.body.data.altcha.number)).toEqual([31, 32]);
    expect(calls[1].headers['Idempotency-Key']).not.toBe(calls[0].headers['Idempotency-Key']);
    expect(once.controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    expect(once.onError).not.toHaveBeenCalled();
    once.controller.hostGone();
    api.restore();

    // Refused twice: security_check_failed, retryable — not field errors.
    const twice = await sheet([withChallenge(33), withChallenge(34)], [refusal, refusal]);
    await twice.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    expect(api.callsTo('POST /pay/process')).toHaveLength(2);
    expect(twice.controller.getSnapshot()).toMatchObject({ fieldErrors: {}, screen: { name: 'failed', error: { code: 'security_check_failed', retryable: true } } });
    twice.controller.hostGone();
    api.restore();

    // The same refusal from /pay/client-session.
    api = fakeApi({
      'GET /pay/session': [withChallenge(35), withChallenge(36)],
      'GET /pay/sdk-config': 'sdk-config-card-paystack',
      'POST /pay/client-session': ['client-session-422-security-check-failed', 'client-session-start-202'],
      'GET /pay/status': 'status-processing',
    });
    const card = makeController();
    card.controller.start();
    await settle();
    card.controller.chooseMethod('card');
    await card.controller.payCard({ email: 'chidi.okafor@example.com' });
    await settle(30);
    expect(api.callsTo('POST /pay/client-session').map((c) => c.body.altcha.number)).toEqual([35, 36]);
    expect(card.controller.getSnapshot().state).toBe('PENDING');
    card.controller.hostGone();
    api.restore();

    // Another 422 with the Altcha message but a code of its own is not an Altcha refusal.
    const other = { status: 422, body: { ...body(refusal), error_code: 'invalid_phone', errors: { 'data.phone': ['Security challenge verification failed.'] } } };
    const notAltcha = await sheet([withChallenge(37)], [other]);
    await notAltcha.controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    expect(api.callsTo('POST /pay/process')).toHaveLength(1);
    expect(api.callsTo('GET /pay/session')).toHaveLength(2);
    expect(notAltcha.controller.getSnapshot().screen.name).not.toBe('failed');
    notAltcha.controller.hostGone();
  });

  it('AL-01 recognises an Altcha refusal when no solution was sent', async () => {
    // The session had no challenge; the API asks for one anyway.
    const server = altchaServer(['process-processing-mobile-money-live'], { altcha: false });
    const { controller } = await sheet(server.sessionRead, server.processCall);
    server.turnOn();
    const mtn = operatorChoices(controller.getSnapshot().session!.channels, 'CM', 'en')[0];
    await controller.payMobileMoney({ phone: '677123456', country: 'CM', choice: mtn, pickedByHand: true });
    await settle(30);
    const calls = api.callsTo('POST /pay/process');
    expect(calls).toHaveLength(2);
    expect(calls[0].body.data.altcha).toBeUndefined();
    expect(server.issued.has(calls[1].body.data.altcha.challenge)).toBe(true);
    // A new request after a definitive answer: a key of its own.
    expect(calls[1].headers['Idempotency-Key']).not.toBe(calls[0].headers['Idempotency-Key']);
    expect(controller.getSnapshot().state).toBe('APPROVAL_REQUIRED');
    controller.hostGone();
  });
});
