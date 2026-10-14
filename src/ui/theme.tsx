import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';

import { resolveTheme } from '../appearance/theme';
import type { ResolvedTheme } from '../appearance/theme';
import { sheetStrings } from '../i18n';
import type { SheetStrings } from '../i18n';
import type { Appearance, Branding } from '../types';

export interface SheetContext {
  theme: ResolvedTheme;
  t: SheetStrings;
  lang: 'en' | 'fr';
}

const Context = createContext<SheetContext | null>(null);

/** The sheet's theme and words; outside a sheet, the default light theme in English. */
export function useSheet(): SheetContext {
  return useContext(Context) ?? { theme: resolveTheme({}), t: sheetStrings('en'), lang: 'en' };
}

export function SheetProvider({ value, children }: { value: SheetContext; children: React.ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The OS's "reduce motion", followed live. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => alive && setReduce(value))
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return reduce;
}

/**
 * The resolved theme. `useColorScheme()` makes `auto` (and `inherit`)
 * follow the phone's appearance while the sheet is open.
 */
export function useResolvedTheme(appearance: Appearance | undefined, branding: Branding | undefined): ResolvedTheme {
  const system = useColorScheme();
  const reduceMotion = useReduceMotion();
  return useMemo(
    () => resolveTheme({ appearance, branding, systemScheme: system === 'dark' ? 'dark' : system === 'light' ? 'light' : null, reduceMotion }),
    [appearance, branding, system, reduceMotion],
  );
}
