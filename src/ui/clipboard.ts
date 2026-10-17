import * as ReactNative from 'react-native';

interface ClipboardModule {
  setString(text: string): void;
}

/** `@react-native-clipboard/clipboard`, when the app has it (an optional peer). */
let community: ClipboardModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('@react-native-clipboard/clipboard') as { default?: ClipboardModule } & Partial<ClipboardModule>;
  community = loaded.default ?? (typeof loaded.setString === 'function' ? (loaded as ClipboardModule) : null);
} catch {
  community = null;
}

/** React Native's own clipboard, read once: React Native notes once that it moved out of core. */
let builtIn: ClipboardModule | null | undefined;

function clipboard(): ClipboardModule | null {
  if (community) return community;
  if (builtIn === undefined) {
    try {
      builtIn = (ReactNative as { Clipboard?: ClipboardModule }).Clipboard ?? null;
    } catch {
      builtIn = null;
    }
  }
  return builtIn;
}

/** Puts `text` on the clipboard; false when the app has no clipboard to write to. */
export function copyText(text: string): boolean {
  try {
    const target = clipboard();
    if (!target) return false;
    target.setString(text);
    return true;
  } catch {
    return false;
  }
}
