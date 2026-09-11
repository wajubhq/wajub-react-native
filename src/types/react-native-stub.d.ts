/**
 * Minimal stubs so `tsc --noEmit` passes in CI/unit-test jobs without a full React Native install.
 * Real apps resolve these from `react-native` at build time.
 */
declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react';

  export const Modal: ComponentType<{
    visible?: boolean;
    animationType?: string;
    transparent?: boolean;
    onRequestClose?: () => void;
    children?: ReactNode;
  }>;
  export const View: ComponentType<{ style?: unknown; children?: ReactNode }>;
  export const Text: ComponentType<{ style?: unknown; children?: ReactNode }>;
  export const TextInput: ComponentType<{
    style?: unknown;
    placeholder?: string;
    keyboardType?: string;
    autoCapitalize?: string;
    maxLength?: number;
    value?: string;
    onChangeText?: (text: string) => void;
  }>;
  export const Pressable: ComponentType<{
    style?: unknown | unknown[];
    onPress?: () => void;
    disabled?: boolean;
    hitSlop?: number;
    children?: ReactNode;
  }>;
  export const ScrollView: ComponentType<{
    horizontal?: boolean;
    showsHorizontalScrollIndicator?: boolean;
    style?: unknown;
    children?: ReactNode;
  }>;
  export const ActivityIndicator: ComponentType<{ style?: unknown }>;
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  export const AppState: {
    addEventListener(
      type: 'change',
      listener: (state: AppStateStatus) => void,
    ): { remove(): void };
  };
  export const Linking: {
    canOpenURL(url: string): Promise<boolean>;
    openURL(url: string): Promise<void>;
  };
  export const StyleSheet: {
    create<T extends Record<string, unknown>>(styles: T): T;
  };
}
