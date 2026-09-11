# @openreceive/react

Add Bitcoin Lightning checkout to your React app with a ready-to-use
`<Checkout>` component, or build your own payment screen with `useCheckout`
and `PaymentWizard`. Let customers choose a payment method, scan a QR code,
and follow payment status without building the checkout flow from scratch.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Pair this browser package with an OpenReceive server integration. Your server
authorizes the order, sets the amount, configures swaps, and verifies
settlement; wallet and provider credentials stay on the server.

## Install

Use Node.js 22 or later for package tooling and React 18 or later.

```sh
npm install @openreceive/react
```

Follow the [frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
to connect the component to your server routes. Use the server-side payment
hook to fulfill orders; browser callbacks update the interface.

## Mount

Render `<Checkout>` and import the checkout styles once — without them the
components render unstyled.

```tsx
import { Checkout } from "@openreceive/react";
// Scoped to what OpenReceive renders: safe next to any CSS framework, in any order.
import "@openreceive/react/styles.css";

export function Pay() {
  return <Checkout reference="order-123" onSettled={() => console.log("paid")} />;
}
```

Pass `reference` to let the component create the checkout (create mode), or pass
a `checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
[frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md).

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are ordinary props. React receives
framework values rather than DOM `CustomEvent`s — `onState` gets the
`CheckoutState`, `onError` the thrown value.

`useCheckout({ checkout })` is the headless half: it drives a concrete snapshot
and returns the view model plus the copy/open actions. Create mode belongs to
`<Checkout>`, so the hook takes no create options.

## Images

Everything the checkout draws — payment-method icons, wallet logos, pay
tutorials — ships inside the JavaScript; nothing to copy, serve or configure,
under any bundler. If your Content-Security-Policy has a strict `img-src`,
allow `data:`. See
[Images in `@openreceive/browser`](https://github.com/openreceive/openreceive/blob/master/packages/js/browser/README.md#images).

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
