# @wajub/react-native

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native React Native checkout SDK for [Wajub](https://wajub.com). Presents mobile-money and card payments in-app — **no WebView**. Calls `https://api.wajub.com/pay/*` with a session `authorization_token` from your [server SDK](https://docs.wajub.com/libraries/sdks).

## Architecture

```
Your backend (server SDK, sk_)
        ↓ authorization_token
React Native app
        ↓
createSession(token) → GET /pay/session, GET /pay/sdk-config
        ↓
PaymentSheet modal
        ↓
POST /pay/process → handlePaymentAction (redirect/3DS via system browser)
        ↓
watchStatus() → Pusher or polling until terminal
```

## Requirements

| Requirement | Version |
|-------------|---------|
| `react-native` | `>=0.74` |
| `@stripe/stripe-react-native` | `>=0.38.0` (for `stripe_elements` card flavor) |

`@stripe/stripe-react-native` sets its own minimum iOS/Android platform versions — see [their requirements](https://github.com/stripe/stripe-react-native).

## Installation

```bash
npm install @wajub/react-native @stripe/stripe-react-native pusher-js
cd ios && pod install
```

Wrap your app with `StripeProvider` (publishable key from your Wajub dashboard or `GET /pay/sdk-config`):

```tsx
import { StripeProvider } from '@stripe/stripe-react-native';
import { WajubProvider } from '@wajub/react-native';

export default function App() {
  return (
    <StripeProvider publishableKey="pk_test_...">
      <WajubProvider>
        <RootNavigator />
      </WajubProvider>
    </StripeProvider>
  );
}
```

## Quick start

Create a payment on your backend, then present the sheet:

```tsx
const { present, PaymentSheet } = usePayment();

const outcome = await present({ sessionToken: authorizationToken });
if ('cancelled' in outcome) return;
// redirect / 3DS already opened in system browser when applicable
```

## Features

| Flavor | Support |
|--------|---------|
| Mobile Money (`form`) | Native modal |
| Card (`stripe_elements`) | `@stripe/stripe-react-native` CardField |
| Card via Paystack / Flutterwave / Adyen Pay by Link (`client_session`) | PSP-hosted checkout in the system browser — PIN / OTP / AVS / 3DS handled by the PSP |
| Card via PayPal / Mollie / Paddle / Kkiapay / FedaPay / PayDunya / CinetPay (`hosted_redirect`) | PSP's own page in the system browser; the sheet first asks for the sdk-config `required_fields` (e.g. email, CinetPay billing) — headless: `session.payCardHostedRedirect(channel, billing)` |
| Redirect / 3DS | `Linking.openURL` (system browser) |
| Realtime | `pusher-js` + polling fallback |

## Headless integration

```ts
import { createSession, handlePaymentAction } from '@wajub/react-native';

const session = createSession(authorizationToken);
const result = await session.payCard('card', 'pm_...');
await handlePaymentAction(session, result);
const stop = session.watchStatus((update) => console.log(update));
```

## Card via Paystack / Flutterwave (client sessions)

When `sdk-config` reports `client_session: true` for the card channel, the
PSP's own hosted checkout collects the card and runs PIN / OTP / address
checks — this SDK never touches card data. `PaymentSheet` does it for you;
headless:

```ts
const result = await session.payCardHosted('card', { email: 'payer@example.com' });
// 'complete' → paid · 'processing' → not confirmed yet, keep watchStatus() running
```

`payCardHosted()` = `startClientSession()` → open `client_session.hosted_url`
in the system browser → wait for the app to return to the foreground →
`completeClientSession(id)`. The backend verifies the payment with the PSP by
its own reference and checks amount and currency.

To use a PSP's native SDK instead, start the session yourself and launch it
with the returned `client_session` (Paystack: `public_key` + `access_code`;
Flutterwave: `public_key` + `encryption_key`, `reference` as `tx_ref`), then
call `session.completeClientSession(client_session.id)` when it returns.

An API `action` this SDK can't perform natively (e.g. `confirm_otp`) comes
back as `failed` with `error.code === 'unsupported_action'` — never as an
endless `processing`.

## Documentation & support

- Mobile SDK docs: [docs.wajub.com/libraries/sdks/mobile](https://docs.wajub.com/libraries/sdks/mobile)
- Server SDKs (create payments): [docs.wajub.com/libraries/sdks](https://docs.wajub.com/libraries/sdks)

## License

MIT — see [LICENSE](LICENSE).
