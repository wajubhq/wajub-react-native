/**
 * `react-native` for the unit tests (node, no native runtime). The UI tests
 * use the real package with its jest preset.
 */
export const Linking = {
  canOpenURL: async () => true,
  openURL: async () => undefined,
};

type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();

export const AppState = {
  currentState: 'active',
  addEventListener: (_event: 'change', listener: AppStateListener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
  /** Test helper — simulate the OS moving the app to `state`. */
  emit: (state: string) => {
    appStateListeners.forEach((listener) => listener(state));
  },
};

export const Platform = {
  OS: 'android',
  Version: 35,
  constants: { Release: '15' },
};

export const Dimensions = {
  get: () => ({ width: 360, height: 800, scale: 3, fontScale: 1 }),
};

export const PixelRatio = {
  get: () => 3,
};

export const NativeModules: Record<string, unknown> = {};

export const I18nManager = {
  getConstants: () => ({ isRTL: false, localeIdentifier: 'fr_CM' }),
};

export const Modal = 'Modal';
export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const Pressable = 'Pressable';
export const ScrollView = 'ScrollView';
export const ActivityIndicator = 'ActivityIndicator';
export const StyleSheet = { create: <T extends Record<string, unknown>>(styles: T) => styles };
