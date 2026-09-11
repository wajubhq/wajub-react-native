import type { WajubSession } from './WajubSession';
import type { PaymentResult } from './types';
import { openHostedRedirect } from './adapters/hostedRedirect';

/**
 * Handles post-process actions natively — redirect / 3DS open the system browser, never WebView.
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

/** Opens a hosted-redirect channel URL directly (sdk-config `hosted_redirect`). */
export async function openHostedRedirectUrl(url: string): Promise<boolean> {
  return openHostedRedirect(url);
}
