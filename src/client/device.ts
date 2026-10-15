import { Dimensions, I18nManager, NativeModules, PixelRatio, Platform } from 'react-native';

import { sha256Hex, uuidV4 } from '../crypto';
import type { WajubStorage } from '../types';
import { SDK_VERSION } from '../version';

/** `data._client` on POST /pay/process (spec README §2.3). */
export interface ClientSignals {
  timezone: string;
  language: string;
  screen: string;
  color_depth: number;
  /** Lower-case hex, stable for one install. */
  fingerprint: string;
  /** The X-Wajub-Client value. */
  client: string;
}

/** The OS release: "18.1" on iOS, "15" on Android. */
function osVersion(): string {
  if (Platform.OS === 'android') {
    const release = (Platform.constants as { Release?: string } | undefined)?.Release;
    return release ?? String(Platform.Version);
  }
  return String(Platform.Version);
}

/** `wajub-react-native/1.5.0 (ios 18.1)`: X-Wajub-Client and `_client.client`. */
export function clientHeader(): string {
  return `wajub-react-native/${SDK_VERSION} (${Platform.OS} ${osVersion()})`;
}

/** The device's languages, BCP 47 with region, most preferred first. */
export function deviceLocales(): string[] {
  const found: string[] = [];
  const settings = (NativeModules.SettingsManager as { settings?: { AppleLanguages?: string[]; AppleLocale?: string } } | undefined)
    ?.settings;
  if (Platform.OS === 'ios' && settings) {
    found.push(...(settings.AppleLanguages ?? []), ...(settings.AppleLocale ? [settings.AppleLocale] : []));
  }
  const android = (I18nManager as { getConstants?: () => { localeIdentifier?: string } }).getConstants?.().localeIdentifier;
  if (android) found.push(android);
  try {
    found.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    /* no Intl */
  }
  const locales = found
    .filter((l): l is string => typeof l === 'string' && l.length > 0)
    .map((l) => l.replace(/_/g, '-').replace(/@.*$/, ''));
  return locales.length > 0 ? [...new Set(locales)] : ['en'];
}

/** `fr-CM, fr;q=0.9, en;q=0.8`: each locale, then its language, in preference order. */
export function acceptLanguage(locales: string[] = deviceLocales()): string {
  const tags: string[] = [];
  for (const locale of locales) {
    for (const tag of [locale, locale.split('-')[0]]) {
      if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
  }
  return tags.map((tag, i) => (i === 0 ? tag : `${tag};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}`)).join(', ');
}

const INSTALL_ID_KEY = '@wajub/install-id';

/**
 * `@react-native-async-storage/async-storage` (a peer dependency), required
 * inside try/catch: a missing or unlinked native module never crashes the
 * payment. Without it the install id lives as long as the JS runtime.
 */
function asyncStorage(): WajubStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('@react-native-async-storage/async-storage') as { default?: WajubStorage } & WajubStorage;
    const store = module.default ?? module;
    if (typeof store.getItem === 'function') return store;
  } catch {
    /* not installed */
  }
  if ((globalThis as { __DEV__?: boolean }).__DEV__) {
    console.warn(
      '[wajub] Install @react-native-async-storage/async-storage: without it the device fingerprint changes at every launch, which Wajub reads as a new device.',
    );
  }
  return null;
}

let defaultFingerprint: Promise<string> | null = null;
const hostFingerprints = new WeakMap<WajubStorage, Promise<string>>();

/**
 * Hex SHA-256 of "device:" + a UUID v4 generated once and kept in the app's
 * storage — never a hardware or advertising id. A new fingerprint for a known
 * phone number reads as a SIM swap to Wajub's risk engine: it survives app
 * updates and restarts. `storage`: the host's own; else AsyncStorage.
 */
export function installFingerprint(storage?: WajubStorage): Promise<string> {
  if (storage) {
    let promise = hostFingerprints.get(storage);
    if (!promise) {
      promise = readFingerprint(storage);
      hostFingerprints.set(storage, promise);
    }
    return promise;
  }
  if (!defaultFingerprint) defaultFingerprint = readFingerprint(asyncStorage());
  return defaultFingerprint;
}

async function readFingerprint(store: WajubStorage | null): Promise<string> {
  let id: string | null;
  try {
    id = (await store?.getItem(INSTALL_ID_KEY)) ?? null;
  } catch {
    // The stored id could not be read: one for this run only, never written over the stored one.
    return sha256Hex(`device:${uuidV4()}`);
  }
  if (!id) {
    id = uuidV4();
    try {
      await store?.setItem(INSTALL_ID_KEY, id);
    } catch {
      /* kept in memory for this run */
    }
  }
  return sha256Hex(`device:${id}`);
}

/** The device signals sent as `data._client` with every payment attempt. */
export async function clientSignals(storage?: WajubStorage): Promise<ClientSignals> {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
  } catch {
    /* no Intl */
  }
  const { width, height } = Dimensions.get('screen');
  const scale = PixelRatio.get();
  const sides = [Math.round(width * scale), Math.round(height * scale)].sort((a, b) => a - b);
  return {
    timezone,
    language: deviceLocales()[0],
    screen: `${sides[0]}x${sides[1]}`,
    color_depth: 24,
    fingerprint: await installFingerprint(storage),
    client: clientHeader(),
  };
}
