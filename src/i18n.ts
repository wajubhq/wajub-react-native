/**
 * The payment sheet's words, in the languages it speaks. The language is the
 * one `present({ locale })` asks for, else the session's own (`locale` on the
 * payment), else English.
 */
export interface SheetStrings {
  title: string;
  tabs: { mobile_money: string; card: string; wallet: string };
  phoneNumber: string;
  payNow: string;
  payByCard: string;
  payWithCard: string;
  payWith: (name: string) => string;
  processing: string;
  waitingForPayment: string;
  walletHint: string;
  providerPageHint: string;
  emailForReceipt: string;
  cardholderName: string;
  noMobileMoney: string;
  noCardChannel: string;
  cardUnavailable: string;
  loadFailed: string;
  paymentFailed: string;
  cardPaymentFailed: string;
  stripeNotInitialized: string;
  fields: {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    country: string;
    state: string;
    zip_code: string;
  };
}

const en: SheetStrings = {
  title: 'Pay with Wajub',
  tabs: { mobile_money: 'Mobile Money', card: 'Card', wallet: 'Wallet' },
  phoneNumber: 'Phone number',
  payNow: 'Pay now',
  payByCard: 'Pay by card',
  payWithCard: 'Pay with card',
  payWith: (name) => `Pay with ${name}`,
  processing: 'Processing…',
  waitingForPayment: 'Waiting for payment…',
  walletHint: 'You will approve the payment in the wallet app.',
  providerPageHint: "You will complete the payment on the provider's secure page.",
  emailForReceipt: 'Email (for your receipt)',
  cardholderName: 'Cardholder name',
  noMobileMoney: 'No Mobile Money channels available.',
  noCardChannel: 'No card channel available.',
  cardUnavailable: 'Card payments unavailable for this session.',
  loadFailed: 'Failed to load session',
  paymentFailed: 'Payment failed',
  cardPaymentFailed: 'Card payment failed',
  stripeNotInitialized: 'Stripe is not initialized. Wrap your app with StripeProvider.',
  fields: {
    first_name: 'First name',
    last_name: 'Last name',
    email: 'Email',
    phone: 'Phone number',
    address: 'Address',
    city: 'City',
    country: 'Country (2-letter code, e.g. CI)',
    state: 'State / region',
    zip_code: 'Postal code',
  },
};

const fr: SheetStrings = {
  title: 'Payer avec Wajub',
  tabs: { mobile_money: 'Mobile Money', card: 'Carte', wallet: 'Portefeuille' },
  phoneNumber: 'Numéro de téléphone',
  payNow: 'Payer',
  payByCard: 'Payer par carte',
  payWithCard: 'Payer par carte',
  payWith: (name) => `Payer avec ${name}`,
  processing: 'Traitement…',
  waitingForPayment: 'En attente du paiement…',
  walletHint: "Vous validerez le paiement dans l'application du portefeuille.",
  providerPageHint: 'Vous finaliserez le paiement sur la page sécurisée du prestataire.',
  emailForReceipt: 'E-mail (pour votre reçu)',
  cardholderName: 'Nom du titulaire de la carte',
  noMobileMoney: 'Aucun moyen Mobile Money disponible.',
  noCardChannel: 'Aucun moyen de paiement par carte disponible.',
  cardUnavailable: 'Le paiement par carte est indisponible pour ce paiement.',
  loadFailed: 'Le paiement n’a pas pu être chargé',
  paymentFailed: 'Le paiement a échoué',
  cardPaymentFailed: 'Le paiement par carte a échoué',
  stripeNotInitialized: "Stripe n'est pas initialisé. Placez votre application dans un StripeProvider.",
  fields: {
    first_name: 'Prénom',
    last_name: 'Nom',
    email: 'E-mail',
    phone: 'Numéro de téléphone',
    address: 'Adresse',
    city: 'Ville',
    country: 'Pays (code à 2 lettres, ex. CI)',
    state: 'État / région',
    zip_code: 'Code postal',
  },
};

/** `fr`, `fr-CM`, `fr_CI` read French; anything else, or nothing, English. */
export function sheetStrings(locale?: string | null): SheetStrings {
  return (locale ?? '').toLowerCase().startsWith('fr') ? fr : en;
}
