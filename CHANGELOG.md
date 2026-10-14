# Changelog

## 1.5.0

- The payment sheet takes the payment to its end. `present()` resolves once, when the sheet
  closes, with `complete` (and a `PaymentSuccess`), `processing` (with the payment), `failed` or
  `cancelled` (with a `reason` and the `redirectUrl`). Code written for 1.4 compiles and runs
  unchanged: the result still fits `PaymentResult | { cancelled: true }`, and its type still lists
  `requires_action`, which no longer comes — the Mobile Money approval, confirmation steps and
  provider pages happen in the sheet, which watches the status itself.
- `present()` settles even when the screen that opened it unmounts: `cancelled` (`host_gone`)
  before any attempt, `processing` once one started, `complete` after a success — it used to wait
  forever. Polling stops and nothing is cancelled. A second `present()` while a sheet is open is
  refused with `sheet_already_presented`; one called as the previous sheet settles (from
  `onComplete`, or by the next screen) opens, and React's StrictMode re-runs keep the open sheet.
- New callbacks, with Wajub.js's names and order: `onReady`, `onStateChange` (Wajub.js's 17 states),
  `onLoadError`, `onPaymentStarted`, `onRedirect`, `onSuccess`, `onError`, `onCancel`, `onComplete`.
  A callback that throws is logged and the sheet carries on.
- The sheet has Wajub.js's appearance object (`theme`, presets `stripe`, `night`, `flat`, `none`,
  `variables`, top-level keys), light and dark following the phone live, the merchant's branding
  under it (colours, radius, weights, logo, name, white label) and the web checkout's palettes
  under that. No colour is hard-coded any more; `StripeCardSection` follows the sheet's theme.
- Loading shows a skeleton (or `loader: 'spinner'`), honours "reduce motion" and
  `disableAnimations`, and reports `onReady`. A load that fails or takes longer than `readyTimeout`
  (15 s by default) shows the error with Retry instead of a bare message. A payment already paid
  opens on the success screen; a payment that ended (failed, cancelled, expired) on a notice with
  `onLoadError` and Wajub.js's codes; one still `processing` on its approval screen, watched.
- Mobile Money: a country selector, one line per operator of an aggregate (`cm.mobile` shows MTN
  and Orange) with their logos or brand badges, the number formatted as typed with its dial code,
  the operator detected from it until the payer picks one, and a number of another offered
  operator refused in the payer's language before it is sent (never for Wave and other wallets
  that take any number; never in sandbox, whose test numbers do not follow real numbering plans).
  The number goes out in E.164 — Côte d'Ivoire keeps its leading 0 — with `operator` on an
  aggregate when the payer named one. `mobileMoney.country`, `countryLocked` and
  `operatorMode: 'detect'` set the form up. The tables come from the spec's shared data file.
- After Pay, a Mobile Money push shows "Approve the payment on your phone" with the operator's
  instruction; `confirm_otp`, `confirm_pin`, `confirm_phone`, `confirm_birthday` and
  `confirm_address` open their own screens (remaining attempts, Resend after 60 s) instead of
  failing as `unsupported_action`; the sandbox 3-D Secure email code has its screen and countdown;
  a provider's page opens in the system browser with Continue payment; the outcome screens offer
  Try again when the error allows it (after the countdown of a rate limit).
- Every request carries `X-Wajub-Client`, `X-Request-Id` and the device's `Accept-Language`, has a
  timeout (30 s, 60 s for the calls that reach a provider) and is retried when that is safe: reads
  up to three times with backoff, a payment up to twice with the same body and `Idempotency-Key`,
  never a confirmation step. A payment that got no answer is watched, never shown as failed. Every
  payment attempt sends `data._client` (time zone, language, screen, a fingerprint kept per
  install). `@react-native-async-storage/async-storage` is now a peer dependency, so the
  fingerprint survives restarts; `present({ storage })` or `createSession(token, client,
  { storage })` keep it in your own storage instead. A missing module never breaks a payment (the
  SDK warns in development).
- A payment request that got no answer is watched; if the status still reads `pending` a minute
  after the last try, the request most likely never reached Wajub: the sheet goes back to the form
  with a connection message, and the next Pay reuses the same `Idempotency-Key`. A 400 whose status
  says the payment is running is watched too, never a failure. Closing the sheet while the payment
  is still loading cancels nothing; a refused cancel whose status cannot be read resolves
  `processing`. A card or wallet-only payment waits for sdk-config instead of showing "no payment
  method", and a failed one shows Retry.
