export const Linking = {
  canOpenURL: async () => true,
  openURL: async () => undefined,
};

type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();

export const AppState = {
  addEventListener: (_event: 'change', listener: AppStateListener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
  /** Test helper — simulate the OS moving the app to `state`. */
  emit: (state: string) => {
    appStateListeners.forEach((listener) => listener(state));
  },
};

export const Modal = 'Modal';
export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const Pressable = 'Pressable';
export const ScrollView = 'ScrollView';
export const ActivityIndicator = 'ActivityIndicator';
export const StyleSheet = { create: <T extends Record<string, unknown>>(styles: T) => styles };
