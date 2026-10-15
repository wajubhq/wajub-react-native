/**
 * Mobile Money tables and number rules, from `src/data/mobile-money.json`,
 * the spec's data file as sync-spec.sh copies it (packages/mobile/spec/data).
 * No table is repeated here.
 */
import raw from '../data/mobile-money.json';
import { toAsciiDigits } from '../digits';

export { toAsciiDigits };

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
  /** `significant`: the leading 0 is part of the number (kept, and sent). `trunk`: it is dropped. */
  leading_zero: 'trunk' | 'significant';
  national_number_length: number | null;
  /** What every number starts with, when the plan says so ("0", "01"). */
  number_prefix: string | null;
  /** The mobile ranges a number typed without its 0 is given it back onto. */
  mobile_prefixes: string[] | null;
  /** Numbers of the earlier plan: `length` digits whose start (a key of `map`) becomes its value. */
  earlier: { length: number; map: Record<string, string> } | null;
  placeholder: string;
  placeholder_formatted: string;
  operators: string[];
  prefix_rules: PrefixRule[];
}

export interface OperatorInfo {
  name: string;
  countries: string[];
  operator_independent: boolean;
  brand: OperatorBrand | null;
}

export interface SandboxTestNumbers {
  /** The last digits of a test number, and the outcome they ask for. */
  outcome_suffixes: Record<string, string>;
  /** Per country, per operator: what a test number starts with (with its "+"). */
  prefixes: Record<string, Record<string, string[]>>;
}

export interface MobileMoneyData {
  schema_version: number;
  fallback_brand: { color: string; background: string };
  loose_length: { min: number; max: number };
  operator_independent_wallets: string[];
  sandbox_test_numbers: SandboxTestNumbers;
  countries: Record<string, CountryRules>;
  operators: Record<string, OperatorInfo>;
}

/** The data file versions this SDK reads. */
export const SUPPORTED_SCHEMA_VERSIONS = [2];

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

/** Other decimal digits read as ASCII; keep 0-9 and '+', then drop every '+'. */
export function sanitize(input: string): string {
  return toAsciiDigits(input).replace(/[^0-9+]/g, '').replace(/\+/g, '');
}

const dialDigits = (rules: CountryRules | undefined) => rules?.dial_code.replace('+', '') ?? '';

/** The digits as typed, without the country's dial code when they start with it. */
export function typedNationalDigits(input: string, country: string): string {
  const digits = sanitize(input);
  const dial = dialDigits(countryRules(country));
  return dial && digits.startsWith(dial) ? digits.slice(dial.length) : digits;
}

/** The key of `map` the digits start with, the longest when several do. */
function earlierKey(digits: string, map: Record<string, string>): string | null {
  let found: string | null = null;
  for (const key of Object.keys(map)) {
    if (digits.startsWith(key) && (!found || key.length > found.length)) found = key;
  }
  return found;
}

/**
 * The national number: the dial code left out, an earlier plan's number in
 * its current form, the leading 0 dropped where it is a trunk prefix and
 * kept — or given back onto a mobile range — where it is part of the number.
 */
export function nationalDigits(input: string, country: string): string {
  const rules = countryRules(country);
  if (!rules) return sanitize(input).replace(/^0+/, '');
  let digits = typedNationalDigits(input, country);
  if (rules.earlier && digits.length === rules.earlier.length) {
    const key = earlierKey(digits, rules.earlier.map);
    if (key) digits = `${rules.earlier.map[key]}${digits.slice(key.length)}`;
  }
  if (rules.leading_zero === 'trunk') return digits.replace(/^0+/, '');
  const withZero = `0${digits}`;
  if (
    !digits.startsWith('0') &&
    rules.national_number_length !== null &&
    withZero.length === rules.national_number_length &&
    (rules.mobile_prefixes ?? []).some((prefix) => withZero.startsWith(prefix))
  ) {
    return withZero;
  }
  return digits;
}

/**
 * A test number of a sandbox session: the prefix of one of the country's test
 * operators, then zeros and an outcome suffix. Its operator, and the number
 * as it is sent; null when the input is none.
 */
export function sandboxTestNumber(input: string, country: string): { operator: string; e164: string } | null {
  const data = mobileMoneyData();
  const byOperator = data.sandbox_test_numbers?.prefixes[country.toUpperCase()];
  if (!byOperator) return null;
  const dial = dialDigits(countryRules(country));
  const suffixes = Object.keys(data.sandbox_test_numbers.outcome_suffixes);
  const ending = new RegExp(`^0*(?:${suffixes.join('|')})$`);
  const readings = [`${dial}${nationalDigits(input, country)}`, `${dial}${typedNationalDigits(input, country)}`];
  for (const reading of readings) {
    for (const [operator, prefixes] of Object.entries(byOperator)) {
      for (const prefix of prefixes) {
        const start = prefix.replace('+', '');
        if (reading.startsWith(start) && ending.test(reading.slice(start.length))) return { operator, e164: `+${reading}` };
      }
    }
  }
  return null;
}

/** In a sandbox session, a test number is valid whatever the numbering plan says. */
export function isValidNumber(input: string, country: string, sandbox = false): boolean {
  if (sandbox && sandboxTestNumber(input, country)) return true;
  const rules = countryRules(country);
  if (rules && rules.national_number_length !== null) {
    const digits = nationalDigits(input, country);
    return digits.length === rules.national_number_length && (!rules.number_prefix || digits.startsWith(rules.number_prefix));
  }
  const { min, max } = mobileMoneyData().loose_length;
  const length = sanitize(input).length;
  return length >= min && length <= max;
}

export function isOperatorIndependent(operator: string): boolean {
  return mobileMoneyData().operator_independent_wallets.includes(operator);
}

/**
 * The operator the number's prefix names, or null; a number still being typed
 * without its leading 0 is read with it. Wallets held whatever the operator
 * are never detected. In a sandbox session, a test number names its own.
 */
export function detectOperator(input: string, country: string, sandbox = false): string | null {
  if (sandbox) {
    const test = sandboxTestNumber(input, country);
    if (test) return test.operator;
  }
  const rules = countryRules(country);
  let digits = nationalDigits(input, country);
  if (!digits || !rules) return null;
  if (rules.number_prefix && !digits.startsWith('0')) {
    const key = rules.earlier ? earlierKey(digits, rules.earlier.map) : null;
    digits = key && rules.earlier ? `${rules.earlier.map[key]}${digits.slice(key.length)}` : `0${digits}`;
  }
  for (const rule of rules.prefix_rules) {
    if (rule.starts_with.some((prefix) => digits.startsWith(prefix))) {
      return isOperatorIndependent(rule.operator) ? null : rule.operator;
    }
  }
  return null;
}

/**
 * The number as it is sent: the dial code and the national number (Côte
 * d'Ivoire, Benin, Congo keep their 0). A country outside the tables keeps an
 * international number as typed (`+260971234567`). In a sandbox session, a
 * test number goes as it was read.
 */
export function toE164(input: string, country: string, sandbox = false): string {
  if (sandbox) {
    const test = sandboxTestNumber(input, country);
    if (test) return test.e164;
  }
  const rules = countryRules(country);
  if (!rules) {
    const typed = input.trim();
    return /^(\+|00)/.test(typed) ? `+${sanitize(typed.replace(/^00/, ''))}` : sanitize(typed);
  }
  return `${rules.dial_code}${nationalDigits(input, country)}`;
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
