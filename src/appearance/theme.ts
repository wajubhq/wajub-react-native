/**
 * The sheet's look (spec appearance.md): the same `Appearance` object as
 * Wajub.js, the merchant's branding under it, the web checkout's palettes
 * under that.
 */
import type {
  Appearance,
  AppearanceColorScheme,
  AppearanceThemePreset,
  AppearanceVariables,
  Branding,
  ThemeTokens,
} from '../types';
import { contrast, mix, parseColor, readableOn } from './color';

/** The web checkout's tokens (checkout.wajub src/styles/tokens.css), both schemes. */
export const DEFAULT_PALETTES: { light: ThemeTokens; dark: ThemeTokens } = {
  light: {
    primary: '#2563EB',
    primaryPressed: '#1D4ED8',
    onPrimary: '#FFFFFF',
    background: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceMuted: '#F5F5F5',
    selectedBackground: '#EFF6FF',
    text: '#171717',
    textSecondary: '#525252',
    textPlaceholder: '#737373',
    textDisabled: '#A3A3A3',
    link: '#2563EB',
    inputBackground: '#FFFFFF',
    inputBorder: '#E5E5E5',
    borderStrong: '#D4D4D4',
    focusRing: '#3B82F6',
    danger: '#B91C1C',
    dangerBorder: '#EF4444',
    dangerBackground: '#FEF2F2',
    success: '#15803D',
    successBackground: '#F0FDF4',
    warning: '#B45309',
    warningBackground: '#FFFBEB',
    disabledBackground: '#F5F5F5',
  },
  dark: {
    primary: '#3B82F6',
    primaryPressed: '#60A5FA',
    onPrimary: '#0A0A0A',
    background: '#0A0A0A',
    surfaceRaised: '#171717',
    surfaceMuted: '#262626',
    selectedBackground: '#172554',
    text: '#FAFAFA',
    textSecondary: '#A3A3A3',
    textPlaceholder: '#8A8A8A',
    textDisabled: '#525252',
    link: '#60A5FA',
    inputBackground: '#0A0A0A',
    inputBorder: '#404040',
    borderStrong: '#525252',
    focusRing: '#60A5FA',
    danger: '#F87171',
    dangerBorder: '#F87171',
    dangerBackground: '#450A0A',
    success: '#4ADE80',
    successBackground: '#052E16',
    warning: '#FBBF24',
    warningBackground: '#451A03',
    disabledBackground: '#262626',
  },
};

/** Wajub.js's presets (appearance.js), identical values. */
export const THEME_PRESETS: Record<AppearanceThemePreset, Partial<Appearance>> = {
  stripe: {
    primaryColor: '#0570de',
    borderRadius: '4px',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    shadow: 'low',
  },
  night: {
    colorScheme: 'dark',
    primaryColor: '#7c3aed',
    backgroundColor: '#0f172a',
    buttonTextColor: '#f8fafc',
    inputBackgroundColor: '#1e293b',
    inputBorderColor: '#334155',
    textMutedColor: '#94a3b8',
    borderRadius: '8px',
    shadow: 'none',
  },
  flat: { shadow: 'none', borderRadius: '0' },
  none: {},
};

export const DEFAULT_SHAPE = {
  radius: 8,
  inputHeight: 44,
  maxRadius: 22,
  fontSizeBase: 16,
  fontWeightNormal: 400,
  fontWeightMedium: 500,
  fontWeightBold: 600,
  spacingUnit: 4,
  disabledOpacity: 0.5,
  animationMs: 250,
} as const;

const COLOR_KEYS = [
  'primaryColor',
  'secondaryColor',
  'backgroundColor',
  'buttonTextColor',
  'inputBackgroundColor',
  'inputBorderColor',
  'textMutedColor',
  'successColor',
  'errorColor',
] as const;
const VARIABLE_COLORS = [
  'colorPrimary',
  'colorBackground',
  'colorText',
  'colorTextSecondary',
  'colorTextPlaceholder',
  'colorDanger',
  'colorSuccess',
] as const;
const VARIABLE_VALUES = [
  'fontFamily',
  'fontSizeBase',
  'fontWeightNormal',
  'fontWeightMedium',
  'fontWeightBold',
  'spacingUnit',
  'borderRadius',
  'spacingGridRow',
  'spacingGridColumn',
] as const;
const PRESETS = ['stripe', 'night', 'flat', 'none'];
const SCHEMES = ['light', 'dark', 'auto', 'system'];

/** "8px", "8", "0.5rem" (× 16): dp. Negative or non-finite: undefined. */
export function parseLength(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^\s*(\d*\.?\d+)\s*(px|rem)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'rem' ? 16 : 1);
  return Number.isFinite(n) ? n : undefined;
}

