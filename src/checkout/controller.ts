/**
 * The payment sheet's logic, without its drawing (spec README §4–§16,
 * states.md): it loads the session, takes the payer through a payment
 * attempt, watches the status, and settles `present()` exactly once.
 */
import { AppState } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';

import { openHostedRedirect } from '../adapters/hostedRedirect';
import { monotonicNow } from '../clock';
import { newIdempotencyKey, PayClient } from '../client/payClient';
import { deviceLocales } from '../client/device';
import { langOf } from '../errorCatalogue';
import type { Lang } from '../errorCatalogue';
import { detectOperator } from '../mobileMoney/data';
import { isMobileMoneyChannel, mobileMoneyRequestData, operatorChoices, operatorHint, validateMobileMoney } from '../mobileMoney/form';
import type { OperatorChoice } from '../mobileMoney/form';
import { buildHostedCardRequest } from '../mappers/paymentMapper';
import type {
  AltchaChallenge,
  AltchaSolution,
  CheckoutResult,
  CheckoutState,
  ClientSessionOptions,
  ConfirmStepKind,
  HostedCardField,
  PaymentStatus,
  PaymentSuccess,
  PresentOptions,
  SdkConfig,
  SessionData,
  SessionTransaction,
} from '../types';
import { WajubError } from '../WajubError';
import type { RawProcessBody } from '../wire/parse';
import { solveAltcha } from './altcha';
import { availableMethods, SANDBOX_CARD_FIELDS, shownSlugs } from './methods';
import type { MethodEntry } from './methods';
import { attemptEnded, POLLING, StatusWatcher, SUCCESS_STATUSES } from './watcher';
import type { WatchOutcome } from './watcher';

export const UI_TIMINGS = {
  readyTimeoutMs: 15_000,
  resendAfterMs: 60_000,
  autoCloseSuccessMs: 3_000,
  /** How long sdk-config may lag behind the session: Mobile Money does not wait for it. */
  sdkConfigGraceMs: 3_000,
  /** A payment request with no answer, whose status still reads `pending` this long after its last try, never reached the API. */
  unansweredMs: 60_000,
} as const;

/** A confirmation step on screen. */
export interface StepScreen {
  kind: ConfirmStepKind;
  /** The step's id (`otp_id`, …): a processing id. */
  id: string;
  /** `otp_masked_contact` or the step's instruction (English). */
  hint: string | null;
  /** The last refusal, in the sheet's language. */
  error: string | null;
  /** Epoch ms from which "Resend" is offered. */
  resendAt: number;
}

export interface ThreeDsScreen {
  id: string;
  maskedEmail: string | null;
  /** Epoch ms when the code expires, when the API gave a timeout. */
  expiresAt: number | null;
  error: string | null;
  resendAt: number;
  /** The code was accepted: the payment is being confirmed. */
  accepted: boolean;
}

export type Screen =
  | { name: 'loading' }
  | { name: 'load_error'; error: WajubError }
  | { name: 'methods' }
  | { name: 'form'; method: MethodEntry }
  | { name: 'approval'; phone: string | null; instruction: string | null }
  | { name: 'ussd'; instruction: string | null }
  | { name: 'step'; step: StepScreen }
  | { name: 'three_ds'; threeDs: ThreeDsScreen }
  /** `url`: "Continue payment" reopens it. `capped`: watched for 15 minutes without an outcome. */
  | { name: 'pending'; url: string | null; capped: boolean }
  | { name: 'success'; payment: PaymentSuccess }
  | { name: 'failed'; error: WajubError }
  | { name: 'expired'; error: WajubError }
  | { name: 'cancelled'; error: WajubError };

export interface CheckoutSnapshot {
  visible: boolean;
  screen: Screen;
  /** The Wajub.js state reported to `onStateChange`; null before the sheet is ready. */
  state: CheckoutState | null;
  lang: Lang;
  session: SessionData | null;
  methods: MethodEntry[];
  /** A request of the payer's is under way (Pay, Verify, Cancel). */
  busy: boolean;
  /** A refusal not tied to one field, shown above the form. */
  banner: WajubError | null;
  /** Field → message: `phone`, `operator`, `email`, `code`… */
  fieldErrors: Record<string, string>;
  /** "Cancel payment" can be offered: no attempt is in flight. */
  canCancel: boolean;
  /** The payment is being cancelled. */
  cancelling: boolean;
}

export interface MobileMoneySubmission {
  phone: string;
  country: string;
  /** The operator selected; null when none is. */
  choice: OperatorChoice | null;
  /** The payer picked the operator in the list (not a default, not detection). */
  pickedByHand: boolean;
}

interface Attempt {
  /** POST /pay/process, or POST /pay/client-session (a PSP-hosted card). */
  endpoint: 'process' | 'client_session';
  channel: string;
  method: string;
  key: string;
  startedAt: number;
  /** Its first 2xx arrived: onPaymentStarted fired, a dismiss resolves `processing`. */
  started: boolean;
  /** The number the payer is approving on (Mobile Money). */
  phone: string | null;
  /** The attempt's request body (`data`, or the client session's fields), for the Altcha retry. */
  data: Record<string, unknown>;
  /** When its last try was sent. */
  sentAt?: number;
  /** The status's `error_code` known before it was sent (null: none; undefined: not known). */
  baseline?: string | null;
}

const FINAL_SCREENS = ['success', 'failed', 'expired', 'cancelled'];

/** A payment that had ended when the session was read: its load error (README §4.2). */
const TERMINAL_AT_LOAD: Record<string, string> = {
  failed: 'session_terminal_failed',
  cancelled: 'session_terminal_cancelled',
  expired: 'session_terminal_expired',
};

const STEP_STATES: Record<ConfirmStepKind, CheckoutState> = {
  otp: 'OTP_REQUIRED',
  pin: 'PIN_REQUIRED',
  phone: 'PHONE_REQUIRED',
  birthday: 'BIRTHDAY_REQUIRED',
  address: 'ADDRESS_REQUIRED',
};

/** `data` keys that are raw card data: never sent to /pay/process in live. */
const RAW_CARD_KEYS = ['card.number', 'card_number', 'number', 'cvv', 'cvc', 'pin', 'card.cvv', 'card.pin'];

const PAYMENT_METHODS = ['mobile_money', 'card', 'wallet'];

/** A payment still to pay whose only ways are card or wallets: it cannot be offered without sdk-config. */
function needsSdkConfig(session: SessionData): boolean {
  const status = session.transaction.status.toLowerCase();
  const payable = !SUCCESS_STATUSES.includes(status) && !['failed', 'cancelled', 'expired', 'processing', 'partial'].includes(status);
  return payable && !session.channels.some(isMobileMoneyChannel) && session.channels.some((c) => c.type === 'card' || c.type === 'wallet');
}

/** Device options the sheet passes; tests replace them. */
export interface ControllerDeps {
  client?: PayClient;
  /** Opens a URL in the system browser; false when nothing can open it. */
  openUrl?: (url: string) => Promise<boolean>;
  /** `@stripe/stripe-react-native` is installed. */
  stripeInstalled?: boolean;
}

export class CheckoutController {
  readonly options: PresentOptions;
  /** Settles exactly once with the sheet's outcome. */
  readonly result: Promise<CheckoutResult>;

  private readonly client: PayClient;
  private readonly openUrl: (url: string) => Promise<boolean>;
  private readonly stripeInstalled: boolean;
  private resolve!: (result: CheckoutResult) => void;
  private snapshot: CheckoutSnapshot;
  private listeners = new Set<() => void>();

  private transaction: SessionTransaction | null = null;
  private loadGeneration = 0;
  private loadAbort: AbortController | null = null;
  private ready = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private successTimer: ReturnType<typeof setTimeout> | null = null;
  private threeDsTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: StatusWatcher | null = null;
  private appState: NativeEventSubscription | null = null;
  private awayInBrowser = false;
  private attempt: Attempt | null = null;
  /** A payment is in flight: a request sent and not answered, or a restored processing payment. */
  private inFlight = false;
  private clientSessionId: string | null = null;
  private pendingUrl: string | null = null;
  /** Altcha is on for this payment: no request goes without a solution. */
  private altchaOn = false;
  /** The next solution, being fetched or solved; null until one is asked for. */
  private altcha: Promise<AltchaSolution | WajubError | null> | null = null;
  /** `altcha` was started ahead of time, after the last solution went out. */
  private altchaAhead = false;
  /** The solves under way, stopped when the sheet settles. */
  private altchaSolves = new Set<{ aborted: boolean }>();
  private altchaRetried = false;
  /** Pay pressed, its request not sent yet (its Altcha solution on the way). */
  private pressed = false;
  /** The last client session may have died at the PSP: the next one replaces it. */
  private restartClientSession = false;
  /**
   * The payment's status as last known: the session's once it answered, then
   * each status read, and `pending` again after a decline. Only a `pending`
   * payment is ever cancelled.
   */
  private knownStatus: string | null = null;
  /** A 400 whose status re-read said nothing: a later `pending` read decides as the re-read would have. */
  private notProcessable: Attempt | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** A payment request that got no answer: its key, reused by the next Pay if it never reached the API. */
  private unanswered: { key: string; sentAt: number; baseline: string | null | undefined } | null = null;
  /** The last `error_code` the status carried, as far as this sheet saw (undefined: never read). */
  private knownErrorCode: string | null | undefined = undefined;
  /** POST /pay/client-session/complete is running: it, not a poll, decides the outcome. */
  private completing = false;
  private deferredOutcome: WatchOutcome | null = null;
  private reuseKey: string | null = null;
  /** Stripe: Pay pressed, the PaymentMethod being created — the attempt is under way. */
  private stripePressed = false;
  private lastState: CheckoutState | null = null;
  private settled = false;
  private chosen: MethodEntry | null = null;

