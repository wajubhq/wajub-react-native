import { PayClient } from './client/payClient';
import { buildMobileMoneyRequest, mapProcessResponse, mapStatusToResult } from './mappers/paymentMapper';
import { buildStripeCardRequest } from './adapters/stripeAdapter';
import { openHostedRedirect } from './adapters/hostedRedirect';
import { subscribeStatus } from './realtime/statusSubscriber';
import type { MobileMoneyInput, PaymentResult, SdkConfig, SessionData } from './types';

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

  async process(channel: string, data: Record<string, unknown>): Promise<PaymentResult> {
    const raw = await this.client.process(this.token, channel, data);
    return mapProcessResponse(raw, this.methodType(channel));
  }

  async handleRedirectAction(result: PaymentResult): Promise<boolean> {
    if (result.status !== 'requires_action') {
      return false;
    }
    if (!['redirect', 'confirm', 'confirm_3ds'].includes(result.action)) {
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
    return 'unknown';
  }
}

/** Create a session from the backend `authorization_token`. */
export function createSession(authorizationToken: string, client?: PayClient): WajubSession {
  return new WajubSession(authorizationToken, client);
}

export { mapStatusToResult };