/** "400"…"700", "normal", "bold", or a number. */
export function parseFontWeight(value: unknown): number | undefined {
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : undefined;
}

/** Names that mean "the platform's own font": a family the app cannot ship by that name. */
const PLATFORM_FAMILIES = new Set([
  '-apple-system',
  'blinkmacsystemfont',
  'system-ui',
  'ui-sans-serif',
  'sans-serif',
  'serif',
  'monospace',
  'segoe ui',
  'roboto',
  'helvetica neue',
  'helvetica',
  'arial',
]);

/**
 * The first family of a CSS stack; undefined (the platform's font) when that
 * family is the platform's own or a generic one.
 */
export function parseFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const first = value.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
  if (!first || PLATFORM_FAMILIES.has(first.toLowerCase())) return undefined;
  return first;
}

/**
 * Keeps the keys Wajub.js knows with values that parse; drops everything
 * else (`rules`, named colours, negative lengths…) without an error.
 */
export function parseAppearance(input: unknown): Appearance {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: Appearance = {};
  if (typeof source.theme === 'string' && [...PRESETS, ...SCHEMES].includes(source.theme)) {
    out.theme = source.theme as Appearance['theme'];
  }
  if (source.colorScheme === 'light' || source.colorScheme === 'dark' || source.colorScheme === 'auto') {
    out.colorScheme = source.colorScheme;
  }
  if (typeof source.inherit === 'boolean') out.inherit = source.inherit;
  if (typeof source.disableAnimations === 'boolean') out.disableAnimations = source.disableAnimations;
  if (source.shadow === 'none' || source.shadow === 'low' || source.shadow === 'high') out.shadow = source.shadow;
  if (source.labels === 'above' || source.labels === 'floating') out.labels = source.labels;
  for (const key of COLOR_KEYS) {
    if (parseColor(source[key])) out[key] = source[key] as string;
  }
  if (parseLength(source.borderRadius) !== undefined) out.borderRadius = String(source.borderRadius);
  if (typeof source.fontFamily === 'string' && source.fontFamily.trim()) out.fontFamily = source.fontFamily;

  const variables = source.variables && typeof source.variables === 'object' ? (source.variables as Record<string, unknown>) : null;
  if (variables) {
    const parsed: AppearanceVariables = {};
    for (const key of VARIABLE_COLORS) {
      if (parseColor(variables[key])) parsed[key] = variables[key] as string;
    }
    for (const key of VARIABLE_VALUES) {
      const value = variables[key];
      const ok =
        key === 'fontFamily'
          ? typeof value === 'string' && value.trim() !== ''
          : key.startsWith('fontWeight')
            ? parseFontWeight(value) !== undefined
            : parseLength(value) !== undefined;
      if (ok) parsed[key] = String(value);
    }
    if (Object.keys(parsed).length > 0) out.variables = parsed;
  }
  return out;
}

export type Scheme = 'light' | 'dark';

/** The appearance's own scheme request: `colorScheme`, else `theme`'s, else its preset's. */
function requestedScheme(appearance: Appearance): AppearanceColorScheme | undefined {
  if (appearance.colorScheme) return appearance.colorScheme;
  const theme = appearance.theme;
  if (theme === 'light' || theme === 'dark' || theme === 'auto') return theme;
  if (theme === 'system') return 'auto';
  return theme ? (THEME_PRESETS[theme].colorScheme as AppearanceColorScheme | undefined) : undefined;
}

/**
 * `colorScheme`/`theme` > the app's scheme (`inherit`) > the merchant's
 * `appearance_mode` > auto, which follows the OS (and changes with it).
 */
export function resolveScheme(appearance: Appearance, branding: Branding | null | undefined, systemScheme: Scheme | null | undefined): Scheme {
  const system: Scheme = systemScheme === 'dark' ? 'dark' : 'light';
  const requested = requestedScheme(appearance);
  if (requested === 'light' || requested === 'dark') return requested;
  if (requested === 'auto') return system;
  if (appearance.inherit) return system;
  const mode = branding?.appearance_mode;
  if (mode === 'light' || mode === 'dark') return mode;
  return system;
}

