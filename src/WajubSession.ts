import { PayClient } from './client/payClient';
import {
  buildHostedCardRequest,
  buildMobileMoneyRequest,
  mapProcessResponse,
  mapStatusToResult,
} from './mappers/paymentMapper';
import { buildStripeCardRequest } from './adapters/stripeAdapter';
import { openHostedRedirect, openHostedRedirectAndWait } from './adapters/hostedRedirect';
import { subscribeStatus } from './realtime/statusSubscriber';
import { WajubError } from './WajubError';
import type {
  ClientSessionOptions,
  HostedCardField,
  MobileMoneyInput,
  PaymentResult,
  SdkConfig,
  SessionData,
} from './types';

/** Session-scoped checkout client — `/pay/*` without WebView. */
export class WajubSession {
  private cachedSession: SessionData | null = null;

  constructor(
    private readonly token: string,
    private readonly client: PayClient = new PayClient(),
  ) {}

  async loadSession(forceRefresh = false): Promise<SessionData> {
    if (!forceRefresh && this.cachedSession) {
      return this.cachedSession;
    }
    const session = await this.client.getSession(this.token);
    this.cachedSession = session;
    return session;
  }

  async getSdkConfig(): Promise<SdkConfig> {
    return this.client.getSdkConfig(this.token);
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

  async process(channel: string, data: Record<string, unknown>): Promise<PaymentResult> {
    const raw = await this.client.process(this.token, channel, data);
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

  watchStatus(onUpdate: (result: PaymentResult) => void, intervalMs = 5000): () => void {
    let stop: (() => void) | null = null;
    void this.loadSession().then((session) => {
      stop = subscribeStatus(this.client, this.token, session, onUpdate, intervalMs);
    });
    return () => stop?.();
  }

  cardChannelSlug(): string | undefined {
    return this.cachedSession?.channels.find((c) => c.type.toLowerCase() === 'card')?.slug;
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
export function createSession(authorizationToken: string, client?: PayClient): WajubSession {
  return new WajubSession(authorizationToken, client);
}

export { mapStatusToResult };
