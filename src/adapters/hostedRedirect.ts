import { AppState, Linking } from 'react-native';

/**
 * Opens a provider's page in the system browser, never in a WebView.
 * Resolves `false` when it cannot be opened. No `<queries>` block is needed
 * in your Android manifest.
 */
export async function openHostedRedirect(url: string): Promise<boolean> {
  try {
    if (!/^https:\/\//i.test(url)) {
      const supported = await Linking.canOpenURL(url);
      if (!supported) return false;
    }
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** How long `openHostedRedirectAndWait()` waits for the payer to come back. */
const RETURN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Opens `url` in the system browser, then resolves once the app is back in
 * the foreground (the payer finished or left the provider's page), or after
 * 30 minutes. Resolves `false` straight away if the URL can't be opened.
 */
export async function openHostedRedirectAndWait(url: string): Promise<boolean> {
  let leftApp = false;
  let settle: () => void = () => undefined;
  const returned = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const subscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') {
      leftApp = true;
    } else if (leftApp) {
      settle();
    }
  });
  const timer = setTimeout(() => settle(), RETURN_TIMEOUT_MS);

  try {
    if (!(await openHostedRedirect(url))) {
      return false;
    }
    await returned;
    return true;
  } finally {
    clearTimeout(timer);
    subscription.remove();
  }
}
