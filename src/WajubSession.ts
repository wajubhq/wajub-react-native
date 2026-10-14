import { PayClient } from './client/payClient';
import {
  buildHostedCardRequest,
  buildMobileMoneyRequest,
  mapProcessOutcome,
  mapProcessResponse,
  mapStatusToResult,
} from './mappers/paymentMapper';
import { buildStripeCardRequest } from './adapters/stripeAdapter';
import { openHostedRedirect, openHostedRedirectAndWait } from './adapters/hostedRedirect';
import { subscribeStatus } from './realtime/statusSubscriber';
import { WajubError } from './WajubError';
import type {
  ClientSessionOptions,
  ConfirmStepKind,
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  PaymentStatus,
  ProcessOutcome,
  SdkConfig,
  SessionData,
  StepVerifyResponse,
  WajubStorage,
} from './types';

export interface WajubSessionOptions {
  /** Where the device fingerprint's install id is kept. Default: AsyncStorage. */
  storage?: WajubStorage;
}

/**
 * Session-scoped checkout client — `/pay/*` without WebView, for a host that
 * draws its own UI. Every call goes through the SDK's transport: its headers,
 * timeouts and retries (a payment's retries resend the same Idempotency-Key).
 * The 1.4 methods report errors as 1.4 did; the v2 ones (`session()`,
 * `sdkConfig()`, `status()`, `submit()`, the step calls) with the spec's
 * catalogue.
 */
export class WajubSession {
  private cachedSession: SessionData | null = null;
  private readonly client: PayClient;
  /** The same transport, errors mapped by the spec's catalogue. */
  private readonly v2: PayClient;

  constructor(
    private readonly token: string,
    client: PayClient = new PayClient(),
    options: WajubSessionOptions = {},
  ) {
    this.client = options.storage ? client.with({ storage: options.storage }) : client;
    this.v2 = this.client.with({ errors: 'v2' });
  }

  async loadSession(forceRefresh = false): Promise<SessionData> {
    if (!forceRefresh && this.cachedSession) {
      return this.cachedSession;
    }
    const session = await this.client.getSession(this.token);
    this.cachedSession = session;
    return session;
  }

  /** GET /pay/session, fresh. */
  async session(): Promise<SessionData> {
    this.cachedSession = await this.v2.getSession(this.token);
    return this.cachedSession;
  }

  async getSdkConfig(): Promise<SdkConfig> {
    return this.client.getSdkConfig(this.token);
  }

  /** GET /pay/sdk-config, keyed by raw slug (`cm.mtn`, never `cm.mobile`). */
  async sdkConfig(): Promise<SdkConfig> {
    return this.v2.getSdkConfig(this.token);
  }

  /**
   * GET /pay/status. Its `reference` is the payment's id (`transaction.id`),
   * not the merchant's reference: never compare the two.
   */
  async status(): Promise<PaymentStatus> {
    return this.v2.getStatus(this.token);
  }

  /**
   * POST /pay/process, read spec v2's way (`ProcessOutcome`): the
   * confirmation steps come with their `stepId` and `hint`. `idempotencyKey`:
   * one per payment attempt (a new one when absent), reused by the automatic
   * retries. Mobile Money `data`: `{ phone (E.164), country, operator? }`.
   */
  async submit(channel: string, data: Record<string, unknown>, options: { idempotencyKey?: string } = {}): Promise<ProcessOutcome> {
    const raw = await this.v2.process(this.token, channel, data, options);
    return mapProcessOutcome(raw, this.methodType(channel));
  }

  async payMobileMoney(input: MobileMoneyInput): Promise<PaymentResult> {
    await this.loadSession();
    const data = buildMobileMoneyRequest(input);
    const raw = await this.client.process(this.token, input.channel_slug, data);
    return mapProcessResponse(raw, 'mobile_money');
  }

