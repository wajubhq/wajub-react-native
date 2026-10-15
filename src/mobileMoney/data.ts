/**
 * Mobile Money tables and number rules, from `src/data/mobile-money.json` —
 * a byte-identical copy of the spec's data file (packages/mobile/spec/data),
 * shared with the web checkout and the other SDKs. No table is repeated here.
 */
import raw from '../data/mobile-money.json';

export interface OperatorBrand {
  label: string;
  mark: string | null;
  color: string;
  background: string;
}

export interface PrefixRule {
  starts_with: string[];
  operator: string;
}

export interface CountryRules {
  name: string;
  dial_code: string;
  national_number_length: number | null;
  e164_trunk_zero: 'keep' | 'drop';
  placeholder: string;
  placeholder_formatted: string;
  operators: string[];
  prefix_rules: PrefixRule[];
  /**
   * A number of the country's earlier numbering plan: `length` digits that
   * start with one of `starts_with` take `prefix` in front (Benin, 8 digits
   * before 30 November 2024: `96 12 34 56` is `01 96 12 34 56`).
   */
  earlier_number?: { length: number; prefix: string; starts_with: string[] };
}

export interface OperatorInfo {
  name: string;
  countries: string[];
  operator_independent: boolean;
  brand: OperatorBrand | null;
}

export interface MobileMoneyData {
  schema_version: number;
  fallback_brand: { color: string; background: string };
  loose_length: { min: number; max: number };
  operator_independent_wallets: string[];
  countries: Record<string, CountryRules>;
  operators: Record<string, OperatorInfo>;
}

/** The data file versions this SDK reads. */
export const SUPPORTED_SCHEMA_VERSIONS = [1];

/** Checks the shape version: an unknown one is refused rather than misread. */
export function loadMobileMoneyData(source: unknown): MobileMoneyData {
  const data = source as Partial<MobileMoneyData> | null;
  if (!data || !SUPPORTED_SCHEMA_VERSIONS.includes(data.schema_version as number)) {
    throw new Error(`Unsupported mobile-money.json schema_version: ${String(data?.schema_version)}`);
  }
  return data as MobileMoneyData;
}

let cached: MobileMoneyData | null = null;

/** The tables, parsed on first use. */
export function mobileMoneyData(): MobileMoneyData {
  if (!cached) cached = loadMobileMoneyData(raw);
  return cached;
}

export function countryRules(country: string): CountryRules | undefined {
  return mobileMoneyData().countries[country.toUpperCase()];
}

/** Keep 0-9 and '+', then drop every '+'. */
export function sanitize(input: string): string {
  return input.replace(/[^0-9+]/g, '').replace(/\+/g, '');
}

/**
 * Without the country's dial code, if the number starts with it, and without
 * leading zeros; a complete number of the country's earlier plan takes its
 * prefix in front (`96123456` → `196123456` in Benin).
 */
export function nationalDigits(input: string, country: string): string {
  let digits = sanitize(input);
  const rules = countryRules(country);
  const dial = rules?.dial_code.replace('+', '');
  if (dial && digits.startsWith(dial)) digits = digits.slice(dial.length);
  digits = digits.replace(/^0+/, '');
  const earlier = rules?.earlier_number;
  if (earlier && digits.length === earlier.length && earlier.starts_with.some((p) => digits.startsWith(p))) {
    digits = `${earlier.prefix}${digits}`;
  }
  return digits;
}

export function isValidNumber(input: string, country: string): boolean {
  const rules = countryRules(country);
  const length = rules?.national_number_length;
  if (length) {
    const digits = nationalDigits(input, country);
    return digits.length === length && (!rules.earlier_number || digits.startsWith(rules.earlier_number.prefix));
  }
  const { min, max } = mobileMoneyData().loose_length;
  const digits = sanitize(input).length;
  return digits >= min && digits <= max;
}

export function isOperatorIndependent(operator: string): boolean {
  return mobileMoneyData().operator_independent_wallets.includes(operator);
}

/** The operator the number's prefix names, or null. Wallets held whatever the operator are never detected. */
export function detectOperator(input: string, country: string): string | null {
  let digits = nationalDigits(input, country);
  if (!digits) return null;
  const rules = countryRules(country);
  // A number typed the earlier way names its operator as it is typed: `96` is read `196`.
  const earlier = rules?.earlier_number;
  if (earlier && !digits.startsWith(earlier.prefix)) digits = `${earlier.prefix}${digits}`;
  for (const rule of rules?.prefix_rules ?? []) {
    if (rule.starts_with.some((prefix) => digits.startsWith(prefix))) {
      return isOperatorIndependent(rule.operator) ? null : rule.operator;
    }
  }
  return null;
}

/**
 * Dial code + national digits; Côte d'Ivoire and Benin keep their leading 0.
 * A country outside the tables keeps an international number as typed
 * (`+260971234567`).
 */
export function toE164(input: string, country: string): string {
  const rules = countryRules(country);
  if (!rules) {
    const typed = input.trim();
    return /^(\+|00)/.test(typed) ? `+${sanitize(typed.replace(/^00/, ''))}` : sanitize(typed);
  }
  return `${rules?.dial_code ?? ''}${rules?.e164_trunk_zero === 'keep' ? '0' : ''}${nationalDigits(input, country)}`;
}

/** Digits only, at most 15, grouped by two: "671234567" → "67 12 34 56 7". */
export function formatAsYouType(input: string): string {
  return sanitize(input)
    .slice(0, 15)
    .replace(/(\d{2})(?=\d)/g, '$1 ');
}

export interface BrandBadge {
  text: string;
  color: string;
  background: string;
}

/**
 * The round badge drawn when an operator has no usable logo: its brand's
 * colours and mark, else the first 8 alphanumerics of its label.
 */
export function brandBadge(operator: string, fallbackName: string): BrandBadge {
  const data = mobileMoneyData();
  const brand = data.operators[operator]?.brand;
  const initials = (label: string) => label.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  if (!brand) {
    return { text: initials(fallbackName), color: data.fallback_brand.color, background: data.fallback_brand.background };
  }
  return { text: brand.mark ?? initials(brand.label), color: brand.color, background: brand.background };
}

/** The name the operator list shows: its brand's label, else the channel's name. */
export function operatorLabel(operator: string, fallbackName: string): string {
  return mobileMoneyData().operators[operator]?.brand?.label ?? fallbackName;
}
