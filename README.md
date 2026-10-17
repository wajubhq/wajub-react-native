# @wajub/react-native

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Take Mobile Money, card and wallet payments in your React Native app with a ready-made, native payment sheet — no WebView — in light or dark, in French or English, with the merchant's branding. `present()` opens it and resolves once, when it closes.

## Requirements

| Peer | Range | Needed |
|------|-------|--------|
| `react` | `>=18` | Always |
| `react-native` | `>=0.74` | Always |
| `@react-native-community/netinfo` | `>=11.0.0` | Always |
| `@react-native-async-storage/async-storage` | `>=1.17.0` | Always |
| `@stripe/stripe-react-native` | `>=0.38.0` | Optional, for Stripe cards: without it the sheet does not offer them |

`@stripe/stripe-react-native` sets its own minimum iOS and Android versions, which become yours when you install it.

## Installation

```bash
npm install @wajub/react-native @react-native-community/netinfo @react-native-async-storage/async-storage
# Stripe cards only:
npm install @stripe/stripe-react-native
# Optional: the sheet's Copy buttons use it when installed, else React Native's own clipboard:
npm install @react-native-clipboard/clipboard
cd ios && pod install
```

Optional packages are used when installed and skipped otherwise, through Metro's `allowOptionalDependencies`, which React Native's default Metro configuration turns on.

No provider is needed at the root of your app: `usePayment()` works in any component. `WajubProvider` is optional.

## Quick start

