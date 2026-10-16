# Changelog

## 1.5.0

- The payment sheet takes the payment to its end. `present()` resolves once, when the sheet
  closes, with `complete` (and a `PaymentSuccess`), `processing` (with the payment), `failed` or
  `cancelled` (with a `reason` and the `redirectUrl`). Code written for 1.4 compiles and runs
  unchanged: the result still fits `PaymentResult | { cancelled: true }`, and its type still lists
  `requires_action`, which no longer comes: the Mobile Money approval, the confirmation steps and
  the provider's pages happen in the sheet, which follows the payment until it ends.
- `present()` settles even when the screen that opened it unmounts: `cancelled` (`host_gone`)
  before any attempt, `processing` once one started, `complete` after a success. It used to wait
  forever. Called after that screen unmounted, it resolves `cancelled` (`host_gone`) at once. A
  second `present()` while a sheet is open is refused with `sheet_already_presented`; one called as
  the previous sheet closes opens, and React's StrictMode keeps the open sheet.
- New callbacks: `onReady`, `onStateChange` (18 states), `onLoadError`, `onPaymentStarted`,
  `onRedirect`, `onSuccess`, `onError`, `onCancel`, `onComplete`. A callback that throws is logged
  and the sheet carries on.
- The `appearance` option: presets `stripe`, `night`, `flat` and `none`, `variables`, top-level
  keys and `labels: 'floating'`, light and dark following the phone live, and the merchant's
  branding (colours, radius, weights, logo, name, white label) for what you leave unset.
  `StripeCardSection` follows the sheet's look.
- Loading shows a skeleton (or `loader: 'spinner'`) and honours "reduce motion" and
  `disableAnimations`. A load that fails or takes longer than `readyTimeout` (15 s by default)
  shows the error with **Retry**. A payment already paid opens on the success screen, one that
  ended on a notice with `onLoadError`, and one still in progress on its waiting screen.
- Mobile Money: a country selector, one line per operator with its logo (or a brand badge), the
  number formatted as typed, the operator preselected from the number until the payer picks one,
  and a number of another offered operator refused in the payer's language before anything is
  sent. `mobileMoney.country`, `countryLocked` and `operatorMode: 'detect'` set the form up.
- Mobile Money numbers are read by each country's current numbering plan, with numbers of an
  earlier plan (Benin's 8 digits, Gabon's) read in their current form and the leading 0 kept
  where it is part of the number (Côte d'Ivoire, Benin, Congo, Burkina Faso); the operator is
  recognised from the number in more countries; a number written with 00 is read like one written
  with +, and another country's number is refused; and in a sandbox payment the test numbers are
  accepted as they are typed.
- Digits typed on another script's keyboard (Arabic-Indic, Persian, Devanagari…) are read as
  typed: in the Mobile Money number, the confirmation codes, the PIN, the date of birth, the
  3-D Secure code and the card fields.
- After **Pay**, "Approve the payment on your phone" with the operator's instruction; native
  screens for a one-time code, a PIN, a phone number, a date of birth and a billing address,
  including a second step a provider asks for after the first; the sandbox 3-D Secure email code;
  provider pages in the system browser with **Continue payment**; **Try again** on the failure
  screen when the error allows it.
- When the payer's fee depends on how they pay, the amount on **Pay**, in the summary and on the
  approval screen follows the operator or method selected, and `PaymentSuccess.amount` is what was
  charged.
- Operators that take Mobile Money only with a code the payer generates in their menu get a
  screen with the code to dial (a link to the dialer on Android, **Copy** everywhere), the exact
  amount and the steps. It reports the new state `PAYER_OTP_REQUIRED`: a `switch` that lists every
  `CheckoutState` needs that case.
- For your own UI, the channels of `WajubSession.session()` and their operators carry what the
  payer pays there (`fee_amount`, `amount_total`), a channel that needs that code says how to get
  it (`payer_otp`), and `mapProcessOutcome()` returns a request for the code as `payerOtp`.
- Closing the sheet: before any attempt it cancels the payment (unless `cancelOnDismiss: false`);
  during a payment it resolves `processing` and the payment keeps running; on the failure screen
  it resolves `failed` and cancels the payment when it still can be. **Cancel payment** is offered
  only while no payment is under way, and Pay, ✕ and **Cancel payment** are disabled while it
  runs. A cancel Wajub refuses, for a payment being paid or partly paid, leaves it as it is.
- A payment whose answer was lost on the network is never shown as failed: the sheet waits for its
  outcome, and offers the form again when the payment never started.
- `WajubError` adds `http_status`, `block_reference` and `api_message`, `toJSON()` and
  `localized('fr')`; the sheet's errors have their message in the sheet's language. The 1.4
  `WajubSession` methods keep 1.4's codes and messages. `WajubError.fromHttp()` is deprecated.
- `WajubSession` adds `session()`, `status()`, `submit()` (with `mapProcessOutcome()`), the
  confirmation step calls (`verifyOtp()`, `verifyPin()`, `verifyPhone()`, `verifyBirthday()`,
  `verifyAddress()`, `resend()`, `verify3ds()`, `send3ds()`) and `SessionData.parsedBranding`.
  The 1.4 methods keep 1.4's results, and their objects keep every key of Wajub's answer.
- Stripe cards need no `StripeProvider`. If your app also takes its own Stripe payments, pass its
  key as `present({ stripe: { appPublishableKey } })` so they keep working after the sheet.
- New options: `returnUrl`, the link a provider's page sends the payer back to, and
  `autoCloseSuccess`, how long the success screen stays.
- `@react-native-async-storage/async-storage` is a new peer dependency: install it.
- The package ships compiled JavaScript with its type declarations.
- Operator and channel logos use images React Native can draw, with the operator's brand badge
  otherwise.
- The `PaymentSheet` component is deprecated in favour of `usePayment()`. It keeps its callbacks'
  1.4 meanings — `onResult` with `processing` when the sheet closes during an attempt, `onDismiss`
  before one — and, made visible while another sheet is open, opens once that one closes.
- `watchStatus()` and `subscribeStatus()` keep 1.4's results and stop on a session that has ended,
  with a `failed` result, where 1.4 kept reading it.

## 1.4.1

- `watchStatus()` reports the payment's status changes again: for most payments, no update reached
  your callback.
- A status change no longer goes missing: it reaches your callback within `intervalMs`, and a final
  status ends the watch.
- An ended session is an `authentication_error` with `retryable: false`, and a server error an
  `api_error`. Both used to come back as a retryable `payment_error`. `param` names the refused
  field when a refusal is about exactly one. A token that is not a payment session is not
  retryable either.
- Closing the payment sheet before submitting anything also cancels the payment, as the hosted
  checkout does; `present()` still resolves `{ cancelled: true }`. When an attempt was under way
  the payment is left alone, since a Mobile Money approval can still land.
  `WajubSession.cancelIfNothingSubmitted()` does the same for a sheet of your own.
- The 3-D Secure or provider page opens on Android 11 and later without a `<queries>` block in
  your manifest.
- The payment sheet speaks French: `present({ locale: 'fr' })` asks for it, and without `locale`
  the sheet follows the payment's own language. English otherwise. `StripeCardSection` takes a
  `locale` prop for the same.
- `@stripe/stripe-react-native` is optional: an app that only takes Mobile Money bundles without
  it. Install it to take cards through Stripe, as before.
- `@react-native-community/netinfo` is a peer dependency: install it.

Releases before 1.4.1 are described in the Git history.