export interface ResolvedTheme {
  scheme: Scheme;
  colors: ThemeTokens;
  radius: number;
  /** undefined: the platform's font. */
  fontFamily?: string;
  fontSizeBase: number;
  fontSizeLabel: number;
  fontSizeHint: number;
  fontWeightNormal: number;
  fontWeightMedium: number;
  fontWeightBold: number;
  spacingUnit: number;
  gapRow: number;
  gapColumn: number;
  shadow: 'none' | 'low' | 'high';
  labels: 'above' | 'floating';
  disableAnimations: boolean;
  /** `branding.white_label`: no "Secured by Wajub". */
  whiteLabel: boolean;
  logoUrl: string | null;
  businessName: string | null;
  /** Scrim behind the sheet, 0–1. */
  scrimOpacity: number;
}

type Layer = Partial<ThemeTokens> & {
  radius?: number;
  fontFamily?: string | null;
  fontSizeBase?: number;
  fontWeightNormal?: number;
  fontWeightMedium?: number;
  fontWeightBold?: number;
  spacingUnit?: number;
  gapRow?: number;
  gapColumn?: number;
  shadow?: 'none' | 'low' | 'high';
};

/** The tokens one level of the appearance object (variables, or top-level keys) sets. */
function appearanceLayer(a: Partial<Appearance>): Layer {
  return {
    primary: parseColor(a.primaryColor),
    surfaceMuted: parseColor(a.secondaryColor),
    background: parseColor(a.backgroundColor),
    onPrimary: parseColor(a.buttonTextColor),
    inputBackground: parseColor(a.inputBackgroundColor),
    inputBorder: parseColor(a.inputBorderColor),
    textSecondary: parseColor(a.textMutedColor),
    success: parseColor(a.successColor),
    danger: parseColor(a.errorColor),
    radius: parseLength(a.borderRadius),
    fontFamily: a.fontFamily !== undefined ? (parseFontFamily(a.fontFamily) ?? null) : undefined,
    shadow: a.shadow,
  };
}

function variablesLayer(v: AppearanceVariables): Layer {
  return {
    primary: parseColor(v.colorPrimary),
    background: parseColor(v.colorBackground),
    text: parseColor(v.colorText),
    textSecondary: parseColor(v.colorTextSecondary),
    textPlaceholder: parseColor(v.colorTextPlaceholder),
    danger: parseColor(v.colorDanger),
    success: parseColor(v.colorSuccess),
    fontFamily: v.fontFamily !== undefined ? (parseFontFamily(v.fontFamily) ?? null) : undefined,
    fontSizeBase: parseLength(v.fontSizeBase),
    fontWeightNormal: parseFontWeight(v.fontWeightNormal),
    fontWeightMedium: parseFontWeight(v.fontWeightMedium),
    fontWeightBold: parseFontWeight(v.fontWeightBold),
    spacingUnit: parseLength(v.spacingUnit),
    radius: parseLength(v.borderRadius),
    gapRow: parseLength(v.spacingGridRow),
    gapColumn: parseLength(v.spacingGridColumn),
  };
}

const RADIUS_TOKENS: Record<string, number> = { none: 0, sm: 4, md: 8, lg: 12, xl: 16 };

/**
 * The merchant's branding. Surfaces, muted text and inputs only in the scheme
 * the merchant designed them for (light, unless `appearance_mode` is dark).
 */
function brandingLayer(b: Branding, scheme: Scheme): Layer {
  const designedFor: Scheme = b.appearance_mode === 'dark' ? 'dark' : 'light';
  const surfaces = scheme === designedFor;
  const radius = typeof b.border_radius === 'string' ? (RADIUS_TOKENS[b.border_radius] ?? parseLength(b.border_radius)) : undefined;
  const shadow = b.shadow === 'none' || b.shadow === 'low' || b.shadow === 'high' ? b.shadow : undefined;
  return {
    primary: parseColor(b.primary_color),
    onPrimary: parseColor(b.button_text_color),
    success: parseColor(b.success_color),
    danger: parseColor(b.error_color),
    background: surfaces ? parseColor(b.background_color) : undefined,
    surfaceMuted: surfaces ? parseColor(b.secondary_color) : undefined,
    textSecondary: surfaces ? parseColor(b.text_muted_color) : undefined,
    inputBackground: surfaces ? parseColor(b.input_background_color) : undefined,
    inputBorder: surfaces ? parseColor(b.input_border_color) : undefined,
    radius,
    fontWeightBold: parseFontWeight(b.font_weight_heading),
    fontWeightNormal: parseFontWeight(b.font_weight_body),
    spacingUnit: b.density === 'compact' ? 3 : undefined,
    shadow,
  };
}

