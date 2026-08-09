# @wajub/react-native

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Native React Native checkout SDK for [Wajub](https://wajub.com). Presents mobile-money and card payments in-app — **no WebView**. Calls `https://api.wajub.com/pay/*` with a session `authorization_token` from your [server SDK](../../README.md).

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

Shared contract: [`mobile/spec/types.ts`](../spec/types.ts) and [`checkout.wajub/PAYMENT_SESSION_API.md`](../../../checkout.wajub/PAYMENT_SESSION_API.md).

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

## Documentation & support

- Mobile SDK docs: [docs.wajub.com/libraries/sdks/mobile](https://docs.wajub.com/libraries/sdks/mobile)
- Server SDKs (create payments): [packages/README.md](../../README.md)

## License

MIT — see [LICENSE](LICENSE).
