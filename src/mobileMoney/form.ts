/**
 * The Mobile Money form's rules (spec README §6), as the web checkout's
 * MobileMoneyForm applies them: choices, preselection, validation order and
 * the operator hint.
 */
import { drawableLogo } from '../checkout/logo';
import type { SessionChannel } from '../types';
import { detectOperator, isOperatorIndependent, isValidNumber, operatorLabel, toE164 } from './data';

/** One line of the operator list: an operator, and the channel that pays it. */
export interface OperatorChoice {
  /** The operator ("mtn", "wave"): the key, the brand, what the number is checked against. */
  id: string;
  /** What `/pay/process` is sent as: the aggregate's slug for one of its members. */
  channel: string;
  /** Reached through an aggregate (`cm.mobile`): the operator may go with the payment as its hint. */
  viaAggregate: boolean;
  /** The channel's (or aggregate member's) name, in the sheet's language. */
  name: string;
  /** An image the sheet can draw (a PNG, or a logo that is not an SVG); `null` → the brand badge. */
  logo: string | null;
  /** What the list shows: the brand's label, else `name`. */
  label: string;
}

export function isMobileMoneyChannel(channel: SessionChannel): boolean {
  return channel.type === 'mobile_money' || channel.type === 'mobile';
}

/** The channel's name in the sheet's language: `name.fr` in French, `name` in English. */
export function channelName(channel: SessionChannel, lang: 'en' | 'fr'): string {
  return lang === 'fr' ? channel['name.fr'] || channel.name : channel.name;
}

function covers(channel: SessionChannel, country: string): boolean {
  return channel.countries.length === 0 || channel.countries.includes(country.toUpperCase());
}

/** The countries the Mobile Money channels cover, in API order. */
export function mobileMoneyCountries(channels: SessionChannel[]): string[] {
  const countries: string[] = [];
  for (const channel of channels.filter(isMobileMoneyChannel)) {
    for (const country of channel.countries) {
      if (!countries.includes(country)) countries.push(country);
    }
  }
  return countries;
}

/**
 * `mobileMoney.country`, else the payer's `geo_country` when a Mobile Money
 * channel covers it, else the first country of the first Mobile Money channel.
 */
export function defaultCountry(channels: SessionChannel[], requested?: string | null, geoCountry?: string | null): string {
  if (requested) return requested.toUpperCase();
  const momo = channels.filter(isMobileMoneyChannel);
  if (geoCountry && momo.some((c) => covers(c, geoCountry))) return geoCountry.toUpperCase();
  return momo.find((c) => c.countries.length > 0)?.countries[0] ?? geoCountry?.toUpperCase() ?? '';
}

/**
 * The operator list for `country`, in API order: an aggregate gives one
 * choice per member, any other channel one choice (`ci.wave` → `wave`).
 * A repeated operator keeps its first channel.
 */
export function operatorChoices(channels: SessionChannel[], country: string, lang: 'en' | 'fr'): OperatorChoice[] {
  const choices: OperatorChoice[] = [];
  const add = (choice: Omit<OperatorChoice, 'label'>) => {
    if (!choices.some((c) => c.id === choice.id)) {
      choices.push({ ...choice, label: operatorLabel(choice.id, choice.name) });
    }
  };
  for (const channel of channels) {
    if (!isMobileMoneyChannel(channel) || !covers(channel, country)) continue;
    if (channel.operators && channel.operators.length > 0) {
      for (const member of channel.operators) {
        add({ id: member.operator, channel: channel.slug, viaAggregate: true, name: member.name, logo: drawableLogo(member.logo, member.logo_png) });
      }
    } else {
      const parts = channel.slug.toLowerCase().split('.');
      add({
        id: parts.length >= 2 ? parts[1] : parts[0],
        channel: channel.slug,
        viaAggregate: false,
        name: channelName(channel, lang),
        logo: drawableLogo(channel.logo, channel.logo_png),
      });
    }
  }
  return choices;
}

/**
 * The choice before any number is typed: the first network operator, never a
 * wallet held whatever the operator; the first choice when every one is such
 * a wallet.
 */
export function initialChoice(choices: OperatorChoice[]): string | null {
  return (choices.find((c) => !isOperatorIndependent(c.id)) ?? choices[0])?.id ?? null;
}

/**
 * The selection after the number changed: a detected operator among the
 * choices, while the payer has not picked one by hand; otherwise unchanged.
 */
export function preselect(
  current: string | null,
  pickedByHand: boolean,
  phone: string,
  country: string,
  choices: OperatorChoice[],
  sandbox = false,
): string | null {
  if (pickedByHand) return current;
  const detected = detectOperator(phone, country, sandbox);
  return detected && choices.some((c) => c.id === detected) ? detected : current;
}

export type MobileMoneyProblem =
  | { code: 'phone_required' | 'invalid_phone' | 'operator_required' }
  | {
      code: 'operator_mismatch';
      /** Operator ids. */
      detected: string;
      selected: string;
      /** As the list shows them, for the message. */
      detectedLabel: string;
      selectedLabel: string;
    };

/**
 * What stops this number from being sent, in the web's order: empty,
 * invalid, a number of another offered operator (never for a wallet held
 * whatever the operator), no operator. `sandbox`: a sandbox session, where
 * the test numbers are valid and name their operator.
 */
export function validateMobileMoney(
  phone: string,
  country: string,
  choices: OperatorChoice[],
  selected: string | null,
  sandbox = false,
): MobileMoneyProblem | null {
  if (!phone.trim()) return { code: 'phone_required' };
  if (!isValidNumber(phone, country, sandbox)) return { code: 'invalid_phone' };
  const detected = detectOperator(phone, country, sandbox);
  const detectedChoice = choices.find((c) => c.id === detected);
  const selectedChoice = choices.find((c) => c.id === selected);
  if (detectedChoice && selectedChoice && detected !== selected && !isOperatorIndependent(selectedChoice.id)) {
    return {
      code: 'operator_mismatch',
      detected: detectedChoice.id,
      selected: selectedChoice.id,
      detectedLabel: detectedChoice.label,
      selectedLabel: selectedChoice.label,
    };
  }
  if (!selectedChoice) return { code: 'operator_required' };
  return null;
}

/**
 * `operator` goes with the payment only through an aggregate, and only when
 * the payer named it: picked by hand, or read from the number. A default the
 * payer never touched is not sent — the API would route to it instead of
 * refusing the number.
 */
export function operatorHint(choice: OperatorChoice, pickedByHand: boolean, detected: string | null): string | null {
  return choice.viaAggregate && (pickedByHand || detected === choice.id) ? choice.id : null;
}

/**
 * `data` for `/pay/process`: the number in E.164 (a sandbox session's test
 * number as it was read), the form's country, the hint when there is one.
 */
export function mobileMoneyRequestData(phone: string, country: string, operator: string | null, sandbox = false): Record<string, string> {
  const data: Record<string, string> = { phone: toE164(phone, country, sandbox), country: country.toUpperCase() };
  if (operator) data.operator = operator;
  return data;
}