  constructor(options: PresentOptions, deps: ControllerDeps = {}) {
    this.options = options;
    this.client = (deps.client ?? new PayClient()).with({ errors: 'v2', storage: options.storage });
    this.openUrl = deps.openUrl ?? openHostedRedirect;
    this.stripeInstalled = deps.stripeInstalled ?? true;
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.snapshot = {
      visible: true,
      screen: { name: 'loading' },
      state: null,
      lang: langOf(options.locale ?? deviceLocales()[0]),
      session: null,
      methods: [],
      busy: false,
      banner: null,
      fieldErrors: {},
      canCancel: false,
      cancelling: false,
    };
  }

  // ── store ──────────────────────────────────────────────────────────────────

  getSnapshot = (): CheckoutSnapshot => this.snapshot;

  /** `present()` has settled. */
  get closed(): boolean {
    return this.settled;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<CheckoutSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    // While its cancel runs, the button stays, disabled and spinning.
    next.canCancel = (next.cancelling || !next.busy) && (next.screen.name === 'methods' || next.screen.name === 'form') && this.mayCancel();
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  private get lang(): Lang {
    return this.snapshot.lang;
  }

  private get token(): string {
    return this.options.sessionToken;
  }

  /** Calls a host callback; one that throws is logged and the sheet carries on. */
  private emit<K extends keyof PresentOptions>(name: K, ...args: unknown[]): void {
    const callback = this.options[name];
    if (typeof callback !== 'function') return;
    try {
      (callback as (...a: unknown[]) => void)(...args);
    } catch (e) {
      console.warn(`[wajub] ${String(name)} threw:`, e);
    }
  }

  private methodFamily(): string {
    return this.attempt?.method ?? this.chosen?.kind ?? 'unknown';
  }

  /** Shows a screen and reports its state, never twice in a row. */
  private show(screen: Screen, state: CheckoutState | null, patch: Partial<CheckoutSnapshot> = {}): void {
    this.update({ screen, state: state ?? this.snapshot.state, ...patch });
    if (!state || !this.ready || state === this.lastState) return;
    this.lastState = state;
    this.emit('onStateChange', { state, method: this.methodFamily() });
  }

  // ── loading (README §4) ─────────────────────────────────────────────────────

  /** Loads the payment: session and sdk-config in parallel, with the ready timer. */
  start(): void {
    if (this.settled) return;
    this.loadAbort?.abort();
    const generation = ++this.loadGeneration;
    const abort = new AbortController();
    this.loadAbort = abort;
    this.update({ screen: { name: 'loading' } });
    this.armReadyTimer();
    if (!this.appState) {
      this.appState = AppState.addEventListener('change', (state) => this.onAppState(state));
    }

    const current = () => generation === this.loadGeneration && !this.settled;
    const sessionLoad = this.client.getSession(this.token, { signal: abort.signal });
    const configLoad = this.client.getSdkConfig(this.token, { signal: abort.signal }).catch(() => null);
    sessionLoad.then(
      async (session) => {
        if (!current()) return;
        // Its status decides what closing the sheet means from now on, before sdk-config is in.
        this.knownStatus = session.transaction.status.toLowerCase();
        this.transaction = session.transaction;
        let config: SdkConfig | null | undefined;
        if (needsSdkConfig(session)) {
          // Card or wallets only: they need sdk-config, which gets its own timeouts and retries.
          config = await configLoad;
          if (!current()) return;
          if (!config) return this.failLoad(WajubError.create('load_error', { lang: this.lang }));
        } else {
          // Mobile Money does not wait for sdk-config past a short grace: card and wallets join when it lands.
          const grace = new Promise<undefined>((resolve) => {
            this.graceTimer = setTimeout(() => resolve(undefined), UI_TIMINGS.sdkConfigGraceMs);
          });
          config = await Promise.race([configLoad, grace]);
          if (this.graceTimer) clearTimeout(this.graceTimer);
          this.graceTimer = null;
          if (!current()) return;
        }
        this.applySession(session, config ?? null);
        if (config === undefined) {
          void configLoad.then((late) => {
            if (current() && late) this.applyLateConfig(session, late);
          });
        }
      },
      (error: unknown) => {
        if (current()) this.loadFailed(error);
      },
    );
  }

  /** "Retry" on the load error view: what is still running is dropped and the load starts over. */
  retryLoad(): void {
    if (this.ready || this.settled) return;
    this.start();
  }

  private armReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const ms = this.options.readyTimeout ?? UI_TIMINGS.readyTimeoutMs;
    if (ms <= 0) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.ready || this.settled) return;
      // The load goes on: if it lands while this shows, the sheet becomes ready.
      const error = WajubError.create('ready_timeout', { lang: this.lang, apiMessage: `Payment sheet not ready after ${ms} ms` });
      this.update({ screen: { name: 'load_error', error } });
      this.emit('onLoadError', error);
    }, ms);
  }

  private loadFailed(error: unknown): void {
    const status = error instanceof WajubError ? error.http_status : null;
    const code =
      status === 401 || status === 403 || status === 404
        ? 'session_not_found'
        : status === 410
          ? 'session_terminal_expired'
          : 'load_error';
    this.failLoad(WajubError.create(code, { lang: this.lang, httpStatus: status, apiMessage: error instanceof WajubError ? error.api_message : null }));
  }

  private failLoad(error: WajubError): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.update({ screen: { name: 'load_error', error } });
    this.emit('onLoadError', error);
  }

  private applySession(session: SessionData, config: SdkConfig | null): void {
    const lang = langOf(this.options.locale ?? session.locale ?? deviceLocales()[0]);
    const methods = availableMethods(session, config, lang, this.stripeInstalled);
    this.transaction = session.transaction;
    this.update({ session, lang, methods });

    const status = session.transaction.status.toLowerCase();
    const ended: Record<string, [string, 'failed' | 'cancelled' | 'expired', CheckoutState]> = {
      failed: ['session_terminal_failed', 'failed', 'FAILED'],
      cancelled: ['session_terminal_cancelled', 'cancelled', 'CANCELLED'],
      expired: ['session_terminal_expired', 'expired', 'EXPIRED'],
    };

    if (SUCCESS_STATUSES.includes(status)) {
      this.markReady([]);
      this.succeed(session.transaction, 'unknown');
      return;
    }
    if (ended[status]) {
      const [code, name, state] = ended[status];
      const error = WajubError.create(code, { lang });
      this.markReady([]);
      this.show({ name, error }, state);
      this.emit('onLoadError', error);
      return;
    }

    this.startAltcha(session);
    if (status === 'processing' || status === 'partial') {
      this.markReady(shownSlugs(methods));
      this.restore(session);
      return;
    }
    if (methods.length === 0) {
      this.failLoad(WajubError.create('no_payment_method', { lang }));
      return;
    }
    this.markReady(shownSlugs(methods));
    // One method, within its limits: its form. Out of its limits, it shows disabled in the list.
    if (methods.length === 1 && !methods[0].limit) this.choose(methods[0]);
    else this.show({ name: 'methods' }, 'INITIATED');
  }

  /** The first real screen is up: onReady, then the first state. */
  private markReady(methods: string[]): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.ready) return;
    this.ready = true;
    const t = this.transaction!;
    this.emit('onReady', {
      sessionId: t.id,
      environment: t.sandbox ? 'sandbox' : 'live',
      amount: t.amount_total ?? t.amount,
      currency: t.currency,
      methods,
    });
  }

  /** sdk-config arrived after the sheet showed: card and wallets join the methods. */
  private applyLateConfig(session: SessionData, config: SdkConfig): void {
    // A load error shown while it was missing (no method, or the ready timer): the sheet starts over with it.
    if (!this.ready && this.snapshot.screen.name === 'load_error') return this.applySession(session, config);
    if (this.snapshot.screen.name !== 'methods' && this.snapshot.screen.name !== 'form') return;
    const methods = availableMethods(session, config, this.lang, this.stripeInstalled);
    if (methods.length <= this.snapshot.methods.length) return;
    this.chosen = methods.find((m) => m.id === this.chosen?.id) ?? this.chosen;
    const screen = this.snapshot.screen.name === 'form' && this.chosen ? { name: 'form' as const, method: this.chosen } : this.snapshot.screen;
    this.update({ methods, screen });
  }

  /**
   * README §14: `/pay/cancel` goes only for a loaded session whose last known
   * status is `pending`, with no attempt undecided — sent (or Stripe's Pay
   * pressed) and no definitive answer yet. The API cancels a `processing`
   * payment too, one the payer may still approve. After a definitive refusal
   * (a decline, a `pending` with a new error_code, a failed step) the payment
   * is `pending` again, and may be cancelled.
   */
  private mayCancel(): boolean {
    return this.knownStatus === 'pending' && !this.inFlight && !this.stripePressed && !this.pressed;
  }

  /** The payer left (closed, cancelling) while the SDK was waiting: nothing more is sent. */
  private abandoned(): boolean {
    return this.settled || this.snapshot.cancelling || !this.snapshot.visible;
  }

  /** A final screen is up: a later answer or status changes nothing. */
  private finished(): boolean {
    return FINAL_SCREENS.includes(this.snapshot.screen.name);
  }

  /** A payment found `processing` at load: its screen back, and the watch (README §4.2). */
  private restore(session: SessionData): void {
    const t = session.transaction;
    const ctx = t.processing_context ?? {};
    this.inFlight = true;
    this.attempt = {
      endpoint: 'process',
      channel: ctx.channel_slug ?? '',
      method: ctx.is_mobile_money ? 'mobile_money' : ctx.channel_slug === 'card' ? 'card' : 'unknown',
      key: newIdempotencyKey(),
      startedAt: monotonicNow(),
      started: true,
      phone: null,
      data: {},
    };
    if (ctx.is_ussd) {
      this.show({ name: 'ussd', instruction: ctx.payer_instruction ?? null }, 'USSD_REQUIRED');
    } else if (ctx.is_mobile_money) {
      this.show({ name: 'approval', phone: null, instruction: ctx.payer_instruction ?? null }, 'APPROVAL_REQUIRED');
    } else if (ctx.three_ds_id) {
      this.showThreeDs(ctx.three_ds_id, ctx.masked_email ?? null, ctx.three_ds_timeout ?? null);
    } else {
      this.pendingUrl = ctx.action_url ?? null;
      this.show({ name: 'pending', url: this.pendingUrl, capped: false }, 'PENDING');
    }
    this.watch(true);
  }

  /** The session's challenge, solved in the background as soon as it loads. */
  private startAltcha(session: SessionData): void {
    if (!session.altcha || this.altcha) return;
    this.altchaOn = true;
    this.altchaAhead = false;
    this.altcha = this.solve(session.altcha);
  }

  private solve(challenge: AltchaChallenge): Promise<AltchaSolution | WajubError> {
    const signal = { aborted: this.settled };
    this.altchaSolves.add(signal);
    return solveAltcha(challenge, signal).then((solution) => {
      this.altchaSolves.delete(signal);
      return solution ?? WajubError.create('security_check_failed', { lang: this.lang });
    });
  }

  /** A new challenge from GET /pay/session (with its retries), solved; null when Altcha was turned off. */
  private fetchAltcha(): Promise<AltchaSolution | WajubError | null> {
    return this.client.getSession(this.token).then(
      (session) => {
        if (this.settled) return null;
        if (!session.altcha) {
          this.altchaOn = false;
          return null;
        }
        return this.solve(session.altcha);
      },
      (error: unknown) => (error instanceof WajubError ? error.localized(this.lang) : WajubError.create('network_error', { lang: this.lang })),
    );
  }

  /**
   * The solution for the next request (null when Altcha is off). A challenge
   * fetched ahead of time that failed is asked for again now; one that cannot
   * be had is an error the payer can retry — nothing is sent without it.
   */
  private async nextAltcha(): Promise<AltchaSolution | WajubError | null> {
    if (!this.altchaOn) return null;
    if (!this.altcha) {
      this.altcha = this.fetchAltcha();
      this.altchaAhead = false;
    }
    let result = await this.altcha;
    if (result instanceof WajubError && this.altchaAhead) {
      this.altcha = this.fetchAltcha();
      this.altchaAhead = false;
      result = await this.altcha;
    }
    // Used or failed: the next request asks for another.
    if (!result || result instanceof WajubError) this.altcha = null;
    return result;
  }

  /**
   * The solution for the request a Pay press is about to send: from the press
   * on, the attempt is undecided (README §14) — nothing is cancelled meanwhile.
   */
  private async solutionForPay(): Promise<AltchaSolution | WajubError | null> {
    this.pressed = true;
    try {
      return await this.nextAltcha();
    } finally {
      this.pressed = false;
    }
  }

  /** A solution goes with one request only: the next one is fetched and solved ahead. */
  private useAltcha(data: Record<string, unknown>, solution: AltchaSolution): void {
    data.altcha = solution;
    this.altcha = this.fetchAltcha();
    this.altchaAhead = true;
  }

  // ── choosing a method ───────────────────────────────────────────────────────

  /** Opens a method's form (COLLECTING_DETAILS). */
  chooseMethod(id: string): void {
    const method = this.snapshot.methods.find((m) => m.id === id);
    if (!method || method.limit || this.inFlight || this.abandoned()) return;
    this.choose(method);
  }

  private choose(method: MethodEntry): void {
    this.chosen = method;
    this.show({ name: 'form', method }, 'COLLECTING_DETAILS', { banner: null, fieldErrors: {} });
  }

  /** "Change": back to the method list. */
  backToMethods(): void {
    if (this.inFlight || this.snapshot.methods.length < 2 || this.abandoned()) return;
    this.chosen = null;
    this.show({ name: 'methods' }, 'INITIATED', { banner: null, fieldErrors: {} });
  }

  // ── paying (README §6–§9) ───────────────────────────────────────────────────

  /** Mobile Money: checked as the web does, then sent in E.164 with the operator hint. */
  async payMobileMoney(input: MobileMoneySubmission): Promise<void> {
    const method = this.snapshot.methods.find((m) => m.kind === 'mobile_money');
    // Nothing is taken while the payment is being cancelled, or once the sheet closed.
    if (!method || method.kind !== 'mobile_money' || this.abandoned()) return;
    const problem = validateMobileMoney(input.phone, input.country, this.choicesFor(input.country, method), input.choice?.id ?? null);
    // Sandbox test numbers do not follow real numbering plans: a mismatch never blocks there.
    const blocking = problem && !(problem.code === 'operator_mismatch' && this.transaction?.sandbox);
    if (problem && blocking) {
      const message =
        problem.code === 'operator_mismatch'
          ? WajubError.create('operator_mismatch', { lang: this.lang, vars: { detected: problem.detectedLabel, selected: problem.selectedLabel } }).message
          : WajubError.create(problem.code, { lang: this.lang }).message;
      this.update({ fieldErrors: { [problem.code === 'operator_required' ? 'operator' : 'phone']: message } });
      return;
    }
    const choice = input.choice;
    if (!choice) return;
    const detected = detectOperator(input.phone, input.country);
    const data = mobileMoneyRequestData(input.phone, input.country, operatorHint(choice, input.pickedByHand, detected));
    await this.runAttempt(choice.channel, 'mobile_money', data, data.phone);
  }

  private choicesFor(country: string, method: Extract<MethodEntry, { kind: 'mobile_money' }>): OperatorChoice[] {
    return operatorChoices(method.channels, country, this.lang);
  }

  /** Card through a hosted page, the sandbox test form, or a client session — by the method's flavour. */
  async payCard(fields: Record<string, string>): Promise<void> {
    const method = this.chosenCard();
    if (!method || this.abandoned()) return;
    const missing = this.checkFields(method.flavor === 'sandbox_form' ? [...SANDBOX_CARD_FIELDS] : method.fields, fields);
    if (missing) return;
    if (method.flavor === 'client_session') {
      await this.startClientSession(method.slug, fields);
      return;
    }
    if (method.flavor === 'sandbox_form') {
      const data: Record<string, string> = {};
      for (const key of SANDBOX_CARD_FIELDS) {
        const value = (fields[key] ?? '').trim();
        data[key] = key === 'card.number' ? value.replace(/\s/g, '') : value;
      }
      await this.runAttempt(method.slug, 'card', data);
      return;
    }
    await this.runAttempt(method.slug, 'card', buildHostedCardRequest(fields as Partial<Record<HostedCardField, string>>));
  }

  /** Stripe: Pay pressed. From now on the attempt is under way, while Stripe creates the PaymentMethod. */
  beginCardPayment(): void {
    if (this.inFlight || this.abandoned() || this.snapshot.busy) return;
    this.stripePressed = true;
    this.show(this.snapshot.screen, 'PROCESSING', { busy: true, banner: null, fieldErrors: {} });
  }

  /** Stripe could not create the PaymentMethod (it says why on the form): nothing was sent. */
  cardPaymentFailed(): void {
    if (!this.stripePressed || this.settled) return;
    this.stripePressed = false;
    this.show(this.snapshot.screen, 'COLLECTING_DETAILS', { busy: false });
  }

  /** Stripe's `pm_…` from `@stripe/stripe-react-native`. */
  async payStripe(paymentMethodId: string, cardholderName?: string | null): Promise<void> {
    const method = this.chosenCard();
    // Closed while Stripe was working: nothing is charged after the sheet closed.
    if (!method || this.abandoned()) return;
    const data: Record<string, string> = { payment_method_id: paymentMethodId };
    if (cardholderName?.trim()) data.card_holder = cardholderName.trim();
    await this.runAttempt(method.slug, 'card', data);
  }

  /** A one-tap wallet (Djamo): nothing to collect, the answer is its page. */
  async payWallet(slug: string): Promise<void> {
    await this.runAttempt(slug, 'wallet', {});
  }

  private chosenCard(): Extract<MethodEntry, { kind: 'card' }> | null {
    const method = this.snapshot.methods.find((m) => m.kind === 'card');
    return method && method.kind === 'card' ? method : null;
  }

  /** Required fields, and the email's shape. Errors go on the fields; true when one is missing. */
  private checkFields(required: readonly string[], values: Record<string, string>): boolean {
    const errors: Record<string, string> = {};
    for (const field of required) {
      const value = (values[field] ?? '').trim();
      if (!value) errors[field] = WajubError.create('field_required', { lang: this.lang }).message;
      else if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors[field] = WajubError.create('invalid_email', { lang: this.lang }).message;
      } else if (field === 'country' && !/^[A-Za-z]{2}$/.test(value)) {
        errors[field] = WajubError.create('validation_error', { lang: this.lang }).message;
      }
    }
    this.update({ fieldErrors: errors });
    return Object.keys(errors).length > 0;
  }

  /** One payment attempt: a new Idempotency-Key, POST /pay/process, its answer (README §9). */
  private async runAttempt(channel: string, method: string, data: Record<string, unknown>, phone: string | null = null): Promise<void> {
    if (this.inFlight || this.abandoned() || (this.snapshot.busy && !this.stripePressed)) return;
    this.altchaRetried = false;
    const payload: Record<string, unknown> = { ...data };
    if (this.options.returnUrl) payload.return_url = this.options.returnUrl;
    // The API refuses raw card data in live; the SDK never sends it there.
    if (!this.transaction?.sandbox && RAW_CARD_KEYS.some((k) => k in payload)) {
      this.update({ banner: WajubError.create('raw_card_data_not_accepted', { lang: this.lang }) });
      return;
    }
    this.show(this.snapshot.screen, 'PROCESSING', { busy: true, banner: null, fieldErrors: {} });
    // Solved in the background since the session loaded; usually ready by now.
    const altcha = await this.solutionForPay();
    if (this.abandoned()) return;
    this.stripePressed = false;
    if (altcha instanceof WajubError) return this.notSent(altcha);
    if (altcha) this.useAltcha(payload, altcha);
    // A request that never reached the API is sent again under its own key: if it did arrive after all, the API replays its answer.
    const key = this.reuseKey ?? newIdempotencyKey();
    this.reuseKey = null;
    this.attempt = { endpoint: 'process', channel, method, key, startedAt: monotonicNow(), started: false, phone, data: payload, baseline: this.knownErrorCode };
    this.inFlight = true;
    await this.send(this.attempt);
  }

  private async send(attempt: Attempt): Promise<void> {
    if (attempt.endpoint === 'client_session') return this.sendClientSession(attempt);
    try {
      const body = await this.client.process(this.token, attempt.channel, attempt.data, {
        idempotencyKey: attempt.key,
        onSend: (at) => {
          attempt.sentAt = at;
        },
      });
      if (this.settled || attempt !== this.attempt) return;
      this.handleAnswer(body);
    } catch (e) {
      if (this.settled || attempt !== this.attempt) return;
      await this.handleProcessError(e instanceof WajubError ? e : WajubError.create('network_error'), attempt);
    }
  }

  /** The first 2xx of an attempt: from now on a dismiss resolves `processing`. */
  private markStarted(): void {
    const attempt = this.attempt;
    if (!attempt || attempt.started) return;
    attempt.started = true;
    this.emit('onPaymentStarted', { method: attempt.method, channel: attempt.channel });
  }

  /** A 2xx: HTTP status, `action` and `transaction.status` decide — never `message`. */
  private handleAnswer(body: RawProcessBody): void {
    this.markStarted();
    if (!body.transaction) {
      // Accepted, but without the payment: an unknown outcome — watched, never a failure.
      this.update({ busy: false });
      this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
      this.watch(false);
      return;
    }
    if (body.transaction) this.transaction = { ...this.transaction, ...body.transaction };
    const status = body.transaction?.status ?? '';
    if (status) this.knownStatus = status.toLowerCase();
    const ctx = body.transaction?.processing_context ?? {};
    this.update({ busy: false });

    const action = body.action ?? null;
    switch (action) {
      case null:
        if (SUCCESS_STATUSES.includes(status)) {
          this.succeed(this.transaction!, this.attempt?.method ?? 'unknown');
        } else if (ctx.is_ussd) {
          this.show({ name: 'ussd', instruction: ctx.payer_instruction ?? null }, 'USSD_REQUIRED');
          this.watch(true);
        } else if (this.attempt?.method === 'mobile_money' || ctx.is_mobile_money) {
          // A push went to the phone: Pay is not offered again while it is processing.
          this.show({ name: 'approval', phone: this.attempt?.phone ?? null, instruction: ctx.payer_instruction ?? null }, 'APPROVAL_REQUIRED');
          this.watch(true);
        } else {
          this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
          this.watch(true);
        }
        return;
      case 'redirect':
      case 'confirm':
        if (body.confirm_url) return void this.redirect(body.confirm_url, 'PENDING');
        break;
      case 'confirm_3ds':
        if (body.confirm_url) return void this.redirect(body.confirm_url, '3DS_REQUIRED');
        if (body.three_ds_id) {
          this.showThreeDs(body.three_ds_id, body.masked_email ?? null, body.three_ds_timeout ?? null);
          this.watch(true);
          return;
        }
        break;
      case 'confirm_otp':
      case 'confirm_pin':
      case 'confirm_phone':
      case 'confirm_birthday':
      case 'confirm_address': {
        const kind = action.slice('confirm_'.length) as ConfirmStepKind;
        const [id, hint] = {
          otp: [body.otp_id, body.otp_masked_contact],
          pin: [body.pin_id, body.pin_instruction],
          phone: [body.phone_id, body.phone_instruction],
          birthday: [body.birthday_id, body.birthday_instruction],
          address: [body.address_id, body.address_instruction],
        }[kind];
        if (id) {
          this.showStep({ kind, id, hint: hint ?? null, error: null, resendAt: Date.now() + UI_TIMINGS.resendAfterMs });
          this.watch(true);
          return;
        }
        break;
      }
    }
    // An action the SDK cannot perform, or one without what it needs. The
    // payment may still be processing: the failure is final for the sheet.
    this.fail(WajubError.create('unsupported_action', { lang: this.lang, apiMessage: body.action ?? null }));
  }

  private async handleProcessError(error: WajubError, attempt: Attempt): Promise<void> {
    const status = error.http_status;
    if (status === 400) {
      // Pay stays disabled while the status says whether the payment ended, or is under way.
      await this.settleFromStatus(attempt);
      return;
    }
    this.update({ busy: false });

    if (status === null || status >= 500) {
      // No answer after the retries: the outcome is unknown, never shown as a
      // failure. A charge may be running — watch it.
      this.unanswered = { key: attempt.key, sentAt: attempt.sentAt ?? monotonicNow(), baseline: attempt.baseline };
      this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
      this.watch(false);
      return;
    }
    this.inFlight = false;
    if (status === 409 && error.code === 'payment_in_progress') {
      this.inFlight = true;
      this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
      this.watch(true);
      return;
    }
    if (status === 410) {
      this.end('expired', error.localized(this.lang));
      return;
    }
    if (status === 422) {
      await this.handleValidation(error);
      return;
    }
    if (status === 401 || status === 404) {
      this.fail(WajubError.create('session_not_found', { lang: this.lang, httpStatus: status }));
      return;
    }
    // A decline puts the payment back to pending with this code: what the status carries from now on.
    if (status === 402) {
      this.knownErrorCode = error.decline_code;
      this.knownStatus = 'pending';
    }
    this.fail(error.localized(this.lang));
  }

  /** 422: the form again, with its errors (README §9.1), or the Altcha retry (§15). */
  private async handleValidation(error: WajubError): Promise<void> {
    // The API refuses a solution (or its absence) without an error_code: a malformed one under
    // `data.altcha` (or `altcha`), a wrong or missing one only by its message — matched as a last resort.
    const altchaField = Object.keys(error.details ?? {}).some((k) => k === 'altcha' || k === 'data.altcha');
    if (altchaField || /security challenge/i.test(error.api_message ?? '')) {
      if (this.altchaRetried) {
        this.fail(WajubError.create('security_check_failed', { lang: this.lang }));
        return;
      }
      this.altchaRetried = true;
      await this.retryWithNewChallenge();
      return;
    }
    const fieldErrors: Record<string, string> = {};
    let banner: WajubError | null = null;
    for (const [key, message] of Object.entries(error.details ?? {})) {
      const field = key.replace(/^data\./, '');
      if (field === 'phone' || field === 'account_number') {
        fieldErrors.phone = /belongs to/i.test(message)
          ? this.mismatchFromApi(message)
          : WajubError.create('invalid_phone', { lang: this.lang }).message;
      } else if (key === 'request' || key === 'channel' || key === 'idempotency_key' || key === 'card') {
        banner = error.localized(this.lang);
      } else {
        fieldErrors[field] = this.lang === 'en' ? message : WajubError.create(/required/i.test(message) ? 'field_required' : 'validation_error', { lang: 'fr' }).message;
      }
    }
    if (Object.keys(error.details ?? {}).length === 0 || (error.code !== 'validation_error' && !banner)) {
      banner = error.localized(this.lang);
    }
    const screen = this.chosen ? ({ name: 'form', method: this.chosen } as Screen) : this.snapshot.screen;
    this.show(screen, 'COLLECTING_DETAILS', { banner, fieldErrors });
    if (banner && banner.code !== 'validation_error') this.emit('onError', banner);
  }

  /**
   * The API refused the number as another operator's ("This phone number
   * belongs to ORANGE (cm.orange) but the requested channel is cm.mtn"): the
   * SDK's own words, with the operators as the list names them.
   */
  private mismatchFromApi(apiMessage: string): string {
    const attempt = this.attempt;
    const country = typeof attempt?.data.country === 'string' ? attempt.data.country : '';
    const method = this.snapshot.methods.find((m) => m.kind === 'mobile_money');
    if (method?.kind === 'mobile_money' && country) {
      const choices = this.choicesFor(country, method);
      const named = /belongs to \w+ \(\w+\.(\w+)\)/i.exec(apiMessage)?.[1]?.toLowerCase();
      // The API's carrier lookup first; the prefix rules when its message names none.
      const detectedId = named || (attempt?.phone ? detectOperator(attempt.phone, country) : null);
      const detected = choices.find((c) => c.id === detectedId);
      const selected = choices.find((c) => c.channel === attempt?.channel && (!c.viaAggregate || c.id === attempt?.data.operator));
      if (detected && selected) {
        return WajubError.create('operator_mismatch', { lang: this.lang, vars: { detected: detected.label, selected: selected.label } }).message;
      }
    }
    return WajubError.create('invalid_phone', { lang: this.lang }).message;
  }

  private async retryWithNewChallenge(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt) return;
    this.update({ busy: true });
    // A fresh challenge, whatever was fetched ahead: the API refused the last one (or its absence).
    this.altchaOn = true;
    this.altcha = this.fetchAltcha();
    this.altchaAhead = false;
    const solution = await this.solutionForPay();
    if (this.abandoned()) return;
    if (!solution || solution instanceof WajubError) {
      this.update({ busy: false });
      return this.fail(solution instanceof WajubError && solution.code !== 'security_check_failed' ? solution : WajubError.create('security_check_failed', { lang: this.lang }));
    }
    // A new request after a definitive answer: a new key.
    const data = { ...attempt.data };
    this.useAltcha(data, solution);
    this.attempt = { ...attempt, key: newIdempotencyKey(), data };
    this.inFlight = true;
    await this.send(this.attempt);
  }

  /**
   * A 400 on /pay/process: the status says whether the payment ended
   * (that outcome), is under way (PENDING, watched: money may move), or
   * neither (not_processable).
   */
  private async settleFromStatus(attempt: Attempt): Promise<void> {
    let s = '';
    try {
      s = (await this.client.getStatus(this.token)).status;
    } catch {
      s = '';
    }
    if (this.settled || attempt !== this.attempt) return;
    if (s) this.knownStatus = s;
    this.update({ busy: false });
    if (SUCCESS_STATUSES.includes(s)) return this.succeed({ ...this.transaction!, status: s }, attempt.method);
    // Under way (an attempt is running, money may move), or unreadable: PENDING, watched.
    if (s === 'processing' || s === 'partial' || !s) {
      if (!s) this.notProcessable = attempt;
      this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
      return this.watch(Boolean(s));
    }
    this.inFlight = false;
    if (s === 'failed') return this.fail(WajubError.create('payment_failed', { lang: this.lang }));
    if (s === 'cancelled') return this.end('cancelled', WajubError.create('payment_cancelled', { lang: this.lang }));
    if (s === 'expired') return this.end('expired', WajubError.create('session_expired', { lang: this.lang }));
    this.fail(WajubError.create('not_processable', { lang: this.lang, httpStatus: 400 }));
  }

  // ── redirects and client sessions (README §11, §12) ────────────────────────

  /** onRedirect, then the system browser — never a WebView. */
  private async redirect(url: string, state: 'PENDING' | '3DS_REQUIRED'): Promise<void> {
    const attempt = this.attempt;
    this.pendingUrl = url;
    this.emit('onRedirect', { url, method: 'GET' });
    this.show({ name: 'pending', url, capped: false }, state);
    this.watch(true);
    this.awayInBrowser = true;
    const opened = await this.openUrl(url);
    if (this.settled || attempt !== this.attempt) return;
    if (!opened) {
      this.awayInBrowser = false;
      this.stopWatching();
      this.inFlight = false;
      this.fail(WajubError.create('redirect_unavailable', { lang: this.lang }));
    }
  }

  /** "Continue payment": the provider's page again. */
  async continuePayment(): Promise<void> {
    const url = this.pendingUrl;
    if (!url || this.settled) return;
    this.emit('onRedirect', { url, method: 'GET' });
    this.awayInBrowser = true;
    await this.openUrl(url);
  }

  private async startClientSession(channel: string, fields: Record<string, string>): Promise<void> {
    if (this.inFlight || this.abandoned() || this.snapshot.busy) return;
    this.altchaRetried = false;
    this.show(this.snapshot.screen, 'PROCESSING', { busy: true, banner: null, fieldErrors: {} });
    const altcha = await this.solutionForPay();
    if (this.abandoned()) return;
    if (altcha instanceof WajubError) return this.notSent(altcha);
    const data: Record<string, unknown> = {
      ...buildHostedCardRequest(fields as Partial<Record<HostedCardField, string>>),
      name: this.transaction?.customer?.name ?? null,
      return_url: this.options.returnUrl ?? null,
    };
    if (this.restartClientSession) data.restart = true;
    if (altcha) this.useAltcha(data, altcha);
    this.attempt = { endpoint: 'client_session', channel, method: 'card', key: newIdempotencyKey(), startedAt: monotonicNow(), started: false, phone: null, data };
    this.inFlight = true;
    await this.send(this.attempt);
  }

  private async sendClientSession(attempt: Attempt): Promise<void> {
    try {
      const body = await this.client.startClientSession(this.token, attempt.channel, attempt.data as ClientSessionOptions);
      if (this.settled || attempt !== this.attempt) return;
      this.restartClientSession = false;
      const session = body.client_session;
      if (body.action !== 'client_session' || !session?.hosted_url) {
        this.markStarted();
        this.update({ busy: false });
        this.fail(WajubError.create('unsupported_action', { lang: this.lang, apiMessage: body.action ?? null }));
        return;
      }
      if (body.transaction) this.transaction = { ...this.transaction, ...body.transaction };
      this.markStarted();
      this.clientSessionId = session.id;
      this.update({ busy: false });
      await this.redirect(session.hosted_url, 'PENDING');
    } catch (e) {
      if (this.settled || attempt !== this.attempt) return;
      const error = e instanceof WajubError ? e : WajubError.create('network_error');
      this.inFlight = false;
      this.update({ busy: false });
      const status = error.http_status;
      if (status === 410) return this.end('expired', error.localized(this.lang));
      if (status === 401 || status === 403 || status === 404 || status === 429) return this.fail(error.localized(this.lang));
      if (status === 422 && error.code === 'validation_error' && error.details) return this.handleValidation(error);
      // Nothing was charged: say why on the form, the payer can pick another way.
      const banner = error.localized(this.lang);
      this.show(this.chosen ? { name: 'form', method: this.chosen } : this.snapshot.screen, 'COLLECTING_DETAILS', { banner });
      this.emit('onError', banner);
    }
  }

  /** The payer is back from the PSP's page: ask Wajub to check with the PSP. */
  private async completeClientSession(): Promise<void> {
    const id = this.clientSessionId;
    const attempt = this.attempt;
    if (!id || this.settled || this.completing) return;
    this.completing = true;
    try {
      const body = await this.client.completeClientSession(this.token, id);
      if (this.settled || attempt !== this.attempt) return;
      if (body.transaction) this.transaction = { ...this.transaction, ...body.transaction };
      if (SUCCESS_STATUSES.includes(body.transaction?.status ?? '')) return this.succeed(this.transaction!, 'card');
      // 202: not paid yet — the PSP's webhook settles it; the watch goes on. A refusal a poll
      // read meanwhile (`pending`, perhaps an earlier try's error_code) is not this answer's.
      if (this.deferredOutcome?.kind === 'failed') {
        this.deferredOutcome = null;
        this.watch(true);
      }
    } catch (e) {
      if (this.settled || attempt !== this.attempt || !(e instanceof WajubError)) return;
      if (e.http_status === 402 || (e.http_status === 422 && e.code === 'client_session_expired')) {
        this.deferredOutcome = null;
        this.stopWatching();
        this.inFlight = false;
        this.clientSessionId = null;
        return this.fail(e.localized(this.lang));
      }
    } finally {
      this.completing = false;
      const deferred = this.deferredOutcome;
      this.deferredOutcome = null;
      // Not settled by the PSP's answer: what the watch saw stands.
      if (deferred && !this.settled && attempt === this.attempt && !this.finished()) this.onWatchOutcome(deferred);
    }
  }

  private onAppState(state: AppStateStatus): void {
    if (state === 'background') return;
    if (state !== 'active' || !this.awayInBrowser) return;
    // Back from the browser: the watcher reads the status at once (it polls on foreground).
    this.awayInBrowser = false;
    if (this.snapshot.state === '3DS_REQUIRED' && this.snapshot.screen.name === 'pending') {
      this.show(this.snapshot.screen, 'PENDING');
    }
    if (this.clientSessionId) void this.completeClientSession();
  }

  // ── confirmation steps (README §10) ────────────────────────────────────────

  private showStep(step: StepScreen): void {
    this.show({ name: 'step', step }, STEP_STATES[step.kind], { busy: false, fieldErrors: {}, banner: null });
  }

  private showThreeDs(id: string, maskedEmail: string | null, timeoutSeconds: number | null): void {
    const expiresAt = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : null;
    if (this.threeDsTimer) clearTimeout(this.threeDsTimer);
    if (expiresAt) {
      this.threeDsTimer = setTimeout(() => {
        this.threeDsTimer = null;
        if (!this.onStep(id) || (this.snapshot.screen.name === 'three_ds' && this.snapshot.screen.threeDs.accepted)) return;
        this.stopWatching();
        this.inFlight = false;
        this.fail(WajubError.create('3ds_timeout', { lang: this.lang }));
      }, timeoutSeconds! * 1000);
    }
    this.show(
      { name: 'three_ds', threeDs: { id, maskedEmail, expiresAt, error: null, resendAt: Date.now() + UI_TIMINGS.resendAfterMs, accepted: false } },
      '3DS_REQUIRED',
      { busy: false },
    );
  }

  /** The step's body: its id under `{kind}_id`, then its fields. */
  private stepBody(step: StepScreen, values: Record<string, string>): Record<string, string> | null {
    const v = (k: string) => (values[k] ?? '').trim();
    const errors: Record<string, string> = {};
    const required = WajubError.create('field_required', { lang: this.lang }).message;
    const body: Record<string, string> = { [`${step.kind}_id`]: step.id };
    if (step.kind === 'otp') {
      if (!/^\d{4,10}$/.test(v('code'))) errors.code = v('code') ? WajubError.create('validation_error', { lang: this.lang }).message : required;
      body.code = v('code');
    } else if (step.kind === 'pin') {
      if (!/^\d{4,6}$/.test(v('pin'))) errors.pin = v('pin') ? WajubError.create('validation_error', { lang: this.lang }).message : required;
      body.pin = v('pin');
    } else if (step.kind === 'phone') {
      if (!v('phone')) errors.phone = required;
      body.phone = v('phone').slice(0, 32);
    } else if (step.kind === 'birthday') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v('birthday')) || Number.isNaN(Date.parse(v('birthday')))) {
        errors.birthday = v('birthday') ? WajubError.create('validation_error', { lang: this.lang }).message : required;
      }
      body.birthday = v('birthday');
    } else {
      for (const field of ['address', 'city', 'state', 'zip_code']) {
        if (!v(field)) errors[field] = required;
        body[field] = v(field);
      }
    }
    if (Object.keys(errors).length > 0) {
      this.update({ fieldErrors: errors });
      return null;
    }
    return body;
  }

  /** The step (or 3-D Secure code) `id` is still on screen: its answer still applies. */
  private onStep(id: string): boolean {
    const screen = this.snapshot.screen;
    return !this.settled && ((screen.name === 'step' && screen.step.id === id) || (screen.name === 'three_ds' && screen.threeDs.id === id));
  }

  /** The step on screen now (Resend may have restarted its countdown). */
  private currentStep(step: StepScreen): StepScreen {
    const screen = this.snapshot.screen;
    return screen.name === 'step' && screen.step.id === step.id ? screen.step : step;
  }

  /** Posts the step to its own endpoint (VERIFYING); never retried. */
  async submitStep(values: Record<string, string>): Promise<void> {
    const screen = this.snapshot.screen;
    if (screen.name !== 'step' || this.snapshot.busy || this.abandoned()) return;
    const step = screen.step;
    const body = this.stepBody(step, values);
    if (!body) return;
    this.show(screen, 'VERIFYING', { busy: true, fieldErrors: {}, banner: null });
    try {
      const answer = await this.client.verifyStep(this.token, step.kind, body);
      if (!this.onStep(step.id)) return;
      if (answer.status === 'success') {
        if (answer.transaction) this.transaction = { ...this.transaction, ...answer.transaction };
        const s = answer.transaction?.status ?? '';
        if (SUCCESS_STATUSES.includes(s)) return this.succeed(this.transaction!, this.attempt?.method ?? 'card');
        if (s === 'failed') return this.fail(WajubError.create('payment_failed', { lang: this.lang }));
        // Still processing (a provider may chain steps the API cannot show yet): keep watching.
        this.show({ name: 'pending', url: null, capped: false }, 'PENDING', { busy: false });
        return;
      }
      const refusal = WajubError.fromStepFailure(answer, this.lang);
      const stays = refusal.code.startsWith('invalid_') && (answer.attempts_remaining ?? 0) > 0;
      if (stays) {
        this.show({ name: 'step', step: { ...this.currentStep(step), error: refusal.message } }, STEP_STATES[step.kind], { busy: false });
        this.emit('onError', refusal);
        return;
      }
      // A definitive refusal: the payment is back to `pending`.
      this.knownStatus = 'pending';
      this.stopWatching();
      this.inFlight = false;
      this.fail(refusal);
    } catch (e) {
      if (!this.onStep(step.id)) return;
      this.stepRequestFailed(e, (error) =>
        this.show({ name: 'step', step: { ...this.currentStep(step), error } }, STEP_STATES[step.kind], { busy: false }),
      );
    }
  }

  /** A verify that got an error answer, or none. */
  private stepRequestFailed(e: unknown, stay: (message: string | null) => void): void {
    const error = e instanceof WajubError ? e.localized(this.lang) : WajubError.create('network_error', { lang: this.lang });
    const status = error.http_status;
    if (status === 410) return this.end('expired', error);
    if (status === 401 || status === 403 || status === 404) {
      this.stopWatching();
      this.inFlight = false;
      return this.fail(WajubError.create('session_not_found', { lang: this.lang, httpStatus: status }));
    }
    if (status === 422) {
      const fieldErrors: Record<string, string> = {};
      for (const [key, message] of Object.entries(error.details ?? {})) {
        fieldErrors[key.replace(/^data\./, '')] = this.lang === 'en' ? message : WajubError.create(/required/i.test(message) ? 'field_required' : 'validation_error', { lang: 'fr' }).message;
      }
      stay(null);
      this.update({ fieldErrors });
      return;
    }
    // No answer, or the API's error: the status may have moved. Read it, and let the payer try again.
    this.watcher?.pollNow();
    stay(error.message);
    this.emit('onError', error);
  }

  /** "Resend": offered 60 s after the screen opened; the countdown restarts. */
  async resendStep(): Promise<void> {
    const screen = this.snapshot.screen;
    if (this.abandoned() || this.snapshot.busy) return;
    if (screen.name === 'step') {
      const step = { ...screen.step, resendAt: Date.now() + UI_TIMINGS.resendAfterMs };
      this.update({ screen: { name: 'step', step } });
      await this.client.resendStep(this.token, step.kind, step.id).catch(() => undefined);
    } else if (screen.name === 'three_ds') {
      const threeDs = { ...screen.threeDs, resendAt: Date.now() + UI_TIMINGS.resendAfterMs };
      this.update({ screen: { name: 'three_ds', threeDs } });
      await this.client.send3ds(this.token, threeDs.id).catch(() => undefined);
    }
  }

  /** The sandbox 3-D Secure email code (README §10.1). */
  async submit3ds(code: string): Promise<void> {
    const screen = this.snapshot.screen;
    if (screen.name !== 'three_ds' || this.snapshot.busy || this.abandoned()) return;
    const value = code.trim();
    if (!/^[A-Za-z0-9]{4,8}$/.test(value)) {
      this.update({ fieldErrors: { code: WajubError.create(value ? 'invalid_code' : 'field_required', { lang: this.lang }).message } });
      return;
    }
    const threeDs = screen.threeDs;
    this.show(screen, 'VERIFYING', { busy: true, fieldErrors: {} });
    try {
      await this.client.verify3ds(this.token, threeDs.id, value);
      if (!this.onStep(threeDs.id)) return;
      if (this.threeDsTimer) clearTimeout(this.threeDsTimer);
      this.threeDsTimer = null;
      // Accepted: VERIFYING while the watch brings the outcome.
      this.update({ screen: { name: 'three_ds', threeDs: { ...threeDs, accepted: true, error: null } } });
    } catch (e) {
      if (!this.onStep(threeDs.id)) return;
      const error = e instanceof WajubError ? e : null;
      const status = error?.http_status ?? null;
      const stay = (message: string | null) => {
        const now = this.snapshot.screen;
        const current = now.name === 'three_ds' ? now.threeDs : threeDs;
        this.show({ name: 'three_ds', threeDs: { ...current, error: message } }, '3DS_REQUIRED', { busy: false });
      };
      // A wrong code is a 422 (`invalid_code`), and today a 500 (an API bug): same screen.
      if ((status === 422 && !error?.code.startsWith('3ds_')) || (status !== null && status >= 500)) {
        stay(WajubError.create('invalid_code', { lang: this.lang }).message);
        this.watcher?.pollNow();
        return;
      }
      if (status === 422 && error) {
        this.stopWatching();
        this.inFlight = false;
        this.fail(error.localized(this.lang));
        return;
      }
      this.stepRequestFailed(e, stay);
    }
  }

  // ── watching (README §13) ───────────────────────────────────────────────────

  private watch(seenProcessing: boolean): void {
    this.inFlight = true;
    if (this.watcher) return;
    // 15 minutes of the monotonic clock from the attempt's start; never a server timestamp
    // (`expires_at`) against the device's wall clock: the API's 410 says when the session is over.
    const attemptStart = this.attempt?.startedAt ?? monotonicNow();
    this.watcher = new StatusWatcher({
      client: this.client,
      token: this.token,
      transactionId: this.transaction?.id ?? '',
      echo: this.snapshot.session?.echo,
      realtime: this.options.realtime,
      lang: this.lang,
      seenProcessing,
      deadline: attemptStart + POLLING.overallCapMs,
      onOutcome: (outcome) => this.onWatchOutcome(outcome),
      onStatus: (status) => {
        this.knownStatus = status.status;
        this.checkUnanswered(status);
        this.checkNotProcessable(status);
        this.knownErrorCode = status.error_code ?? null;
      },
    });
    this.watcher.start();
  }

  private stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  /**
   * README §2.5: a request that got no answer, and a status still `pending`
   * (never `processing`, no `error_code` other than the one it carried before
   * the attempt — a refusal left by an earlier try is not news) a minute
   * after its last try: it most likely never reached the API. Back to the
   * form; the next Pay sends it again under the same key.
   */
  private checkUnanswered(status: PaymentStatus): void {
    const unanswered = this.unanswered;
    if (!unanswered || this.settled) return;
    if (status.status !== 'pending') {
      // Processing (it reached the API) or an outcome, which the watch decides.
      this.unanswered = null;
      return;
    }
    if (status.error_code && unanswered.baseline !== undefined && status.error_code !== unanswered.baseline) {
      // A refusal newer than the attempt: it reached the API and was declined, nothing charged.
      this.unanswered = null;
      return this.fail(attemptEnded(status, this.lang));
    }
    if (monotonicNow() - unanswered.sentAt < UI_TIMINGS.unansweredMs) return;
    this.unanswered = null;
    this.stopWatching();
    this.inFlight = false;
    this.reuseKey = unanswered.key;
    const error = WajubError.create('network_error', { lang: this.lang });
    const screen = this.chosen ? ({ name: 'form', method: this.chosen } as Screen) : ({ name: 'methods' } as Screen);
    this.show(screen, this.chosen ? 'COLLECTING_DETAILS' : 'INITIATED', { banner: error, busy: false });
    this.emit('onError', error);
  }

  /** After a 400 whose status re-read said nothing: `pending` is what the re-read would have failed on. */
  private checkNotProcessable(status: PaymentStatus): void {
    const attempt = this.notProcessable;
    if (!attempt || this.settled) return;
    if (attempt !== this.attempt || status.status !== 'pending') {
      this.notProcessable = null;
      return;
    }
    this.notProcessable = null;
    this.fail(WajubError.create('not_processable', { lang: this.lang, httpStatus: 400 }));
  }

  private onWatchOutcome(outcome: WatchOutcome): void {
    this.watcher = null;
    if (this.settled) return;
    if (outcome.kind === 'ended') return;
    // The PSP's answer is being checked: a poll's refusal (perhaps an earlier try's) waits for it.
    if (this.completing && outcome.kind !== 'success' && outcome.kind !== 'cap') {
      this.deferredOutcome = outcome;
      return;
    }
    if (outcome.kind === 'cap') {
      // "Payment in progress — you will be notified": closing resolves processing.
      this.show({ name: 'pending', url: this.pendingUrl, capped: true }, 'PENDING', { busy: false });
      return;
    }
    this.inFlight = false;
    this.update({ busy: false });
    if (outcome.kind === 'success') {
      void this.succeedAfterWatch();
      return;
    }
    if (outcome.kind === 'cancelled') return this.end('cancelled', outcome.error);
    if (outcome.kind === 'expired') return this.end('expired', outcome.error);
    this.fail(outcome.error);
  }

  /** Paid: the session read once more for its receipt and end time (best effort). */
  private async succeedAfterWatch(): Promise<void> {
    const attempt = this.attempt;
    let transaction: SessionTransaction = { ...this.transaction!, status: 'succeeded' };
    try {
      const session = await this.client.getSession(this.token);
      if (SUCCESS_STATUSES.includes(session.transaction.status)) transaction = session.transaction;
    } catch {
      /* the transaction already known will do */
    }
    // A success wins over a failure shown for this same attempt meanwhile.
    if (this.settled || attempt !== this.attempt || (this.finished() && this.snapshot.screen.name !== 'failed')) return;
    this.succeed(transaction, attempt?.method ?? 'unknown');
  }

  // ── outcomes ───────────────────────────────────────────────────────────────

  private succeed(transaction: SessionTransaction, method: string): void {
    // A success wins over a failure shown for the same attempt (one read from a provisional status).
    if (this.settled || this.snapshot.screen.name === 'success') return;
    this.stopWatching();
    this.inFlight = false;
    this.transaction = transaction;
    const payment = this.paymentOf(transaction, method);
    this.show({ name: 'success', payment }, 'SUCCESS', { busy: false, banner: null });
    this.emit('onSuccess', payment);
    const delay = this.options.autoCloseSuccess ?? UI_TIMINGS.autoCloseSuccessMs;
    if (delay > 0) {
      this.successTimer = setTimeout(() => this.settle({ status: 'complete', payment, transaction }), delay);
    }
  }

  /** FAILED: "Try again" when the error is retryable. */
  private fail(error: WajubError): void {
    if (this.settled || this.finished()) return;
    this.stopWatching();
    this.inFlight = false;
    this.show({ name: 'failed', error }, 'FAILED', { busy: false, banner: null });
    this.emit('onError', error);
  }

  /**
   * Nothing was sent: no Altcha solution could be had (its challenge did not
   * load, or could not be solved). The form again with a retryable banner;
   * the next Pay asks for a challenge again.
   */
  private notSent(error: WajubError): void {
    if (this.settled || this.finished()) return;
    this.inFlight = false;
    this.show(this.snapshot.screen, 'COLLECTING_DETAILS', { busy: false, banner: error });
    this.emit('onError', error);
  }

  /** EXPIRED or CANCELLED (a `cancelled` status seen): final for the sheet. */
  private end(name: 'expired' | 'cancelled', error: WajubError): void {
    if (this.settled || this.finished()) return;
    this.stopWatching();
    this.inFlight = false;
    this.show({ name, error }, name === 'expired' ? 'EXPIRED' : 'CANCELLED', { busy: false, banner: null });
    this.emit('onError', error);
  }

  /** "Try again" on the failure screen: the same method's form, a new key on the next Pay. */
  tryAgain(): void {
    const screen = this.snapshot.screen;
    if (screen.name !== 'failed' || !screen.error.retryable || this.abandoned()) return;
    if (screen.error.code === 'security_check_failed') this.altchaRetried = false;
    if (this.attempt?.endpoint === 'client_session') this.restartClientSession = true;
    this.attempt = null;
    this.clientSessionId = null;
    this.pendingUrl = null;
    this.inFlight = false;
    if (this.chosen) this.choose(this.chosen);
    else if (this.snapshot.methods.length === 1) this.choose(this.snapshot.methods[0]);
    else this.show({ name: 'methods' }, 'INITIATED', { banner: null, fieldErrors: {} });
  }

  // ── cancel, dismiss, host gone (README §14, states.md §5) ──────────────────

  /** "Cancel payment": cancelled for good on Wajub (`payer_cancelled`). */
  async cancelPayment(): Promise<void> {
    if (!this.snapshot.canCancel || this.abandoned()) return;
    this.update({ cancelling: true, busy: true });
    try {
      const { redirect_url } = await this.client.cancel(this.token);
      this.settle(this.cancelled('payer_cancelled', redirect_url));
    } catch (e) {
      if (e instanceof WajubError && e.http_status === 400) {
        await this.resolveRefusedCancel('payer_cancelled');
        return;
      }
      // A failed cancel changes nothing for the payer.
      this.settle(this.cancelled('payer_cancelled', null));
    }
  }

  /** A cancel answered 400: the payment already ended, or is under way. The status decides. */
  private async resolveRefusedCancel(reason: 'payer_cancelled' | 'dismissed'): Promise<void> {
    let status = '';
    try {
      status = (await this.client.getStatus(this.token)).status;
    } catch {
      status = '';
    }
    if (this.settled) return;
    if (status) this.knownStatus = status;
    this.update({ cancelling: false, busy: false });
    // Refused, and the status unknown: the payment may be under way.
    if (!status) return this.settle(this.processingResult());
    if (SUCCESS_STATUSES.includes(status)) {
      const transaction = { ...this.transaction!, status };
      if (reason === 'dismissed') return this.settle({ status: 'complete', payment: this.paymentOf(transaction, 'unknown'), transaction });
      return this.succeed(transaction, 'unknown');
    }
    if (status === 'cancelled') return this.settle(this.cancelled(reason, null));
    if (status === 'failed' || status === 'expired') {
      const error = WajubError.create(status === 'failed' ? 'payment_failed' : 'session_expired', { lang: this.lang });
      return this.settle({ status: 'failed', error, transaction: this.transaction });
    }
    if (status === 'processing' || status === 'partial') {
      if (reason === 'dismissed') return this.settle(this.processingResult());
      this.show({ name: 'pending', url: null, capped: false }, 'PENDING');
      this.watch(true);
      return;
    }
    if (reason === 'dismissed') return this.settle(this.cancelled(reason, null));
    this.update({ banner: WajubError.create('not_processable', { lang: this.lang }) });
  }

  /** Wajub.js's PaymentSuccess (states.md §3): `amount` is what the payer paid, fee included. */
  private paymentOf(transaction: SessionTransaction, method: string): PaymentSuccess {
    const payment: PaymentSuccess = {
      id: transaction.id,
      amount: transaction.amount_total ?? transaction.amount,
      currency: transaction.currency,
      method: PAYMENT_METHODS.includes(method) ? method : 'unknown',
      status: 'success',
      timestamp: transaction.terminal_at ?? transaction.updated_at ?? new Date().toISOString(),
    };
    if (transaction.reference) payment.reference = transaction.reference;
    if (transaction.receipt_url) payment.receipt_url = transaction.receipt_url;
    return payment;
  }

  private cancelled(reason: 'payer_cancelled' | 'dismissed' | 'host_gone', redirectUrl: string | null): CheckoutResult {
    return { status: 'cancelled', reason, redirectUrl, cancelled: true };
  }

  /** What closing the sheet now means, when no API call is involved; null for "cancel first". */
  private closingResult(reason: 'dismissed' | 'host_gone'): CheckoutResult | null {
    const screen = this.snapshot.screen;
    // The session answered, its screen not up yet (sdk-config still coming): its status decides at once.
    if (!this.ready && this.knownStatus && this.transaction) {
      const status = this.knownStatus;
      if (SUCCESS_STATUSES.includes(status)) return { status: 'complete', payment: this.paymentOf(this.transaction, 'unknown'), transaction: this.transaction };
      const ended = TERMINAL_AT_LOAD[status];
      if (ended) return { status: 'failed', error: WajubError.create(ended, { lang: this.lang }), transaction: this.transaction };
      if (status === 'processing' || status === 'partial') return this.processingResult();
    }
    if (screen.name === 'success') return { status: 'complete', payment: screen.payment, transaction: this.transaction! };
    if (screen.name === 'failed' || screen.name === 'expired' || screen.name === 'cancelled' || screen.name === 'load_error') {
      return { status: 'failed', error: screen.error, transaction: this.transaction };
    }
    // Money may still move: the merchant confirms server-side.
    if (this.inFlight || this.attempt?.started || this.stripePressed) return this.processingResult();
    return reason === 'host_gone' ? this.cancelled('host_gone', null) : null;
  }

  /** `processing`: the payment as last seen, with the instruction the payer had. */
  private processingResult(): CheckoutResult {
    const transaction = this.transaction;
    if (!transaction) return this.cancelled('dismissed', null);
    const screen = this.snapshot.screen;
    const instruction =
      screen.name === 'approval' || screen.name === 'ussd' ? screen.instruction : (transaction.processing_context?.payer_instruction ?? null);
    return { status: 'processing', transaction, instruction };
  }

  /** Swipe down, back, the close button, or "Close" on a final screen. Bound: usable as a handler. */
  dismiss = (): void => {
    if (this.settled || this.snapshot.cancelling) return;
    const result = this.closingResult('dismissed');
    if (result) {
      // A failure the payer closes: `failed`, with the error they saw. A payment that may be
      // cancelled is cancelled too, so the order is released — no onCancel (README §14).
      if (this.snapshot.screen.name === 'failed' && this.options.cancelOnDismiss !== false && this.mayCancel()) {
        this.client.cancel(this.token).catch(() => undefined);
      }
      return this.settle(result);
    }
    // Nothing known of the payment yet, or a payment that must not be cancelled: no call.
    if (this.options.cancelOnDismiss === false || !this.mayCancel()) return this.settle(this.cancelled('dismissed', null));
    // Before any attempt: the payer left, the payment is cancelled on Wajub too.
    this.update({ visible: false, cancelling: true });
    this.stopTimers();
    this.client.cancel(this.token).then(
      ({ redirect_url }) => this.settle(this.cancelled('dismissed', redirect_url)),
      (e: unknown) => {
        if (e instanceof WajubError && e.http_status === 400) void this.resolveRefusedCancel('dismissed');
        else this.settle(this.cancelled('dismissed', null));
      },
    );
  };

  /** The component hosting the sheet unmounted: settle without any API call. */
  hostGone(): void {
    if (this.settled) return;
    this.settle(this.closingResult('host_gone') ?? this.cancelled('host_gone', null));
  }

  private stopTimers(): void {
    for (const timer of [this.readyTimer, this.successTimer, this.threeDsTimer, this.graceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.readyTimer = this.successTimer = this.threeDsTimer = this.graceTimer = null;
  }

  private settle(result: CheckoutResult): void {
    if (this.settled) return;
    this.settled = true;
    this.stopTimers();
    this.stopWatching();
    this.loadAbort?.abort();
    this.altchaSolves.forEach((signal) => (signal.aborted = true));
    this.appState?.remove();
    this.appState = null;
    this.update({ visible: false, busy: false, cancelling: false });
    if (result.status === 'cancelled') this.emit('onCancel', { reason: result.reason, redirectUrl: result.redirectUrl });
    this.emit('onComplete', result);
    this.resolve(result);
  }
}
