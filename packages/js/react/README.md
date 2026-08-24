# @openreceive/react

React checkout components for OpenReceive (`<Checkout>`, `useCheckout`, `PaymentWizard`).

## Mount

Render `<Checkout>` and import the checkout styles once — without them the
components render unstyled.

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function Pay() {
  return <Checkout reference="order-123" onSettled={() => console.log("paid")} />;
}
```

Pass `reference` to let the component create the checkout (create mode), or pass
a `checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
`docs/internal/wrapper-parity.md` in the repository.

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are ordinary props. React receives
framework values rather than DOM `CustomEvent`s — `onState` gets the
`CheckoutState`, `onError` the thrown value.

`useCheckout({ checkout })` is the headless half: it drives a concrete snapshot
and returns the view model plus the copy/open actions. Create mode belongs to
`<Checkout>`, so the hook takes no create options.

## Icon assets

The checkout loads its payment-method icons by URL at runtime; your app must
serve them where the resolution lands. See
[Icon assets in `@openreceive/browser`](https://github.com/openreceive/openreceive/blob/master/packages/js/browser/README.md#icon-assets)
for the per-bundler recipes.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