1. Your server [creates the payment](https://docs.wajub.com/api/payments/create) with its secret key and hands the app the `authorization_token`.
2. The app calls `present()` with that token, and renders the `PaymentSheet` element the hook returns in the same component.
3. Your server confirms the payment — the `payment.succeeded` webhook or `GET /payments/{id}` — before it delivers. The result in the app is what the payer saw, not proof of payment.

```tsx
import { Button } from 'react-native';
import { usePayment } from '@wajub/react-native';

function CheckoutScreen({ authorizationToken }: { authorizationToken: string }) {
  const { present, PaymentSheet } = usePayment();

  const pay = async () => {
    const result = await present({
      sessionToken: authorizationToken,
      returnUrl: 'https://shop.example.com/app/payment-return', // optional: a universal/app link
    });

    switch (result.status) {
      case 'complete':
        // Paid on the device. Deliver once your server has confirmed it.
        return showReceipt(result.payment.id);
      case 'processing':
        // Closed while a payment was running: an approval may still land.
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

`present()` resolves exactly once, with the value `onComplete` receives. If the component that called the hook unmounts while the sheet is open, it still resolves: `cancelled` with `host_gone` before any attempt, `processing` once one started, `complete` after a success. Calling it while a sheet is open rejects with a `WajubError` whose code is `sheet_already_presented`, and leaves the open sheet alone.

`usePayment()` returns `{ present, PaymentSheet }`, where `PaymentSheet` is an element or `null`: put `{PaymentSheet}` in your JSX. `<PaymentSheet />` is a different, deprecated component.

## Options

Everything goes in the one object `present()` takes, the callbacks below included.

| Option | Default | |
|--------|---------|---|
| `sessionToken` | — | The payment's `authorization_token`. Required. |
| `locale` | the payment's, else the device's | `'fr'` or `'en'` (anything else reads English). |
| `appearance` | — | The sheet's look, see [Appearance](#appearance). |
| `loader` | `'skeleton'` | `'skeleton'` or `'spinner'` while the payment loads. |
| `readyTimeout` | `15000` | ms. Past it, a sheet still loading shows an error with **Retry** and `onLoadError` gets `ready_timeout`; the payment shows if it arrives later. `0` disables it. |
| `returnUrl` | — | An `https` universal or app link the provider's page sends the payer back to. Without it, the payer comes back to the app by hand. |
| `mobileMoney.country` | the payer's country when offered | ISO-2 country the form starts on. |
| `mobileMoney.countryLocked` | `false` | Hides the country selector (with `country`). |
| `mobileMoney.operatorMode` | `'choose'` | `'detect'` hides the operator list while the number tells the operator. |
| `cancelOnDismiss` | `true` | Closing the sheet before any attempt cancels the payment. `false` keeps it open, so you can `present()` it again. |
| `autoCloseSuccess` | `3000` | ms the success screen stays. `0` keeps it until the payer closes it. |
| `stripe.appPublishableKey` | — | Your app's own Stripe key, if your app also takes its own Stripe payments (see [Cards](#cards)). |

## Callbacks and states

All optional, all called on the JavaScript thread, in this order: `onReady`, then `onStateChange` as the payer moves on, `onPaymentStarted` and `onRedirect` when they apply, `onSuccess`, `onError` or `onCancel`, and `onComplete` last, exactly once. A callback that throws is logged and the sheet carries on.

| Callback | Receives | When |
|----------|----------|------|
| `onReady` | `{ sessionId, environment, amount, currency, methods }` | The first screen is drawn, also for a payment already paid or ended. |
| `onStateChange` | `{ state, method }` | After `onReady`, then on every state change. |
| `onLoadError` | `WajubError` | The sheet cannot offer a payment: `session_not_found`, `session_terminal_expired`, `session_terminal_cancelled`, `session_terminal_failed`, `load_error`, `ready_timeout`, `no_payment_method`. |
| `onPaymentStarted` | `{ method, channel }` | The payment request is accepted. From now on, closing the sheet resolves `processing`. |
| `onRedirect` | `{ url, method: 'GET' }` | Right before a provider's page opens in the system browser. |
| `onSuccess` | `PaymentSuccess` | The payment succeeded (`method: 'unknown'` when it was paid before the sheet opened). |
| `onError` | `WajubError` | Every failure the payer sees, retryable ones included, field validation excluded. |
| `onCancel` | `{ reason, redirectUrl }` | The sheet closes as `cancelled`. |
| `onComplete` | `CheckoutResult` | The sheet closes: what `present()` resolves with. |

States: `INITIATED` (method list), `COLLECTING_DETAILS` (a method's form), `PROCESSING` (Pay pressed), `APPROVAL_REQUIRED` (approve on the phone), `USSD_REQUIRED`, `OTP_REQUIRED`, `PIN_REQUIRED`, `PHONE_REQUIRED`, `BIRTHDAY_REQUIRED`, `ADDRESS_REQUIRED`, `3DS_REQUIRED`, `PAYER_OTP_REQUIRED` (the code the payer generates in their operator's menu), `VERIFYING`, `PENDING` (waiting: a provider's page, or a confirmation), `SUCCESS`, `FAILED` ("Try again" when retryable), `EXPIRED`, `CANCELLED`.

## Results

| `status` | When | Carries |
|----------|------|---------|
| `complete` | The sheet closed after the success screen, also for a payment paid before it opened. | `payment` (`PaymentSuccess`), `transaction` |
| `processing` | The sheet closed while a payment was under way. The sheet never shows a failure it is not sure of: money may still move, so confirm on your server. | `transaction`, and `instruction` when the payer had one |
| `failed` | The sheet closed on a failure, an expired payment, a load error, or a payment cancelled elsewhere (`payment_cancelled`). | `error`, `transaction` |
| `cancelled` | **Cancel payment**, a close before any attempt, or the host unmounting first. | `reason`, `redirectUrl` |

`PaymentSuccess` carries `id` (Wajub's payment id, what `GET /payments/{id}` takes), `reference` (yours), `amount` (what the payer paid, fee included), `currency`, `method`, `status: 'success'`, `timestamp` and `receipt_url`.

## Cancelling and closing

The payer closes the sheet with ✕ in its header, Android's back button, or **Close** on a final screen. There is no swipe-down.

| The payer closes the sheet | Result |
|----------------------------|--------|
| While the payment loads | `cancelled`, `dismissed` |
| On the method list or a form, before any attempt or after **Try again** | `cancelled`, `dismissed`. The payment is cancelled, unless `cancelOnDismiss` is `false`. |
| While a payment is under way: the payer approves, confirms a step or waits | `processing`. The payment keeps running: confirm it on your server. |
| On the failure screen | `failed`, with the error the payer saw. The payment is cancelled when it still can be, unless `cancelOnDismiss` is `false`. |
| On the success screen | `complete` |
| With **Cancel payment** | `cancelled`, `payer_cancelled`. The payment is cancelled for good. |

**Cancel payment** shows under the method list and the forms, never while a payment is under way.

## Appearance

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

- **Colour scheme**: `colorScheme` (or `theme`) is `light`, `dark` or `auto`, which follows the phone, live. `inherit: true` follows your app's colour scheme instead; without either, the merchant's Dashboard setting applies.
- **Variables**: `colorPrimary`, `colorBackground`, `colorText`, `colorTextSecondary`, `colorTextPlaceholder`, `colorDanger`, `colorSuccess`, `fontFamily`, `fontSizeBase`, `fontWeightNormal`, `fontWeightMedium`, `fontWeightBold`, `spacingUnit`, `borderRadius` (up to 22), `spacingGridRow`, `spacingGridColumn`.
- **Top-level keys**: `primaryColor`, `secondaryColor`, `backgroundColor`, `fontFamily`, `borderRadius`, `buttonTextColor`, `inputBackgroundColor`, `inputBorderColor`, `textMutedColor`, `successColor`, `errorColor`, `shadow` (`none`, `low`, `high`), `labels`, `disableAnimations`.
- **Precedence**: `variables` win over the top-level keys, which win over the preset; what you leave unset comes from the merchant's branding in the Dashboard (colours, radius, weights, logo, name), then the default palette. A white-label merchant hides "Secured by Wajub".
- **Values**: colours as `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`; lengths as `"8px"`, `"8"` or `"0.5rem"`. A value that does not parse, or an unknown key, is ignored.
- **Fonts**: `fontFamily` must be a font your app ships, else the platform's font is used.
- **Labels**: `labels: 'above'`, the default, draws each label above its field; `'floating'` rests it inside the empty field and moves it onto the field's border with focus or a value.
- **Motion**: `disableAnimations: true`, or the phone's reduce-motion setting, stops the animations.

## Mobile Money

One form covers every Mobile Money operator of the payment: the payer picks the country and the operator and types the number, formatted as it is typed. The number's prefix preselects its operator, and a number of another offered operator is refused before anything is sent. After **Pay**, "Approve the payment on your phone" shows the number and the operator's instruction. `mobileMoney.country`, `countryLocked` and `operatorMode` set the form up.

## Cards

Stripe cards need the optional `@stripe/stripe-react-native` peer; no other Stripe setup is needed. If your app also takes its own Stripe payments, pass your app's key in `stripe: { appPublishableKey }` so they keep working after the sheet's card form.

Other cards open a secure page of the payment provider in the system browser, with **Continue payment** in the sheet. In sandbox, the sheet shows a test card form.

## Confirmation steps

When a payment needs one more step after **Pay**, the sheet shows it natively: a one-time code, the card's PIN, a phone number, a date of birth or a billing address, with the attempts left after a wrong answer and **Resend** after a minute. A provider may ask for a second step after the first; the sheet follows it. In sandbox, a card that asks for 3-D Secure gets a code sent by email.

## Errors

Every failure is a `WajubError`, a subclass of `Error`: `onLoadError`, `onError` and a `failed` result hand one over.

| Field | What it is for |
|-------|----------------|
| `type` | `api_error`, `authentication_error`, `invalid_request_error`, `payment_error` or `rate_limit_error` |
| `code` | What went wrong, to branch on |
| `message` | For the payer, in the sheet's language |
| `decline_code` | On a decline, its reason |
| `retryable` | Whether another attempt can work |
| `param` | The field at fault, when there is one |
| `http_status` | The HTTP status of the answer, when there was one |
| `correlation_id` | The request id to quote to Wajub support |
| `retry_after_seconds` | The wait on `rate_limited` |
| `details` | The field errors, when there are several |
| `block_reference` | On `shield_blocked`, the reference to quote to Wajub support |
| `api_message` | Wajub's own English text, for your logs |

`toJSON()` gives the plain shape, and `localized('fr')` the same error in French.

Codes worth branching on: `insufficient_funds`, `payment_declined`, `payment_attempt_ended` (refused, nothing was charged), `payment_failed`, `payment_cancelled`, `session_expired`, `shield_blocked`, `merchant_restricted`, `payment_method_restricted`, `rate_limited`, `session_terminal_expired`, `unsupported_action`, `redirect_unavailable` and `sheet_already_presented`.

## Your own UI

The sheet's screens are not exported. An app that draws its own payment screens uses `WajubSession`, which `createSession(token)` returns:

```ts
import { createSession } from '@wajub/react-native';

const session = createSession(authorizationToken);
const payment = await session.session(); // the amount, the payment methods (`channels`), the branding
const outcome = await session.submit('cm.mobile', { phone: '+237677123456', country: 'CM', operator: 'mtn' });

if (outcome.status === 'requires_action' && outcome.action === 'confirm_otp' && outcome.stepId) {
  await session.verifyOtp(outcome.stepId, '123456');
}
const stop = session.watchStatus((update) => console.log(update.status));
```

- `submit(channel, data)` pays with one of the payment's `channels` (its `slug`) and resolves with `complete`, `processing` (`kind: 'approval' | 'ussd' | 'pending'`, with the operator's `instruction`), `requires_action` (a provider's page `url`, or a confirmation step's `stepId` and `hint`) or `failed`.
- `verifyOtp()`, `verifyPin()`, `verifyPhone()`, `verifyBirthday()` and `verifyAddress()` answer a confirmation step; `resend()` sends its code again. An answer that carries an `action` asks for the next step.
- `status()` reads where the payment is, `watchStatus()` reports its changes until it ends (call the function it returns to stop), and `cancel()` cancels a payment no attempt is running for.

## Privacy

To make the payment, the SDK sends Wajub what the payer types. For fraud prevention, it also sends basic device information and a random install identifier, which is not the advertising identifier. What to declare in the App Store privacy labels and in Google Play's data safety form, category by category, is on [Mobile SDKs](https://docs.wajub.com/libraries/sdks/mobile#privacy).

## Testing

A payment your server creates with a sandbox key puts the whole flow in sandbox, and the sheet shows a "TEST MODE" badge. The test numbers and cards are on [Test scenarios](https://docs.wajub.com/developer-tools/testing/test-scenarios).

## Documentation & support

- React Native SDK: [docs.wajub.com/libraries/sdks/react-native](https://docs.wajub.com/libraries/sdks/react-native)
- Server SDKs (create payments): [docs.wajub.com/libraries/sdks](https://docs.wajub.com/libraries/sdks)

## License

MIT — see [LICENSE](LICENSE).
