/**
 * Which ways to pay the sheet offers (spec README §1, §5, §7, §8): the
 * session's channels decide, sdk-config says how each one is paid.
 */
import { HOSTED_CARD_FIELDS } from '../types';
import type { HostedCardField, SdkChannelConfig, SdkConfig, SessionChannel, SessionData } from '../types';
import { channelName, isMobileMoneyChannel } from '../mobileMoney/form';
import { drawableLogo } from './logo';

/**
 * `client_session`: the PSP's hosted page (Paystack, Flutterwave, Adyen).
 * `stripe`: Stripe's card field. `hosted_redirect`: the PSP's own page, after
 * its `required_fields`. `sandbox_form`: the test card form, sandbox only.
 */
export type CardFlavor = 'client_session' | 'stripe' | 'hosted_redirect' | 'sandbox_form';

/** The amount is outside a channel's limits: shown, but not payable. */
export interface MethodLimit {
  min?: number;
  max?: number;
}

export type MethodEntry =
  | {
      kind: 'mobile_money';
      id: 'mobile_money';
      label: string;
      logo: string | null;
      /** The Mobile Money channels within their limits. */
      channels: SessionChannel[];
      slugs: string[];
      limit: MethodLimit | null;
    }
  | {
      kind: 'card';
      id: 'card';
      label: string;
      logo: string | null;
      slug: string;
      flavor: CardFlavor;
      /** Contact or billing fields to ask natively (hosted pages and client sessions). */
      fields: HostedCardField[];
      publishableKey: string | null;
      limit: MethodLimit | null;
    }
  | {
      kind: 'wallet';
      id: string;
      label: string;
      logo: string | null;
      slug: string;
      limit: MethodLimit | null;
    };

/** The sandbox test card form's fields (sdk-config-sandbox `required_fields`). */
export const SANDBOX_CARD_FIELDS = ['card.number', 'card_holder', 'expiry_month', 'expiry_year', 'cvv'] as const;

/** README §7, first match wins: client session, Stripe, hosted page, sandbox form; anything else hides card. */
export function cardFlavor(entry: SdkChannelConfig | undefined, sandbox: boolean): CardFlavor | null {
  if (!entry || !entry.available) return null;
  if (entry.client_session === true) return 'client_session';
  if (entry.sdk === 'stripe_elements') return entry.publishable_key ? 'stripe' : null;
  if (entry.sdk === 'hosted_redirect') return 'hosted_redirect';
  if (entry.sdk === 'form' && sandbox) return 'sandbox_form';
  return null;
}

/**
 * A Mobile Money channel's sdk-config entry, under the session's own slug
 * (an aggregate has one beside its members'). With `operator`, the member's
 * entry for that operator when there is one. An answer keyed by members only
 * (an aggregate without its own entry) gives a member's.
 */
export function mobileMoneyConfig(channel: SessionChannel, config: SdkConfig | null, operator?: string): SdkChannelConfig | undefined {
  if (!config) return undefined;
  const members = channel.operators ?? [];
  if (operator) {
    const picked = members.filter((o) => o.operator === operator).map((o) => config.channels[o.slug]).find((entry) => entry !== undefined);
    if (picked) return picked;
  }
  const own = config.channels[channel.slug];
  if (own) return own;
  return members.map((o) => config.channels[o.slug]).find((entry) => entry !== undefined);
}

/** Hidden by sdk-config (`available: false`). Without an entry (no sdk-config, or none for it) it is a phone form. */
function mobileMoneyHidden(channel: SessionChannel, config: SdkConfig | null): SessionChannel | null {
  if (config?.channels[channel.slug]?.available === false) return null;
  if (!channel.operators?.length) {
    return mobileMoneyConfig(channel, config)?.available === false ? null : channel;
  }
  const operators = channel.operators.filter((o) => config?.channels[o.slug]?.available !== false);
  return operators.length > 0 ? { ...channel, operators } : null;
}

/**
 * The channel's limits against what the payer would pay there (README §5.3):
 * the chosen operator's total, else the channel's, else the payment's.
 */
export function limitOf(channel: SessionChannel, transactionTotal: number, operator?: string | null): MethodLimit | null {
  const member = operator ? channel.operators?.find((o) => o.operator === operator) : undefined;
  const amount = member?.amount_total ?? channel.amount_total ?? transactionTotal;
  if (channel.min_amount !== undefined && channel.min_amount > amount) return { min: channel.min_amount };
  if (channel.max_amount !== undefined && channel.max_amount < amount) return { max: channel.max_amount };
  return null;
}

/**
 * The methods the sheet shows, in API order: one Mobile Money entry for every
 * Mobile Money channel (its operators are picked in its form), the card
 * channel when a flavour fits, each one-tap wallet. `stripeInstalled`: the
 * app has `@stripe/stripe-react-native`.
 */
export function availableMethods(session: SessionData, config: SdkConfig | null, lang: 'en' | 'fr', stripeInstalled: boolean): MethodEntry[] {
  const amount = session.transaction.amount_total ?? session.transaction.amount;
  const sandbox = session.transaction.sandbox === true;
  const methods: MethodEntry[] = [];
  let momo: Extract<MethodEntry, { kind: 'mobile_money' }> | null = null;

  for (const channel of session.channels) {
    if (isMobileMoneyChannel(channel)) {
      const shown = mobileMoneyHidden(channel, config);
      if (!shown) continue;
      if (!momo) {
        momo = { kind: 'mobile_money', id: 'mobile_money', label: 'Mobile Money', logo: drawableLogo(channel.logo, channel.logo_png), channels: [], slugs: [], limit: null };
        methods.push(momo);
      }
      momo.slugs.push(channel.slug);
      const limit = limitOf(channel, amount);
      if (!limit) momo.channels.push(shown);
      else if (!momo.limit) momo.limit = limit;
      continue;
    }
    if (channel.type === 'card') {
      const entry = config?.channels[channel.slug];
      const flavor = cardFlavor(entry, sandbox);
      if (!entry || !flavor || (flavor === 'stripe' && !stripeInstalled)) continue;
      methods.push({
        kind: 'card',
        id: 'card',
        label: channelName(channel, lang),
        logo: drawableLogo(channel.logo, channel.logo_png),
        slug: channel.slug,
        flavor,
        fields:
          flavor === 'hosted_redirect' || flavor === 'client_session'
            ? HOSTED_CARD_FIELDS.filter((f) => entry.required_fields.includes(f))
            : [],
        publishableKey: entry.publishable_key,
        limit: limitOf(channel, amount),
      });
      continue;
    }
    if (channel.type === 'wallet') {
      const entry = config?.channels[channel.slug];
      if (!entry?.available || entry.sdk !== 'form' || entry.required_fields.length > 0) continue;
      methods.push({
        kind: 'wallet',
        id: channel.slug,
        label: channelName(channel, lang),
        logo: drawableLogo(channel.logo, channel.logo_png),
        slug: channel.slug,
        limit: limitOf(channel, amount),
      });
    }
  }
  // Mobile Money is out of its limits only when every channel is.
  if (momo && momo.channels.length > 0) momo.limit = null;
  return methods;
}

/** The channel slugs a list of methods shows (`ReadyEvent.methods`). */
export function shownSlugs(methods: MethodEntry[]): string[] {
  return methods.flatMap((m) => (m.kind === 'mobile_money' ? m.slugs : [m.slug]));
}