- Watching follows the spec's schedule: every 5 s, slower after two minutes without a change,
  15 s while the realtime socket is up, backing off on errors, 15 minutes at most. It stops on an
  ended session (`410`, `401`) instead of polling forever, and decides on `GET /pay/status`. The
  realtime server is the payment's own (`echo`), or yours with `realtime: { host, port, tls }`;
  `realtime: { enabled: false }` polls only. `watchStatus()` and `subscribeStatus()` keep 1.4's
  results and their first read right away, with no time limit; they now slow down, back off on
  errors and stop on an ended session with a `failed` result, where 1.4 polled it forever.
- The sheet's errors follow the spec's catalogue: `WajubError` adds `http_status`,
  `block_reference` and `api_message`, maps every API answer the same way on every SDK, and has its
  message in the sheet's language (`localized('fr')`, `toJSON()`). The 1.4 `WajubSession` methods
  keep 1.4's codes and messages. `WajubError.fromHttp()` is deprecated.
- `WajubSession` adds spec v2's calls: `session()`, `sdkConfig()`, `status()`, `submit()` (and
  `mapProcessOutcome()`), which returns the confirmation steps with their `stepId` and `hint`,
  `verifyOtp()`, `verifyPin()`, `verifyPhone()`, `verifyBirthday()`, `verifyAddress()`, `resend()`,
  `verify3ds()` and `send3ds()`. `process()`, `mapProcessResponse()` and the other 1.4 methods keep
  1.4's results. `SessionData.parsedBranding` reads `branding` with its types.
- Stripe cards use the payment's own publishable key from sdk-config: the sheet initialises Stripe
  with it, so a `StripeProvider` with another key no longer makes every card payment fail, and puts
  the app's key back after when given as `present({ stripe: { appPublishableKey } })`.
- `returnUrl` is sent as `return_url` to the provider's page, `cancelOnDismiss: false` keeps the
  payment open when the sheet is closed before any attempt, and `autoCloseSuccess` sets how long
  the success screen stays. The `PaymentSheet` component is deprecated in favour of
  `usePayment()`; it keeps its callbacks' 1.4 meanings.

## 1.4.1

- `watchStatus()` reports the payment's status again when realtime is on. The SDK subscribed to a
  channel named after your own reference, while Wajub publishes on the payment's id: the socket
  connected, the polling stopped, and no update ever arrived. It now subscribes on the payment's
  id (`transaction.id`).
- Polling no longer stops when the socket connects. It runs for the whole watch, so a status the
  socket did not carry (one that changed before the subscription, or a missed event) still
  reaches your callback within `intervalMs`. With realtime on, the callback is called when the
  result changes, not on every poll, and a final result stops the polling.
- An ended session (`410`) is an `authentication_error` with `retryable: false`, and a server
  error (`5xx`) an `api_error`. Both used to come back as a retryable `payment_error`. `param`
  names the refused field when a refusal is about exactly one. A token that is not a session
  (`401`, `404`) is not retryable either: no retry of the same token can succeed.
- Closing the payment sheet before submitting anything also cancels the payment on Wajub
  (`POST /pay/cancel`), as the hosted checkout and the Flutter SDK do; `present()` still resolves
  `{ cancelled: true }`. When an attempt was under way the payment is left alone, since a Mobile
  Money approval can still land. `WajubSession.cancelIfNothingSubmitted()` does the same for a
  sheet of your own.
- The 3D Secure or provider page opens on Android 11 and later without a `<queries>` block in your
  manifest. The SDK asked `canOpenURL()` first, which Android answers `false` for https without
  that declaration, and gave up. An https URL is now opened directly.
- The payment sheet speaks French: `present({ locale: 'fr' })` asks for it, and without `locale`
  the sheet follows the payment's own language. English otherwise. `StripeCardSection` takes a
  `locale` prop for the same.
- `@stripe/stripe-react-native` is really optional: the package no longer imports it at load time,
  so an app that only takes Mobile Money bundles without it. Install it to take cards through
  Stripe, as before.
- `@react-native-community/netinfo` is declared as a peer dependency: the realtime client needs it
  in a React Native bundle.

Releases before 1.4.1 are described in the Git history.
