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
  /** Where the SDK keeps its data: any `{ getItem, setItem }`. Default: AsyncStorage. */
  storage?: WajubStorage;
}

/**
 * One payment, for an app that draws its own payment screens. The 1.4
 * methods report errors as 1.4 did; `session()`, `sdkConfig()`, `status()`,
 * `submit()` and the step calls with the codes and messages of the payment
 * sheet.
 */
export class WajubSession {
  private cachedSession: SessionData | null = null;
  private readonly client: PayClient;
  /** The same client, with the payment sheet's errors. */
  private readonly v2: PayClient;

  constructor(
    private readonly token: string,
    client: PayClient = new PayClient(),
    options: WajubSessionOptions = {},
  ) {
    this.client = options.storage ? client.with({ storage: options.storage }) : client;
    this.v2 = this.client.with({ errors: 'v2' });
  }

  /** The payment, its methods and the merchant's branding; read once unless `forceRefresh`. */
  async loadSession(forceRefresh = false): Promise<SessionData> {
    if (!forceRefresh && this.cachedSession) {
      return this.cachedSession;
    }
    const session = await this.client.getSession(this.token);
    this.cachedSession = session;
    return session;
  }

  /** The payment, its methods and the merchant's branding, read now. */
  async session(): Promise<SessionData> {
    this.cachedSession = await this.v2.getSession(this.token);
    return this.cachedSession;
  }

  async getSdkConfig(): Promise<SdkConfig> {
    return this.client.getSdkConfig(this.token);
  }

  /** How each payment method collects its details. */
  async sdkConfig(): Promise<SdkConfig> {
    return this.v2.getSdkConfig(this.token);
  }

  /**
   * Where the payment is. Its `reference` is the payment's id
   * (`transaction.id`), not the merchant's reference: never compare the two.
   */
  async status(): Promise<PaymentStatus> {
    return this.v2.getStatus(this.token);
  }

  /**
   * Pays with one of the payment's `channels` (its slug): `complete`,
   * `processing`, `requires_action` (a provider's page, or a confirmation
   * step with its `stepId` and `hint`) or `failed`. Mobile Money `data`:
   * `{ phone (E.164), country, operator? }`. `idempotencyKey`: the same key
   * makes a repeated call the same attempt; a new one is made when absent.
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
   * A card paid on the provider's own page: returns `requires_action` /
   * `redirect` to it. `billing` carries every field of the method's
   * `required_fields`.
   */
  async payCardHostedRedirect(
    channel: string,
    billing: Partial<Record<HostedCardField, string>> = {},
  ): Promise<PaymentResult> {
    await this.loadSession();
    return this.process(channel, buildHostedCardRequest(billing));
  }

  /**
   * A one-tap wallet: returns `requires_action` / `redirect` to the wallet's
   * payment page, which opens the wallet app on the device.
   */
  async payWallet(channel: string): Promise<PaymentResult> {
    await this.loadSession();
    return this.process(channel, {});
  }

  /**
   * A payment attempt, read the 1.4 way. `idempotencyKey`: the same key
   * makes a repeated call the same attempt; a new one is made when absent.
   */
  async process(channel: string, data: Record<string, unknown>, options: { idempotencyKey?: string } = {}): Promise<PaymentResult> {
    const raw = await this.client.process(this.token, channel, data, options);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * Opens the provider's own card checkout, for a method whose
   * `client_session` is `true`. Returns `requires_action` / `client_session`:
   * open `client_session.hosted_url` (or launch the provider's SDK with it),
   * then call `completeClientSession()`. `payCardHosted()` does it all.
   */
  async startClientSession(channel: string, options: ClientSessionOptions = {}): Promise<PaymentResult> {
    await this.loadSession();
    const raw = await this.client.startClientSession(this.token, channel, options);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * The payer is back from the provider's checkout. `complete`: paid;
   * `processing`: not confirmed yet, keep `watchStatus()` running. Throws a
   * `WajubError` with a `decline_code` on a decline.
   */
  async completeClientSession(clientSessionId: string, channel = 'card'): Promise<PaymentResult> {
    const raw = await this.client.completeClientSession(this.token, clientSessionId);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  /**
   * A card paid in the provider's own checkout, in one call: opens it in the
   * system browser, waits for the payer to come back, and checks the payment.
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

  /** Sends the step's code again. */
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

  /** Opens the provider's page a `requires_action` result asks for; `false` when there is none. */
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

  /** Cancels the payment for good; resolves with the merchant's page for a cancelled payer, if any. */
  async cancel(): Promise<string | null> {
    const result = await this.client.cancel(this.token);
    return result.redirect_url;
  }

  /**
   * For a payment screen of your own the payer closed: when nothing had been
   * `submitted`, the payment is cancelled; an attempt under way is left
   * alone, since a Mobile Money approval can still land. It never rejects.
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
   * Reports the payment's status until it ends: `onUpdate` gets each result.
   * Returns a function that stops it.
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
