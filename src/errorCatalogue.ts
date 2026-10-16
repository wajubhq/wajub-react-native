import type { WajubErrorType } from './types';

/** The sheet's two languages. */
export type Lang = 'en' | 'fr';

/** `fr`, `fr-CM`, `FR_ci` read French; anything else English. */
export function langOf(locale: string | null | undefined): Lang {
  return (locale ?? '').trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

interface Entry {
  type: WajubErrorType;
  retryable: boolean;
  en: string;
  fr: string;
}

const LOAD_FAILED = {
  en: "We couldn't load the payment. Check your connection and try again.",
  fr: 'Impossible de charger le paiement. Vérifiez votre connexion et réessayez.',
};
const STEP_EXPIRED = { en: 'This verification has expired.', fr: 'Cette vérification a expiré.' };

function form(en: string, fr: string): Entry {
  return { type: 'invalid_request_error', retryable: true, en, fr };
}

/** errors.md §3: every code the SDK raises or recognises, with its type, retryability and texts. */
export const ERROR_CATALOGUE: Record<string, Entry> = {
  // 3.1 Load
  session_not_found: {
    type: 'authentication_error',
    retryable: false,
    en: "We couldn't find this payment session. Check the link you received or ask the merchant for a new one.",
    fr: "Nous n'avons pas pu retrouver cette session de paiement. Vérifiez le lien reçu ou demandez-en un nouveau au marchand.",
  },
  session_terminal_expired: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'This payment session has expired.',
    fr: 'Cette session de paiement a expiré.',
  },
  session_terminal_cancelled: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'This payment was cancelled.',
    fr: 'Ce paiement a été annulé.',
  },
  session_terminal_failed: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'This payment has ended without being paid. Ask the merchant for a new payment link.',
    fr: "Ce paiement s'est terminé sans être réglé. Demandez un nouveau lien de paiement au marchand.",
  },
  load_error: { type: 'api_error', retryable: true, ...LOAD_FAILED },
  ready_timeout: { type: 'api_error', retryable: true, ...LOAD_FAILED },
  no_payment_method: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'No payment method is available for this payment.',
    fr: "Aucun moyen de paiement n'est disponible pour ce paiement.",
  },
  // 3.2 Transport
  network_error: {
    type: 'api_error',
    retryable: true,
    en: 'Connection error. Check your network.',
    fr: 'Erreur de connexion. Vérifiez votre réseau.',
  },
  timeout: { type: 'api_error', retryable: true, en: 'The request timed out.', fr: "Le délai d'attente a été dépassé." },
  server_error: {
    type: 'api_error',
    retryable: true,
    en: 'Service temporarily unavailable.',
    fr: 'Service temporairement indisponible.',
  },
  rate_limited: {
    type: 'rate_limit_error',
    retryable: true,
    en: 'Too many attempts. Please wait {seconds} s before trying again.',
    fr: 'Trop de tentatives. Merci de patienter {seconds} s avant de réessayer.',
  },
  request_failed: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'An error occurred. Please try again.',
    fr: 'Une erreur est survenue. Veuillez réessayer.',
  },
  // 3.3 Form
  phone_required: form('Enter the Mobile Money number to pay with.', 'Saisissez le numéro Mobile Money qui va payer.'),
  invalid_phone: form('Invalid phone number', 'Numéro de téléphone invalide'),
  operator_mismatch: form(
    'This number belongs to {detected}. Pick {detected} in the list, or enter a {selected} number.',
    'Ce numéro est un numéro {detected}. Choisissez {detected} dans la liste, ou saisissez un numéro {selected}.',
  ),
  operator_required: form('Choose your Mobile Money operator.', 'Choisissez votre opérateur Mobile Money.'),
  operator_unavailable: form(
    'No Mobile Money operator is available for this country. Try another payment method.',
    "Aucun opérateur Mobile Money n'est disponible pour ce pays. Essayez un autre moyen de paiement.",
  ),
  field_required: form('This field is required', 'Ce champ est requis'),
  invalid_email: form('Enter a valid email address.', 'Saisissez une adresse e-mail valide.'),
  validation_error: form('Check the information entered.', 'Vérifiez les informations saisies.'),
  // 3.4 Payment
  payment_declined: {
    type: 'payment_error',
    retryable: true,
    en: 'Payment declined by the issuer.',
    fr: "Paiement refusé par l'émetteur.",
  },
  insufficient_funds: { type: 'payment_error', retryable: true, en: 'Insufficient funds.', fr: 'Fonds insuffisants.' },
  merchant_not_verified: {
    type: 'payment_error',
    retryable: false,
    en: "This merchant can't accept payments yet. Please contact them.",
    fr: 'Ce marchand ne peut pas encore accepter de paiements. Veuillez le contacter.',
  },
  limit_exceeded: {
    type: 'payment_error',
    retryable: true,
    en: "This payment exceeds this merchant's allowed limit. Try a smaller amount or contact the merchant.",
    fr: 'Ce paiement dépasse la limite autorisée pour ce marchand. Essayez un montant plus faible ou contactez le marchand.',
  },
  shield_blocked: {
    type: 'payment_error',
    retryable: false,
    en: 'Payment blocked for security. Reference: {block_reference}.',
    fr: 'Paiement bloqué pour sécurité. Référence : {block_reference}.',
  },
  merchant_restricted: {
    type: 'payment_error',
    retryable: false,
    en: 'Payments are currently restricted for this merchant.',
    fr: 'Les paiements sont actuellement restreints pour ce marchand.',
  },
  payment_method_restricted: {
    type: 'payment_error',
    retryable: true,
    en: 'This payment method is not available for this merchant.',
    fr: "Ce moyen de paiement n'est pas disponible pour ce marchand.",
  },
  country_restricted: {
    type: 'payment_error',
    retryable: false,
    en: 'This merchant does not accept payments from your country.',
    fr: "Ce marchand n'accepte pas les paiements depuis votre pays.",
  },
  currency_restricted: {
    type: 'payment_error',
    retryable: false,
    en: 'This merchant does not accept payments in this currency.',
    fr: "Ce marchand n'accepte pas les paiements dans cette devise.",
  },
  channel_not_accepted: {
    type: 'payment_error',
    retryable: true,
    en: 'This payment method is not available for this payment.',
    fr: "Ce moyen de paiement n'est pas disponible pour ce paiement.",
  },
  payment_failed: {
    type: 'payment_error',
    retryable: false,
    en: 'Your payment could not be processed.',
    fr: "Votre paiement n'a pas pu être traité.",
  },
  payment_attempt_ended: {
    type: 'payment_error',
    retryable: true,
    en: 'Your payment was not completed, and nothing was charged. Choose a payment method to try again.',
    fr: "Votre paiement n'a pas abouti et rien n'a été débité. Choisissez un moyen de paiement pour réessayer.",
  },
  payment_cancelled: {
    type: 'payment_error',
    retryable: false,
    en: 'This payment was cancelled.',
    fr: 'Ce paiement a été annulé.',
  },
  session_expired: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'This payment has expired.',
    fr: 'Ce paiement a expiré.',
  },
  not_processable: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'This payment can no longer be processed.',
    fr: 'Ce paiement ne peut plus être traité.',
  },
  payment_partly_paid: {
    type: 'invalid_request_error',
    retryable: false,
    en: "Part of this payment has already been paid, so it can't be cancelled.",
    fr: 'Une partie de ce paiement a déjà été réglée : il ne peut plus être annulé.',
  },
  /** `payment_in_progress` answering a cancel (its code stays `payment_in_progress`). */
  payment_in_progress_on_cancel: {
    type: 'invalid_request_error',
    retryable: false,
    en: "This payment is being paid and can't be cancelled now.",
    fr: 'Ce paiement est en cours de règlement et ne peut pas être annulé maintenant.',
  },
  order_not_validated: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'The merchant has not confirmed this order yet. Try again in a moment.',
    fr: "Le marchand n'a pas encore confirmé cette commande. Réessayez dans un instant.",
  },
  raw_card_data_not_accepted: {
    type: 'invalid_request_error',
    retryable: false,
    en: "This payment method can't be used here.",
    fr: 'Ce moyen de paiement ne peut pas être utilisé ici.',
  },
  security_check_failed: {
    type: 'invalid_request_error',
    retryable: true,
    en: 'The security check failed. Try again in a moment.',
    fr: 'La vérification de sécurité a échoué. Réessayez dans un instant.',
  },
  unsupported_action: {
    type: 'api_error',
    retryable: false,
    en: "This payment step isn't supported in the app. Try another payment method.",
    fr: "Cette étape de paiement n'est pas prise en charge dans l'application. Essayez un autre moyen de paiement.",
  },
  redirect_unavailable: {
    type: 'api_error',
    retryable: true,
    en: "We couldn't open the payment page. Check that a web browser is enabled, then try again.",
    fr: "Impossible d'ouvrir la page de paiement. Vérifiez qu'un navigateur est activé, puis réessayez.",
  },
  // 3.5 Confirmation steps
  invalid_otp: form('Incorrect code. {n} attempts left.', 'Code incorrect. Encore {n} essais.'),
  otp_expired: form('The code has expired.', 'Le code a expiré.'),
  invalid_pin: form('Incorrect PIN. {n} attempts left.', 'Code PIN incorrect. Encore {n} essais.'),
  pin_expired: form(STEP_EXPIRED.en, STEP_EXPIRED.fr),
  phone_expired: form(STEP_EXPIRED.en, STEP_EXPIRED.fr),
  invalid_birthday: form(
    'This date of birth was not accepted. {n} attempts left.',
    "Cette date de naissance n'a pas été acceptée. Encore {n} essais.",
  ),
  birthday_expired: form(STEP_EXPIRED.en, STEP_EXPIRED.fr),
  invalid_address: form(
    'This address was not accepted. {n} attempts left.',
    "Cette adresse n'a pas été acceptée. Encore {n} essais.",
  ),
  address_expired: form(STEP_EXPIRED.en, STEP_EXPIRED.fr),
  otp_attempts_exceeded: {
    type: 'payment_error',
    retryable: true,
    en: 'Your operator refused too many codes for this payment. Choose another payment method.',
    fr: 'Votre opérateur a refusé trop de codes pour ce paiement. Choisissez un autre moyen de paiement.',
  },
  max_attempts_exceeded: {
    type: 'payment_error',
    retryable: true,
    en: 'Too many incorrect attempts.',
    fr: 'Trop de tentatives incorrectes.',
  },
  invalid_code: form('Invalid verification code.', 'Code de vérification invalide.'),
  '3ds_failed': {
    type: 'payment_error',
    retryable: true,
    en: '3D Secure verification failed.',
    fr: 'La vérification 3D Secure a échoué.',
  },
  '3ds_rejected': {
    type: 'payment_error',
    retryable: true,
    en: 'Your bank declined the payment during 3D Secure.',
    fr: 'Votre banque a refusé le paiement lors du 3D Secure.',
  },
  '3ds_cancelled': {
    type: 'payment_error',
    retryable: true,
    en: '3D Secure verification was cancelled.',
    fr: 'La vérification 3D Secure a été annulée.',
  },
  '3ds_timeout': {
    type: 'payment_error',
    retryable: true,
    en: '3D Secure verification has expired.',
    fr: 'La vérification 3D Secure a expiré.',
  },
  // 3.6 Client sessions
  client_session_unavailable: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'Card payment is not available in test mode for this provider.',
    fr: "Le paiement par carte n'est pas disponible en mode test pour ce prestataire.",
  },
  client_session_expired: {
    type: 'invalid_request_error',
    retryable: true,
    en: 'This card payment session has expired. Start again.',
    fr: 'Cette session de paiement par carte a expiré. Recommencez.',
  },
  // 3.7 SDK use (developer-facing, English only)
  sheet_already_presented: {
    type: 'invalid_request_error',
    retryable: false,
    en: 'A Wajub payment sheet is already presented.',
    fr: 'A Wajub payment sheet is already presented.',
  },
};

