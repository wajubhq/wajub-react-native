# @wajub/react-native

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native React Native checkout SDK for [Wajub](https://wajub.com). Presents Mobile Money, card and wallet payments in-app — **no WebView** — in light or dark, in French or English, with your merchant branding. Calls `https://api.wajub.com/pay/*` with a session `authorization_token` from your [server SDK](https://docs.wajub.com/libraries/sdks).

It follows the Wajub mobile SDK contract v2, shared with the Flutter, Android and iOS SDKs and with Wajub.js 1.8: the same states, callbacks, results, errors and appearance object as the web Components.

## Architecture

```
Your backend (server SDK, sk_)
        ↓ authorization_token
React Native app
        ↓
usePayment().present({ sessionToken })
        ↓
GET /pay/session + GET /pay/sdk-config (in parallel)
        ↓
Payment sheet: method → form → POST /pay/process
        ↓
Approval on the phone, a confirmation step, or the provider's page in the system browser
        ↓
GET /pay/status and realtime (Pusher protocol) until the payment ends
        ↓
present() resolves: complete · processing · failed · cancelled
```

## Requirements

| Requirement | Version |
|-------------|---------|
| `react-native` | `>=0.74` |
| `react` | `>=18` |
| `@react-native-community/netinfo` | `>=11.0.0` (the realtime client needs it) |
| `@react-native-async-storage/async-storage` | `>=1.17.0`, optional but recommended: keeps the device fingerprint across app restarts |
| `@stripe/stripe-react-native` | `>=0.38.0`, optional: only for the `stripe_elements` card flavor |

The SDK is plain TypeScript: no native module of its own. `@stripe/stripe-react-native` sets its own minimum iOS/Android platform versions — see [their requirements](https://github.com/stripe/stripe-react-native).

## Installation

```bash
npm install @wajub/react-native @react-native-community/netinfo @react-native-async-storage/async-storage
# Cards through Stripe only:
npm install @stripe/stripe-react-native
cd ios && pod install
```

`WajubProvider` at the root is optional:

```tsx
import { WajubProvider } from '@wajub/react-native';

export default function App() {
  return (
    <WajubProvider>
      <RootNavigator />
    </WajubProvider>
  );
}
```

For Stripe cards the sheet initialises Stripe with the payment's own publishable key (from `GET /pay/sdk-config`: only the account that issues a `pm_…` can charge it), so no `StripeProvider` is needed for it. If your app also takes its own Stripe payments, initialise Stripe again with your key afterwards.

## Quick start

Create a payment on your backend, then present the sheet from a screen. Render `PaymentSheet` (an element, `null` while no sheet is open) in the same component:

```tsx
import { usePayment } from '@wajub/react-native';

function CheckoutScreen({ authorizationToken }: { authorizationToken: string }) {
  const { present, PaymentSheet } = usePayment();

  const pay = async () => {
    const result = await present({
      sessionToken: authorizationToken,
      returnUrl: 'https://shop.example.com/app/payment-return', // optional: a universal/app link
      onStateChange: ({ state }) => console.log(state),
    });

    switch (result.status) {
      case 'complete':
        // Paid. Confirm server-side (GET /payments/{id} or the payment.succeeded webhook) before delivering.
        return showReceipt(result.payment.id);
      case 'processing':
        // An attempt is under way (a Mobile Money approval may still land): your server will know.
        return showPending();
      case 'failed':
        return showError(result.error.message);
      case 'cancelled':
        // result.reason: 'payer_cancelled' | 'dismissed' | 'host_gone'
        return;
    }
  };

  return (
    <>
      <Button title="Pay" onPress={pay} />
      {PaymentSheet}
    </>
  );
}
```

`present()` always settles, exactly once — also when the screen that opened it unmounts (`cancelled` with `host_gone` before any attempt, `processing` once one started, `complete` after a success). Calling it while a sheet is open rejects at once with a `WajubError` whose code is `sheet_already_presented`.

## What the sheet does

| Channel | In the sheet |
|---------|--------------|
| Mobile Money (operators, and aggregates such as `cm.mobile`) | Country, operator list with logos (brand badges when a logo is missing), the number with its dial code, formatted as typed. The operator is detected from the number until the payer picks one by hand; a number of another offered operator is refused with a clear message (never for Wave and other wallets that take any number). Then "Approve the payment on your phone", with the operator's instruction. |
| Card, `client_session` (Paystack, Flutterwave, Adyen Pay by Link) | The contact fields the provider still needs, then its hosted checkout in the system browser; verified with Wajub when the payer comes back. |
| Card, `stripe_elements` | Stripe's `CardField` (needs `@stripe/stripe-react-native`), with the payment's publishable key. |
| Card, `hosted_redirect` (Kkiapay, CinetPay, Mollie, PayPal, …) | Exactly the sdk-config `required_fields`, then the provider's page in the system browser. |
| Card in sandbox (`form`) | Wajub's test card form. Card numbers are never sent in live. |
| One-tap wallets (Djamo) | One button, then the wallet's page. |
| Confirmation steps (`confirm_otp`, `confirm_pin`, `confirm_phone`, `confirm_birthday`, `confirm_address`) | A native screen each, with the remaining attempts and "Resend" after 60 s. |
| Sandbox 3-D Secure | The email code screen, with its countdown. |

Other channel types (crypto, bank transfer, USSD-only, BNPL…) are not offered. While a provider's page is open the sheet shows "Payment in progress" with **Continue payment**; on the way back it reads the status at once. It watches the payment with `GET /pay/status` (5 s, slower after two minutes without a change, 15 s while the realtime socket is up, backing off on errors) next to the payment's private realtime channel, for up to 15 minutes. A request that got no answer is never shown as a failure: the sheet waits for the status instead.

Every string is in French and English: the language is `locale`, else the payment's own, else the device's.

## Options

`present(options: PresentOptions)`:

| Option | Default | |
|--------|---------|---|
| `sessionToken` | — | The payment's `authorization_token`. Required. |
| `locale` | the payment's, else the device's | `'fr'` or `'en'` (anything else reads English). |
| `appearance` | — | See [Appearance](#appearance). |
| `loader` | `'skeleton'` | `'skeleton'` or `'spinner'` while the payment loads. |
| `readyTimeout` | `15000` | ms before a load that has not finished shows an error with **Retry** (`onLoadError` with `ready_timeout`); the sheet still shows the payment if it arrives later. `0` disables it. |
| `returnUrl` | — | An https universal/app link the provider's page sends the payer back to (`return_url`). Without it, nothing is sent. |
| `mobileMoney.country` | the payer's country when offered | ISO-2 country to start on. |
| `mobileMoney.countryLocked` | `false` | Hide the country selector (with `country`). |
| `mobileMoney.operatorMode` | `'choose'` | `'detect'`: no operator list until the number does not tell. |
| `realtime` | from the payment | `{ enabled, host, port, tls }`: a self-hosted Reverb or Soketi behind another hostname, or `enabled: false` for polling only. |
| `cancelOnDismiss` | `true` | A dismiss before any attempt cancels the payment (`POST /pay/cancel`). `false` keeps it open so you can `present()` it again. |
| `autoCloseSuccess` | `3000` | ms before the success screen closes itself; `0` keeps it until the payer closes it. |

## Callbacks

All optional, all called on the JS thread, in this order. A callback that throws is logged and the sheet carries on.

| Callback | Payload | When |
|----------|---------|------|
| `onReady` | `{ sessionId, environment, amount, currency, methods }` | The first screen is drawn (also for an already paid or ended payment). |
| `onStateChange` | `{ state, method }` | After `onReady`, then on every state change. |
| `onLoadError` | `WajubError` | The sheet cannot offer a payment: `session_not_found`, `session_terminal_expired`, `session_terminal_cancelled`, `session_terminal_failed`, `load_error`, `ready_timeout`, `no_payment_method`. |
| `onPaymentStarted` | `{ method, channel }` | The first accepted answer of an attempt. From now on, closing the sheet resolves `processing`. |
| `onRedirect` | `{ url, method: 'GET' }` | Right before a provider's page opens in the system browser. |
| `onSuccess` | `PaymentSuccess` | The payment succeeded (`method: 'unknown'` when it was paid before the sheet opened). |
| `onError` | `WajubError` | Every failure the payer sees, retryable ones included (field validation excluded). |
| `onCancel` | `{ reason, redirectUrl }` | The sheet closes as `cancelled`. |
| `onComplete` | `CheckoutResult` | Exactly once, as the sheet closes: what `present()` resolves with. |

`PaymentSuccess` is Wajub.js's: `id` (the payment's `trx_…` id), `reference` (yours), `amount` (what the payer paid, fee included), `currency`, `method`, `status: 'success'`, `timestamp`, `receipt_url`.

## Results

| `status` | When | Payload |
|----------|------|---------|
| `complete` | The sheet closes after a success. | `payment`, `transaction` |
| `processing` | The sheet closes during an attempt, or after watching for 15 minutes. | `transaction` |
| `failed` | The sheet closes on a failure, an expired payment, a load error, or a payment cancelled elsewhere (`payment_cancelled`). | `error`, `transaction` |
| `cancelled` | "Cancel payment", a dismiss before any attempt, or the host going away. | `reason`, `redirectUrl` |

## States

`onStateChange` reports Wajub.js's names: `INITIATED` (method list), `COLLECTING_DETAILS` (a method's form), `PROCESSING` (Pay pressed), `APPROVAL_REQUIRED` (approve on the phone), `USSD_REQUIRED`, `OTP_REQUIRED`, `PIN_REQUIRED`, `PHONE_REQUIRED`, `BIRTHDAY_REQUIRED`, `ADDRESS_REQUIRED`, `3DS_REQUIRED`, `VERIFYING`, `PENDING` (waiting: a provider's page, or a confirmation), `SUCCESS`, `FAILED` ("Try again" when retryable), `EXPIRED`, `CANCELLED`.

## Errors

Every error is a `WajubError` (an `Error`), with Wajub.js's fields and the mobile ones: `type`, `code`, `message` (for the payer, in the sheet's language), `decline_code`, `retryable`, `param`, `http_status`, `correlation_id` (the response's `X-Request-Id`), `retry_after_seconds`, `details`, `block_reference`, `api_message` (the API's own English text, for logs). `toJSON()` gives the plain shape; `localized('fr')` the same error in French.

A few codes: `insufficient_funds` and other declines (`decline_code` set, retryable), `merchant_not_verified`, `shield_blocked` (with `block_reference`), `payment_method_restricted`, `rate_limited` (with `retry_after_seconds`), `payment_failed`, `payment_attempt_ended` (refused, nothing charged), `session_expired`, `unsupported_action`, `redirect_unavailable`, `client_session_expired`.

## Appearance

`appearance` is the same object as Wajub.js's, so the web Components and the native sheet share it:

```tsx
present({
  sessionToken,
  appearance: {
    theme: 'auto', // 'light' | 'dark' | 'auto' | 'system', or a preset: 'stripe' | 'night' | 'flat' | 'none'
    variables: { colorPrimary: '#0F766E', borderRadius: '12px', fontFamily: 'Inter' },
    buttonTextColor: '#FFFFFF',
  },
});
```

- **Colour scheme**: `colorScheme` (or `theme`) first, then the app's scheme with `inherit: true`, then the merchant's dashboard setting, else `auto`, which follows the phone — live, while the sheet is open.
- **Variables** (Wajub.js names): `colorPrimary`, `colorBackground`, `colorText`, `colorTextSecondary`, `colorTextPlaceholder`, `colorDanger`, `colorSuccess`, `fontFamily`, `fontSizeBase`, `fontWeightNormal`, `fontWeightMedium`, `fontWeightBold`, `spacingUnit`, `borderRadius` (capped at 22), `spacingGridRow`, `spacingGridColumn`.
- **Top-level keys**: `primaryColor`, `secondaryColor`, `backgroundColor`, `fontFamily`, `borderRadius`, `buttonTextColor`, `inputBackgroundColor`, `inputBorderColor`, `textMutedColor`, `successColor`, `errorColor`, `shadow` (`none` · `low` · `high`), `labels`, `disableAnimations`.
- **Precedence**, per token: `variables` > top-level keys > the preset > the merchant's branding (colours, radius, weights, logo, name; "Secured by Wajub" hidden for white-label merchants) > the web checkout's default palettes (`DEFAULT_PALETTES`, light and dark). A merchant primary colour that does not reach 3:1 against the background falls back to the default.
- Colours: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`. Lengths: `"8px"`, `"8"`, `"0.5rem"`. Values that do not parse, unknown keys and `rules` are ignored, never an error.
- `fontFamily` must be a font your app ships; system stacks (`-apple-system`, `Roboto`, `sans-serif`…) mean the platform's font. The merchant's dashboard font is not used: the SDK cannot know whether your app ships it.
- `disableAnimations: true`, or the phone's "reduce motion", stops the skeleton's pulse and the fades.

## Sandbox

A payment created with a test key (`transaction.sandbox`) shows a "TEST MODE" badge. Mobile Money test numbers are the operator prefix and seven digits ending with a scenario: `000000` success, `000001` insufficient funds, `000002` failure, `000003` timeout, `000004` cancelled — e.g. `670000000` in Cameroon. Sandbox prefixes do not follow real numbering plans, so the sheet never refuses a test number as another operator's. Cards use Wajub's test cards in the sandbox form (`4000056655665556` asks for the 3-D Secure email code).

## Headless integration

`WajubSession` calls `/pay/*` for a host that draws its own UI, through the same transport (headers, device signals, timeouts, retries with the same `Idempotency-Key`):

```ts
import { createSession } from '@wajub/react-native';

const session = createSession(authorizationToken);
const payment = await session.session();      // GET /pay/session
const config = await session.sdkConfig();     // GET /pay/sdk-config
const result = await session.payMobileMoney({ channel_slug: 'cm.mobile', phone: '677 12 34 56', country: 'CM', operator: 'mtn' });
// The number goes out as +237677123456.

if (result.status === 'requires_action' && result.action === 'confirm_otp') {
  await session.verifyOtp(result.stepId!, '123456'); // also verifyPin, verifyPhone, verifyBirthday, verifyAddress, resend, verify3ds, send3ds
}
const stop = session.watchStatus((update) => console.log(update.status));
const status = await session.status();        // GET /pay/status — its `reference` is the payment's id
```

`process()` / `pay…()` return a `PaymentResult` (spec v2's `ProcessOutcome`): `complete`, `processing` (`kind: 'ussd' | 'pending'`), `requires_action` (`redirect`, `confirm`, `confirm_3ds`, `client_session`, `push_approval` for a Mobile Money approval, and the five confirmation steps with their `stepId` and `hint`), or `failed`. An action the SDK cannot perform comes back as `failed` with `unsupported_action`. Card through Paystack/Flutterwave without the sheet: `session.payCardHosted('card', { email })` opens the hosted checkout and completes it when the payer returns; to use the PSP's native SDK instead, start the session with `startClientSession()`, launch it with the returned `client_session`, then call `completeClientSession(client_session.id)`.

## Migrating from 1.4

- `present()` now runs the whole payment in the sheet and resolves a `CheckoutResult` when it closes: `complete`, `processing`, `failed`, or `cancelled` (which still carries `cancelled: true`, so `'cancelled' in result` keeps working). It no longer resolves `requires_action`: approvals, confirmation steps and provider pages happen inside the sheet, and the sheet watches the status itself — drop your own `watchStatus()` after `present()`.
- The `PaymentSheet` component is deprecated in favour of `usePayment()`; it keeps its props and draws the new sheet.
- Mobile Money numbers are sent in E.164 (`+237677123456`; Côte d'Ivoire keeps its leading 0), with `operator` on aggregates when the payer named one.
- `mapProcessResponse()` maps `confirm_otp` … `confirm_address` to `requires_action` with `stepId` and `hint` (they used to fail as `unsupported_action`), and a USSD instruction to `processing` with `kind: 'ussd'`.
- `watchStatus()` / `subscribeStatus()` read `GET /pay/status` on the schedule above and stop on an ended session; `intervalMs` sets the base interval.
- `WajubError` has the new fields above, `type` follows the spec's mapping, and its messages are the catalogue's; `WajubError.fromHttp()` is deprecated (kept as it was), `WajubError.fromResponse()` is the mapping the SDK uses.
- Every request carries `X-Wajub-Client`, `X-Request-Id` and `Accept-Language`; every payment attempt `data._client` (time zone, language, screen, a per-install fingerprint). Install `@react-native-async-storage/async-storage` so the fingerprint survives restarts.

## Documentation & support

- Mobile SDK docs: [docs.wajub.com/libraries/sdks/mobile](https://docs.wajub.com/libraries/sdks/mobile)
- Server SDKs (create payments): [docs.wajub.com/libraries/sdks](https://docs.wajub.com/libraries/sdks)

## License

MIT — see [LICENSE](LICENSE).
