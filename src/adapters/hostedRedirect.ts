import { AppState, Linking } from 'react-native';

/**
 * Opens PSP URLs in the system browser — never an embedded WebView.
 *
 * An https URL is opened directly. On Android 11 and later, canOpenURL()
 * answers false unless the app declares a browser intent in a `<queries>`
 * block, so asking first left the payer on a page that never opened. Every
 * device has a browser for https; only another scheme is checked first.
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

/** Upper bound on waiting for the payer to come back from the PSP's page. */
const RETURN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Opens `url` in the system browser, then resolves once the app is back in
 * the foreground (the payer finished or left the PSP's page) — or after
 * RETURN_TIMEOUT_MS. Resolves `false` straight away if the URL can't be opened.
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
