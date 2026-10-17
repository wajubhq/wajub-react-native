/**
 * The payment sheet's words, in the languages it speaks (wording from the
 * web checkout where it has one). The language is the one
 * `present({ locale })` asks for, else the payment's own, else the device's.
 * Error messages live in the error catalogue (errorCatalogue.ts).
 */
import { langOf } from './errorCatalogue';

export interface SheetStrings {
  title: string;
  securedBy: string;
  testMode: string;
  close: string;
  tabs: { mobile_money: string; card: string; wallet: string };
  selectMethod: string;
  change: string;
  cancelPayment: string;
  minimum: (amount: string) => string;
  maximum: (amount: string) => string;
  payNow: string;
  payAmount: (amount: string) => string;
  payByCard: string;
  payWithCard: string;
  payWith: (name: string) => string;
  processing: string;
  // Mobile Money
  country: string;
  operator: string;
  otherOperator: string;
  phoneNumber: string;
  mobileMoneyInstructions: string;
  approveTitle: string;
  /** The code the payer generates in the operator's menu. */
  payerOtp: {
    title: string;
    description: string;
    dial: string;
    copy: string;
    copied: string;
    amount: string;
    stepsTitle: string;
    /** The three steps when none are given; `amount` null: none was given. */
    genericSteps: (amount: string | null) => [string, string, string];
    codeLabel: string;
    submit: string;
    changeMethod: string;
    sandboxHint: (code: string) => string;
    approvalMessage: string;
    formHint: (ussdCode: string) => string;
    formHintGeneric: string;
    attemptsLeft: (count: number) => string;
    exactLength: (length: number) => string;
    lengthRange: (min: number, max: number) => string;
    refused: string;
  };
  approveBody: (phone: string) => string;
  noCodeToEnter: string;
  instructions: string;
  waitingForConfirmation: string;
  ussdTitle: string;
  ussdBody: string;
  // Card and wallets
  walletHint: string;
  providerPageHint: string;
  emailForReceipt: string;
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  testCardHint: string;
  // Confirmation steps
  steps: { otp: string; pin: string; phone: string; birthday: string; address: string };
  codeSentTo: (contact: string) => string;
  code: string;
  pin: string;
  day: string;
  month: string;
  year: string;
  verify: string;
  verifying: string;
  resendCode: string;
  resendIn: (seconds: number) => string;
  threeDsTitle: string;
  threeDsSentTo: (email: string) => string;
  threeDsBrowser: string;
  expiresIn: (time: string) => string;
  // Waiting and outcomes
  waitingForPayment: string;
  pendingTitle: string;
  pendingBody: string;
  continuePayment: string;
  willBeNotified: string;
  successTitle: string;
  successBody: string;
  reference: string;
  viewReceipt: string;
  failureTitle: string;
  rateLimitedTitle: string;
  tryAgain: string;
  tryAgainIn: (seconds: number) => string;
  expiredTitle: string;
  cancelledTitle: string;
  endedTitle: string;
  loadErrorTitle: string;
  sessionNotFoundTitle: string;
  retry: string;
  loading: string;
  // Kept from 1.4
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
  securedBy: 'Secured by Wajub',
  testMode: 'TEST MODE',
  close: 'Close',
  tabs: { mobile_money: 'Mobile Money', card: 'Card', wallet: 'Wallet' },
  selectMethod: 'Choose a payment method',
  change: 'Change',
  cancelPayment: 'Cancel payment',
  minimum: (amount) => `Minimum ${amount}`,
  maximum: (amount) => `Maximum ${amount}`,
  payNow: 'Pay now',
  payAmount: (amount) => `Pay ${amount}`,
  payByCard: 'Pay by card',
  payWithCard: 'Pay with card',
  payWith: (name) => `Pay with ${name}`,
  processing: 'Processing…',
  country: 'Country',
  operator: 'Operator',
  otherOperator: 'Change operator',
  phoneNumber: 'Phone number',
  mobileMoneyInstructions: 'You will receive a notification to confirm the payment',
  approveTitle: 'Approve the payment on your phone',
  payerOtp: {
    title: 'Generate your payment code',
    description: 'Before you pay, your operator asks for a code you generate yourself from its menu, for the exact amount of the payment.',
    dial: 'Code to dial',
    copy: 'Copy',
    copied: 'Copied',
    amount: 'Exact amount to enter',
    stepsTitle: 'How to get your code',
    genericSteps: (amount) => [
      "Open your operator's Mobile Money menu (USSD code or app).",
      amount ? `Generate a payment code for the exact amount: ${amount}.` : 'Generate a payment code for the exact amount.',
      'Enter the code you received below.',
    ],
    codeLabel: 'Payment code',
    submit: 'Confirm payment',
    changeMethod: 'Use another payment method',
    sandboxHint: (code) => `Test mode: enter the code ${code}. Any other code is refused.`,
    approvalMessage: 'Code received. Your operator is processing the payment, this can take a moment.',
    formHint: (ussdCode) => `For this payment, you will generate a code by dialing ${ussdCode}: the next step guides you.`,
    formHintGeneric: "For this payment, you will generate a code from your operator's menu: the next step guides you.",
    attemptsLeft: (count) => (count <= 0 ? 'No tries left.' : count === 1 ? '1 try left.' : `${count} tries left.`),
    exactLength: (length) => `The code must have ${length} digits.`,
    lengthRange: (min, max) => `The code must have between ${min} and ${max} digits.`,
    refused: 'Your operator did not accept this code. Generate a new one and try again.',
  },
  approveBody: (phone) => `A request was sent to ${phone}.`,
  noCodeToEnter: 'Check your phone. No code to enter.',
  instructions: 'Instructions',
  waitingForConfirmation: 'Waiting for confirmation…',
  ussdTitle: 'USSD confirmation',
  ussdBody: 'Dial the code below on your phone to confirm the payment',
  walletHint: 'You will approve the payment in the wallet app.',
  providerPageHint: "You will complete the payment on the provider's secure page.",
  emailForReceipt: 'Email (for your receipt)',
  cardholderName: 'Cardholder name',
  cardNumber: 'Card number',
  expiryMonth: 'Month (MM)',
  expiryYear: 'Year (YY)',
  cvv: 'CVV',
  testCardHint: "Test mode: use one of Wajub's test cards.",
  steps: {
    otp: 'Verification code',
    pin: 'Card PIN',
    phone: 'Confirm your phone number',
    birthday: 'Date of birth',
    address: 'Billing address',
  },
  codeSentTo: (contact) => `Code sent to ${contact}`,
  code: 'Code',
  pin: 'PIN',
  day: 'Day',
  month: 'Month',
  year: 'Year',
  verify: 'Verify',
  verifying: 'Verifying…',
  resendCode: 'Resend code',
  resendIn: (seconds) => `Resend (${seconds}s)`,
  threeDsTitle: '3D Secure verification',
  threeDsSentTo: (email) => `Enter the code sent to ${email}`,
  threeDsBrowser: 'Complete the 3D Secure check in your browser.',
  expiresIn: (time) => `Expires in ${time}`,
  waitingForPayment: 'Waiting for payment…',
  pendingTitle: 'Payment in progress',
  pendingBody: 'We are waiting for confirmation of your payment',
  continuePayment: 'Continue payment',
  willBeNotified: 'You will be notified',
  successTitle: 'Payment successful',
  successBody: 'Your payment was processed successfully',
  reference: 'Reference',
  viewReceipt: 'View receipt',
  failureTitle: 'Payment failed',
  rateLimitedTitle: 'Too many attempts',
  tryAgain: 'Try again',
  tryAgainIn: (seconds) => `Retry in ${seconds}s`,
  expiredTitle: 'Session expired',
  cancelledTitle: 'Payment cancelled',
  endedTitle: 'This payment has ended',
  loadErrorTitle: "We couldn't load the payment",
  sessionNotFoundTitle: 'Session not found',
  retry: 'Retry',
  loading: 'Loading',
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
  securedBy: 'Sécurisé par Wajub',
  testMode: 'MODE TEST',
  close: 'Fermer',
  tabs: { mobile_money: 'Mobile Money', card: 'Carte', wallet: 'Portefeuille' },
  selectMethod: 'Choisir un mode de paiement',
  change: 'Changer',
  cancelPayment: 'Annuler le paiement',
  minimum: (amount) => `Minimum ${amount}`,
  maximum: (amount) => `Maximum ${amount}`,
  payNow: 'Payer',
  payAmount: (amount) => `Payer ${amount}`,
  payByCard: 'Payer par carte',
  payWithCard: 'Payer par carte',
  payWith: (name) => `Payer avec ${name}`,
  processing: 'Traitement…',
  country: 'Pays',
  operator: 'Opérateur',
  otherOperator: "Changer d'opérateur",
  phoneNumber: 'Numéro de téléphone',
  mobileMoneyInstructions: 'Vous recevrez une notification pour confirmer le paiement',
  approveTitle: 'Validez le paiement sur votre téléphone',
  payerOtp: {
    title: 'Générez votre code de paiement',
    description: 'Avant de payer, votre opérateur demande un code que vous générez vous-même depuis son menu, pour le montant exact du paiement.',
    dial: 'Code à composer',
    copy: 'Copier',
    copied: 'Copié',
    amount: 'Montant exact à saisir',
    stepsTitle: 'Comment obtenir votre code',
    genericSteps: (amount) => [
      'Ouvrez le menu Mobile Money de votre opérateur (code USSD ou application).',
      amount ? `Générez un code de paiement pour le montant exact : ${amount}.` : 'Générez un code de paiement pour le montant exact.',
      'Saisissez ci-dessous le code que vous avez reçu.',
    ],
    codeLabel: 'Code de paiement',
    submit: 'Valider le paiement',
    changeMethod: 'Changer de moyen de paiement',
    sandboxHint: (code) => `Mode test : saisissez le code ${code}. Tout autre code est refusé.`,
    approvalMessage: 'Code reçu. Votre opérateur traite le paiement, cela peut prendre quelques instants.',
    formHint: (ussdCode) => `Pour ce paiement, vous générerez un code en composant ${ussdCode} : l'étape suivante vous guide.`,
    formHintGeneric: "Pour ce paiement, vous générerez un code depuis le menu de votre opérateur : l'étape suivante vous guide.",
    attemptsLeft: (count) => (count <= 0 ? 'Plus aucun essai possible.' : count === 1 ? 'Il vous reste 1 essai.' : `Il vous reste ${count} essais.`),
    exactLength: (length) => `Le code doit comporter ${length} chiffres.`,
    lengthRange: (min, max) => `Le code doit comporter entre ${min} et ${max} chiffres.`,
    refused: "Votre opérateur n'a pas accepté ce code. Générez-en un nouveau et réessayez.",
  },
  approveBody: (phone) => `Une demande a été envoyée au ${phone}.`,
  noCodeToEnter: 'Vérifiez votre téléphone. Aucun code à saisir.',
  instructions: 'Instructions',
  waitingForConfirmation: 'En attente de confirmation…',
  ussdTitle: 'Confirmation USSD',
  ussdBody: 'Composez le code ci-dessous sur votre téléphone pour confirmer le paiement',
  walletHint: "Vous validerez le paiement dans l'application du portefeuille.",
  providerPageHint: 'Vous finaliserez le paiement sur la page sécurisée du prestataire.',
  emailForReceipt: 'E-mail (pour votre reçu)',
  cardholderName: 'Nom du titulaire de la carte',
  cardNumber: 'Numéro de carte',
  expiryMonth: 'Mois (MM)',
  expiryYear: 'Année (AA)',
  cvv: 'CVV',
  testCardHint: 'Mode test : utilisez une carte de test Wajub.',
  steps: {
    otp: 'Code de vérification',
    pin: 'Code PIN de la carte',
    phone: 'Confirmez votre numéro de téléphone',
    birthday: 'Date de naissance',
    address: 'Adresse de facturation',
  },
  codeSentTo: (contact) => `Code envoyé au ${contact}`,
  code: 'Code',
  pin: 'Code PIN',
  day: 'Jour',
  month: 'Mois',
  year: 'Année',
  verify: 'Vérifier',
  verifying: 'Vérification…',
  resendCode: 'Renvoyer le code',
  resendIn: (seconds) => `Renvoyer (${seconds}s)`,
  threeDsTitle: 'Vérification 3D Secure',
  threeDsSentTo: (email) => `Saisissez le code envoyé à ${email}`,
  threeDsBrowser: 'Terminez la vérification 3D Secure dans votre navigateur.',
  expiresIn: (time) => `Expire dans ${time}`,
  waitingForPayment: 'En attente du paiement…',
  pendingTitle: 'Paiement en cours',
  pendingBody: 'Nous attendons la confirmation de votre paiement',
  continuePayment: 'Continuer le paiement',
  willBeNotified: 'Vous serez notifié',
  successTitle: 'Paiement réussi',
  successBody: 'Votre paiement a été traité avec succès',
  reference: 'Référence',
  viewReceipt: 'Voir le reçu',
  failureTitle: 'Paiement échoué',
  rateLimitedTitle: 'Trop de tentatives',
  tryAgain: 'Réessayer',
  tryAgainIn: (seconds) => `Réessayer dans ${seconds}s`,
  expiredTitle: 'Session expirée',
  cancelledTitle: 'Paiement annulé',
  endedTitle: 'Ce paiement est terminé',
  loadErrorTitle: 'Impossible de charger le paiement',
  sessionNotFoundTitle: 'Session introuvable',
  retry: 'Réessayer',
  loading: 'Chargement',
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
  return langOf(locale) === 'fr' ? fr : en;
}

/** Fraction digits of the currencies Intl may not know (XAF, XOF: none). */
const ZERO_DECIMAL = ['XAF', 'XOF', 'GNF', 'RWF', 'UGX', 'KMF', 'BIF', 'DJF', 'JPY', 'KRW', 'VND', 'CLP', 'PYG', 'MGA'];

/** `amount` (major units) in `currency`, with the currency's usual decimals. */
export function formatAmount(amount: number, currency: string, lang: 'en' | 'fr'): string {
  try {
    return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { style: 'currency', currency }).format(amount);
  } catch {
    const digits = ZERO_DECIMAL.includes(currency.toUpperCase()) ? 0 : 2;
    const fixed = amount.toFixed(digits);
    const [whole, fraction] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'fr' ? ' ' : ',');
    const number = fraction ? `${grouped}${lang === 'fr' ? ',' : '.'}${fraction}` : grouped;
    return lang === 'fr' ? `${number} ${currency}` : `${currency} ${number}`;
  }
}
