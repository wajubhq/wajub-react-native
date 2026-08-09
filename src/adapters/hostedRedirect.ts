import { Linking } from 'react-native';

/** Opens PSP URLs in the system browser — never an embedded WebView. */
export async function openHostedRedirect(url: string): Promise<boolean> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) return false;
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
