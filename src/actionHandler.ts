import type { WajubSession } from './WajubSession';
import type { PaymentResult } from './types';
import { openHostedRedirect } from './adapters/hostedRedirect';

/**
 * Follows what a payment's answer asks for: a provider's page or 3-D Secure opens in the system browser, never a WebView.
 */
export async function handlePaymentAction(
  session: WajubSession,
  result: PaymentResult,
): Promise<PaymentResult> {
  if (result.status !== 'requires_action') {
    return result;
  }

  if (
    result.action === 'redirect' ||
    result.action === 'confirm_3ds' ||
    result.action === 'confirm' ||
    result.action === 'client_session'
  ) {
    const url = result.action_url;
    if (url) {
      await session.handleRedirectAction(result);
    }
  }

  return result;
}

/** Opens a provider's card page in the system browser. */
export async function openHostedRedirectUrl(url: string): Promise<boolean> {
  return openHostedRedirect(url);
}