  async payCard(channelSlug: string, paymentMethodId: string, cardholderName?: string | null): Promise<PaymentResult> {
    await this.loadSession();
    const data = buildStripeCardRequest(paymentMethodId, cardholderName);
    const raw = await this.client.process(this.token, channelSlug, data);
    return mapProcessResponse(raw, 'card');
  }

  /**
   * Card on a `hosted_redirect` channel (PayPal, Mollie, Paddle, Kkiapay,
   * FedaPay, PayDunya, CinetPay): returns `requires_action` / `redirect` to
   * the PSP's own card page. `billing` must carry every field sdk-config
   * lists in the channel's `required_fields`.
   */
  async payCardHostedRedirect(
    channel: string,
    billing: Partial<Record<HostedCardField, string>> = {},
  ): Promise<PaymentResult> {
    await this.loadSession();
    return this.process(channel, buildHostedCardRequest(billing));
  }

  /**
   * One-tap wallet channel (sdk-config `form`, no `required_fields`, channel
   * type `wallet` — e.g. Djamo): returns `requires_action` / `redirect` to the
   * wallet's payment page, which opens the wallet app on the device.
   */
  async payWallet(channel: string): Promise<PaymentResult> {
    await this.loadSession();
    return this.process(channel, {});
  }

  /**
   * POST /pay/process. `idempotencyKey`: one per payment attempt (a new one
   * is made when absent); the automatic retries of the call reuse it.
   */
  async process(channel: string, data: Record<string, unknown>, options: { idempotencyKey?: string } = {}): Promise<PaymentResult> {
    const raw = await this.client.process(this.token, channel, data, options);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * Opens (or re-serves) a PSP-hosted checkout for a card channel whose
   * sdk-config has `client_session: true` (Paystack, Flutterwave). Returns
   * `requires_action` / `client_session` — open `client_session.hosted_url`
   * (or launch the PSP's native SDK with it), then call
   * `completeClientSession()`. See `payCardHosted()` for the one-call flow.
   */
  async startClientSession(channel: string, options: ClientSessionOptions = {}): Promise<PaymentResult> {
    await this.loadSession();
    const raw = await this.client.startClientSession(this.token, channel, options);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * Verifies a client session once the payer is back. `complete` = paid;
   * `processing` = not confirmed yet (keep `watchStatus()` running — the PSP
   * webhook settles it). Throws WajubError (402) on a definitive failure.
   */
  async completeClientSession(clientSessionId: string, channel = 'card'): Promise<PaymentResult> {
    const raw = await this.client.completeClientSession(this.token, clientSessionId);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * One-call hosted card payment: start the client session, open the PSP's
   * page in the system browser, wait for the payer to come back, complete.
   */
  async payCardHosted(channel: string, options: ClientSessionOptions = {}): Promise<PaymentResult> {
    const started = await this.startClientSession(channel, options);
    if (started.status !== 'requires_action' || started.action !== 'client_session' || !started.client_session) {
      return started;
    }

    const url = started.client_session.hosted_url;
    if (!url || !(await openHostedRedirectAndWait(url))) {
      return started;
    }

    try {
      return await this.completeClientSession(started.client_session.id, channel);
    } catch (e) {
      // The payer already went through the PSP's page: only a 402 is a
      // verified decline. Anything else (network, expired session) may still
      // be settled by the PSP webhook — report processing so the app keeps
      // watching the status instead of offering a fresh attempt.
      if (e instanceof WajubError && e.decline_code) {
        return { status: 'failed', error: e, transaction: started.transaction };
      }
      return { status: 'processing', transaction: started.transaction };
    }
  }

  // ── confirmation steps: the `stepId` and `hint` of a `requires_action` ──────

  /** `confirm_otp`: the code the payer received (4–10 digits). */
  verifyOtp(otpId: string, code: string): Promise<StepVerifyResponse> {
    return this.v2.verifyStep(this.token, 'otp', { otp_id: otpId, code });
  }

  /** `confirm_pin`: the card's PIN (4–6 digits). */
  verifyPin(pinId: string, pin: string): Promise<StepVerifyResponse> {
    return this.v2.verifyStep(this.token, 'pin', { pin_id: pinId, pin });
  }

  /** `confirm_phone`: the payer's phone number. */
  verifyPhone(phoneId: string, phone: string): Promise<StepVerifyResponse> {
    return this.v2.verifyStep(this.token, 'phone', { phone_id: phoneId, phone });
  }

  /** `confirm_birthday`: `YYYY-MM-DD`. */
  verifyBirthday(birthdayId: string, birthday: string): Promise<StepVerifyResponse> {
    return this.v2.verifyStep(this.token, 'birthday', { birthday_id: birthdayId, birthday });
  }

  /** `confirm_address`: every field is required. */
  verifyAddress(
    addressId: string,
    address: { address: string; city: string; state: string; zip_code: string },
  ): Promise<StepVerifyResponse> {
    return this.v2.verifyStep(this.token, 'address', { address_id: addressId, ...address });
  }

  /** Asks for the step again; the API does nothing today, and answers 200. */
  resend(kind: ConfirmStepKind, stepId: string): Promise<void> {
    return this.v2.resendStep(this.token, kind, stepId);
  }

  /** Sandbox 3-D Secure: the code sent by email (`confirm_3ds` with a `stepId`). */
  verify3ds(threeDsId: string, code: string): Promise<void> {
    return this.v2.verify3ds(this.token, threeDsId, code);
  }

  /** Sandbox 3-D Secure: a new code by email. */
  send3ds(threeDsId: string): Promise<void> {
    return this.v2.send3ds(this.token, threeDsId);
  }

  async handleRedirectAction(result: PaymentResult): Promise<boolean> {
    if (result.status !== 'requires_action') {
      return false;
    }
    if (!['redirect', 'confirm', 'confirm_3ds', 'client_session'].includes(result.action)) {
      return false;
    }
    const url = result.action_url;
    if (!url) return false;
    return openHostedRedirect(url);
  }

  async cancel(): Promise<string | null> {
    const result = await this.client.cancel(this.token);
    return result.redirect_url;
  }

  /**
   * For a payment sheet the payer closed. When nothing had been `submitted`,
   * the payment is cancelled on Wajub too (`POST /pay/cancel`), as the hosted
   * checkout does; an attempt under way is left alone, since a Mobile Money
   * approval can still land. Best effort: it never rejects.
   */
  async cancelIfNothingSubmitted(submitted: boolean): Promise<void> {
    if (submitted) return;
    try {
      await this.cancel();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Watches the payment until it ends: polling on the spec's schedule next to
   * the realtime channel. `onUpdate` gets each new result; returns a stop function.
   */
  watchStatus(onUpdate: (result: PaymentResult) => void, intervalMs?: number): () => void {
    let stop: (() => void) | null = null;
    let stopped = false;
    void this.loadSession().then((session) => {
      if (!stopped) stop = subscribeStatus(this.client, this.token, session, onUpdate, intervalMs);
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }

  cardChannelSlug(): string | undefined {
    return this.cachedSession?.channels.find((c) => c.type.toLowerCase() === 'card')?.slug;
  }

  /** @internal The token and transport, for the payment sheet built on this session. */
  get transport(): { token: string; client: PayClient } {
    return { token: this.token, client: this.client };
  }

  private methodType(channel: string): string {
    const match = this.cachedSession?.channels.find((c) => c.slug === channel);
    const type = match?.type.toLowerCase();
    if (type === 'mobile_money' || type === 'mobile') return 'mobile_money';
    if (type === 'card') return 'card';
    if (type === 'wallet') return 'wallet';
    return 'unknown';
  }
}

/** Create a session from the backend `authorization_token`. */
export function createSession(authorizationToken: string, client?: PayClient, options?: WajubSessionOptions): WajubSession {
  return new WajubSession(authorizationToken, client, options);
}

export { mapStatusToResult };