function first<K extends keyof Layer>(layers: Layer[], key: K): Layer[K] | undefined {
  for (const layer of layers) {
    if (layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

function isWhiteLabel(value: Branding['white_label']): boolean {
  if (value && typeof value === 'object') return value.enabled === true;
  return value === true;
}

/**
 * Every token, first found in: `variables` > top-level keys > the `theme`
 * preset > the merchant's branding > the default palette of the scheme.
 * (React Native's `inherit` gives the scheme only.)
 */
export function resolveTheme(input: {
  appearance?: Appearance | null;
  branding?: Branding | null;
  systemScheme?: Scheme | null;
  /** The OS asked for reduced motion. */
  reduceMotion?: boolean;
}): ResolvedTheme {
  const appearance = parseAppearance(input.appearance);
  const branding = input.branding ?? {};
  const scheme = resolveScheme(appearance, branding, input.systemScheme);
  const defaults = DEFAULT_PALETTES[scheme];
  const preset = appearance.theme && appearance.theme in THEME_PRESETS ? THEME_PRESETS[appearance.theme as AppearanceThemePreset] : {};

  const host = [variablesLayer(appearance.variables ?? {}), appearanceLayer(appearance), appearanceLayer(preset)];
  const merchant = brandingLayer(branding, scheme);
  const layers = [...host, merchant];

  const colors: ThemeTokens = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ThemeTokens)[]) {
    const value = first(layers, key);
    if (typeof value === 'string') colors[key] = value;
  }
  // The sheet's surface is the inputs' too, unless the host set them apart.
  const hostBackground = first(host, 'background');
  if (hostBackground && !first(host, 'inputBackground')) colors.inputBackground = hostBackground;
  // A merchant colour the payer cannot read against the background falls back.
  if (!first(host, 'primary') && merchant.primary && contrast(merchant.primary, colors.background) < 3) {
    colors.primary = defaults.primary;
  }
  if (!first(layers, 'onPrimary')) colors.onPrimary = readableOn(colors.primary);
  if (colors.primary !== defaults.primary) {
    colors.primaryPressed = mix(colors.primary, scheme === 'light' ? '#000000' : '#FFFFFF', 0.15);
    colors.link = colors.primary;
    colors.focusRing = colors.primary;
    colors.selectedBackground = mix(colors.background, colors.primary, 0.12);
  }
  if (colors.background !== defaults.background) {
    const lift = scheme === 'light' ? '#000000' : '#FFFFFF';
    colors.surfaceRaised = scheme === 'light' ? colors.background : mix(colors.background, lift, 0.05);
    if (!first(layers, 'surfaceMuted')) colors.surfaceMuted = mix(colors.background, lift, scheme === 'light' ? 0.04 : 0.1);
    colors.disabledBackground = colors.surfaceMuted;
  }

  const fontSizeBase = Math.max(16, first(layers, 'fontSizeBase') ?? DEFAULT_SHAPE.fontSizeBase);
  const spacingUnit = first(layers, 'spacingUnit') ?? DEFAULT_SHAPE.spacingUnit;
  const logo = [branding.logo_url, branding.logo_square_url, branding.icon_url].find(
    (url): url is string => typeof url === 'string' && /^https:\/\//i.test(url),
  );
  const overlay = typeof branding.overlay_intensity === 'number' ? branding.overlay_intensity : null;
  return {
    scheme,
    colors,
    radius: Math.min(DEFAULT_SHAPE.maxRadius, first(layers, 'radius') ?? DEFAULT_SHAPE.radius),
    fontFamily: first(host, 'fontFamily') ?? undefined,
    fontSizeBase,
    fontSizeLabel: fontSizeBase * 0.875,
    fontSizeHint: fontSizeBase * 0.8125,
    fontWeightNormal: first(layers, 'fontWeightNormal') ?? DEFAULT_SHAPE.fontWeightNormal,
    fontWeightMedium: first(layers, 'fontWeightMedium') ?? DEFAULT_SHAPE.fontWeightMedium,
    fontWeightBold: first(layers, 'fontWeightBold') ?? DEFAULT_SHAPE.fontWeightBold,
    spacingUnit,
    gapRow: first(layers, 'gapRow') ?? spacingUnit * 4,
    gapColumn: first(layers, 'gapColumn') ?? spacingUnit * 3,
    shadow: first(layers, 'shadow') ?? 'low',
    labels: appearance.labels ?? 'above',
    disableAnimations: appearance.disableAnimations === true || input.reduceMotion === true,
    whiteLabel: isWhiteLabel(branding.white_label),
    logoUrl: logo ?? null,
    businessName: typeof branding.business_name === 'string' && branding.business_name ? branding.business_name : null,
    scrimOpacity: overlay !== null && overlay >= 0 && overlay <= 100 ? overlay / 100 : 0.4,
  };
}
