import { contrast } from '../../appearance/color';
import { DEFAULT_PALETTES, parseAppearance, resolveScheme, resolveTheme, THEME_PRESETS } from '../../appearance/theme';
import { body } from '../../test/fakeApi';
import type { Appearance } from '../../types';
import { parseSession } from '../../wire/parse';

const branding = parseSession(body('session-cm-aggregate')).branding!;

describe('AP — appearance', () => {
  it('AP-01 parses the appearance object', () => {
    const input = {
      theme: 'stripe',
      colorScheme: 'dark',
      inherit: true,
      disableAnimations: true,
      labels: 'floating',
      shadow: 'high',
      primaryColor: '#0F766E',
      backgroundColor: 'rgb(255, 255, 255)',
      textMutedColor: 'rgba(0, 0, 0, 0.6)',
      errorColor: 'red',
      borderRadius: '0.5rem',
      fontFamily: 'Inter, sans-serif',
      variables: {
        colorPrimary: '#abc',
        colorText: '#11223344',
        colorDanger: 'oklch(0.6 0.2 25)',
        fontSizeBase: '18px',
        fontWeightBold: 'bold',
        spacingUnit: '-4px',
        borderRadius: '10',
        unknownVariable: '#000000',
      },
      rules: { '.Input': { color: 'red' } },
      somethingElse: true,
    };
    expect(parseAppearance(input)).toEqual({
      theme: 'stripe',
      colorScheme: 'dark',
      inherit: true,
      disableAnimations: true,
      labels: 'floating',
      shadow: 'high',
      primaryColor: '#0F766E',
      backgroundColor: 'rgb(255, 255, 255)',
      textMutedColor: 'rgba(0, 0, 0, 0.6)',
      borderRadius: '0.5rem',
      fontFamily: 'Inter, sans-serif',
      variables: { colorPrimary: '#abc', colorText: '#11223344', fontSizeBase: '18px', fontWeightBold: 'bold', borderRadius: '10' },
    });
    expect(parseAppearance({ theme: 'neon', colorScheme: 'sepia', shadow: 'huge' })).toEqual({});
    expect(parseAppearance(null)).toEqual({});

    const theme = resolveTheme({ appearance: input as Appearance, systemScheme: 'light' });
    expect(theme.colors.primary).toBe('#AABBCC');
    expect(theme.radius).toBe(10);
    expect(theme.fontSizeBase).toBe(18);
    expect(theme.fontWeightBold).toBe(700);
    // The host's family over the stripe preset's system stack; a system stack is the platform's font.
    expect(theme.fontFamily).toBe('Inter');
    expect(resolveTheme({ appearance: { fontFamily: "'Poppins', sans-serif" } }).fontFamily).toBe('Poppins');
    expect(resolveTheme({ appearance: { fontFamily: 'system-ui, sans-serif' } }).fontFamily).toBeUndefined();
  });

  it('AP-02 resolves token precedence', () => {
    const primary = (appearance: Appearance, b = branding) => resolveTheme({ appearance, branding: b, systemScheme: 'light' }).colors.primary;
    const all: Appearance = { theme: 'stripe', primaryColor: '#222222', variables: { colorPrimary: '#111111' } };
    expect(primary(all)).toBe('#111111');
    expect(primary({ theme: 'stripe', primaryColor: '#222222' })).toBe('#222222');
    expect(primary({ theme: 'stripe' })).toBe('#0570DE');
    expect(primary({})).toBe('#0F766E');
    expect(primary({}, {})).toBe(DEFAULT_PALETTES.light.primary);

    const radius = (appearance: Appearance, b = branding) => resolveTheme({ appearance, branding: b }).radius;
    expect(radius({ theme: 'flat', borderRadius: '6px', variables: { borderRadius: '2px' } })).toBe(2);
    expect(radius({ theme: 'flat', borderRadius: '6px' })).toBe(6);
    expect(radius({ theme: 'flat' })).toBe(0);
    expect(radius({})).toBe(12);
    expect(radius({}, {})).toBe(8);
    // Capped at half an input's height.
    expect(radius({ borderRadius: '40px' })).toBe(22);
  });

  it('AP-03 resolves the colour scheme', () => {
    // `appearance_mode: light` in the fixture.
    expect(resolveScheme({}, branding, 'dark')).toBe('light');
    expect(resolveScheme({ colorScheme: 'dark' }, branding, 'light')).toBe('dark');
    expect(resolveScheme({ theme: 'dark' }, branding, 'light')).toBe('dark');
    expect(resolveScheme({ theme: 'night' }, branding, 'light')).toBe('dark');
    expect(resolveScheme({ colorScheme: 'auto' }, branding, 'dark')).toBe('dark');
    expect(resolveScheme({ theme: 'system' }, branding, 'dark')).toBe('dark');
    // inherit: the app's scheme, over the merchant's.
    expect(resolveScheme({ inherit: true }, branding, 'dark')).toBe('dark');
    // No preference anywhere: auto, which follows the OS.
    expect(resolveScheme({}, { appearance_mode: 'system' }, 'dark')).toBe('dark');
    expect(resolveScheme({}, {}, 'light')).toBe('light');
    expect(resolveScheme({}, {}, null)).toBe('light');
  });

  it('AP-04 uses the default palettes', () => {
    const wallets = parseSession(body('session-ci-xof-wallets')).branding;
    expect(resolveTheme({ branding: wallets, systemScheme: 'light' }).colors).toEqual(SPEC_PALETTES.light);
    expect(resolveTheme({ branding: wallets, systemScheme: 'dark' }).colors).toEqual(SPEC_PALETTES.dark);
    expect(DEFAULT_PALETTES).toEqual(SPEC_PALETTES);
    const shape = resolveTheme({ branding: wallets });
    expect([shape.radius, shape.fontSizeBase, shape.fontWeightNormal, shape.fontWeightMedium, shape.fontWeightBold, shape.spacingUnit]).toEqual([8, 16, 400, 500, 600, 4]);
  });

  it('AP-05 applies merchant branding', () => {
    const light = resolveTheme({ branding, systemScheme: 'light' });
    expect(light.colors).toMatchObject({
      primary: '#0F766E',
      background: '#FFFFFF',
      surfaceMuted: '#F0FDFA',
      textSecondary: '#6B7280',
      onPrimary: '#FFFFFF',
      success: '#16A34A',
      danger: '#DC2626',
      inputBackground: '#FFFFFF',
      inputBorder: '#D1D5DB',
    });
    expect([light.radius, light.fontWeightBold, light.fontWeightNormal, light.shadow]).toEqual([12, 600, 400, 'low']);
    expect(light.whiteLabel).toBe(true);
    expect(light.logoUrl).toBe('https://cdn.shop.example.com/brand/logo.png');
    expect(light.businessName).toBe('Boutique Akwa');
    expect(light.scrimOpacity).toBe(0.4);
    expect(resolveTheme({ branding: { white_label: { enabled: true } } }).whiteLabel).toBe(true);
    expect(resolveTheme({ branding: { white_label: false } }).whiteLabel).toBe(false);

    // custom_css is ignored.
    expect(resolveTheme({ branding: { ...branding, custom_css: 'body { background: red }' }, systemScheme: 'light' })).toEqual(light);

    // A merchant primary under 3:1 against the background: the default.
    const pale = resolveTheme({ branding: { primary_color: '#FFFF66' }, systemScheme: 'light' });
    expect(contrast('#FFFF66', '#FFFFFF')).toBeLessThan(3);
    expect(pale.colors.primary).toBe(DEFAULT_PALETTES.light.primary);
    // onPrimary unset: white or near-black, whichever reads better.
    expect(resolveTheme({ branding: { primary_color: '#FACC15' }, systemScheme: 'dark' }).colors.onPrimary).toBe('#0A0A0A');

    // Surfaces designed for light stay out of a dark sheet; the merchant's primary stays.
    const dark = resolveTheme({ appearance: { colorScheme: 'dark' }, branding });
    expect(dark.colors.background).toBe(DEFAULT_PALETTES.dark.background);
    expect(dark.colors.inputBorder).toBe(DEFAULT_PALETTES.dark.inputBorder);
    expect(dark.colors.primary).toBe('#0F766E');
  });

  it('AP-06 applies presets', () => {
    expect(THEME_PRESETS).toEqual({
      stripe: { primaryColor: '#0570de', borderRadius: '4px', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", shadow: 'low' },
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
    });
    const night = resolveTheme({ appearance: { theme: 'night' }, systemScheme: 'light' });
    expect(night.scheme).toBe('dark');
    expect(night.colors).toMatchObject({ primary: '#7C3AED', background: '#0F172A', onPrimary: '#F8FAFC', inputBackground: '#1E293B', inputBorder: '#334155', textSecondary: '#94A3B8' });
    expect([night.radius, night.shadow]).toEqual([8, 'none']);
    const stripe = resolveTheme({ appearance: { theme: 'stripe' } });
    expect([stripe.colors.primary, stripe.radius, stripe.shadow, stripe.fontFamily]).toEqual(['#0570DE', 4, 'low', undefined]);
    expect(resolveTheme({ appearance: { theme: 'flat' } })).toMatchObject({ radius: 0, shadow: 'none' });
    expect(resolveTheme({ appearance: { theme: 'none' } }).colors).toEqual(DEFAULT_PALETTES.light);
  });
});

/** spec/types.ts DEFAULT_PALETTES, copied as published. */
const SPEC_PALETTES = {
  light: {
    primary: '#2563EB', primaryPressed: '#1D4ED8', onPrimary: '#FFFFFF', background: '#FFFFFF', surfaceRaised: '#FFFFFF',
    surfaceMuted: '#F5F5F5', selectedBackground: '#EFF6FF', text: '#171717', textSecondary: '#525252', textPlaceholder: '#737373',
    textDisabled: '#A3A3A3', link: '#2563EB', inputBackground: '#FFFFFF', inputBorder: '#E5E5E5', borderStrong: '#D4D4D4',
    focusRing: '#3B82F6', danger: '#B91C1C', dangerBorder: '#EF4444', dangerBackground: '#FEF2F2', success: '#15803D',
    successBackground: '#F0FDF4', warning: '#B45309', warningBackground: '#FFFBEB', disabledBackground: '#F5F5F5',
  },
  dark: {
    primary: '#3B82F6', primaryPressed: '#60A5FA', onPrimary: '#0A0A0A', background: '#0A0A0A', surfaceRaised: '#171717',
    surfaceMuted: '#262626', selectedBackground: '#172554', text: '#FAFAFA', textSecondary: '#A3A3A3', textPlaceholder: '#8A8A8A',
    textDisabled: '#525252', link: '#60A5FA', inputBackground: '#0A0A0A', inputBorder: '#404040', borderStrong: '#525252',
    focusRing: '#60A5FA', danger: '#F87171', dangerBorder: '#F87171', dangerBackground: '#450A0A', success: '#4ADE80',
    successBackground: '#052E16', warning: '#FBBF24', warningBackground: '#451A03', disabledBackground: '#262626',
  },
};
