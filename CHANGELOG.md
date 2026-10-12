# Changelog

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
