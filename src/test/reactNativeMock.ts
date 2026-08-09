export const Linking = {
  canOpenURL: async () => true,
  openURL: async () => undefined,
};

export const Modal = 'Modal';
export const View = 'View';
export const Text = 'Text';
export const TextInput = 'TextInput';
export const Pressable = 'Pressable';
export const ScrollView = 'ScrollView';
export const ActivityIndicator = 'ActivityIndicator';
export const StyleSheet = { create: <T extends Record<string, unknown>>(styles: T) => styles };