/** "Any other PSP decline code": a 402 whose `error_code` is not in the catalogue. */
export const GENERIC_DECLINE = {
  en: 'This payment could not be completed. Try again or use another payment method.',
  fr: "Ce paiement n'a pas abouti. Réessayez ou utilisez un autre moyen de paiement.",
};

export function isCatalogued(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOGUE, code);
}

/**
 * Fills `{name}` placeholders. A sentence whose placeholder has no value is
 * dropped: "Incorrect code. {n} attempts left." without `n` reads "Incorrect code.".
 */
export function formatMessage(template: string, vars: Record<string, string | number | null | undefined>): string {
  let out = template;
  for (const name of template.match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
    const value = vars[name];
    out =
      value === null || value === undefined || value === ''
        ? out.replace(new RegExp(`\\s*[^.]*\\{${name}\\}[^.]*\\.`), '')
        : out.split(`{${name}}`).join(String(value));
  }
  return out.trim();
}

/** The catalogue's text for `code` in `lang`, or null when the code is not catalogued. */
export function catalogueMessage(
  code: string,
  lang: Lang,
  vars: Record<string, string | number | null | undefined> = {},
): string | null {
  const entry = isCatalogued(code) ? ERROR_CATALOGUE[code] : undefined;
  return entry ? formatMessage(entry[lang], vars) : null;
}
