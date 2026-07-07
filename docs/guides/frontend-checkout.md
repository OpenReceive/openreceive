# Frontend Checkout

Frontend code receives display-safe checkout data only. Keep NWC connection
strings, wallet clients, and fulfillment on the backend.

## Browser Helpers

`@openreceive/browser` is the small app-facing browser entry:

- `status(invoiceLike)` returns `"pending"`, `"settled"`, `"expired"`, or
  `"failed"` from display-safe fields.
- `requestCheckout(options)` posts SDK-shaped checkout input to your own
  checkout-creation URL; most stores call their own `/create_order` route and
  render the checkout returned with the order. Options use camelCase and amount
  shortcuts such as `usd: "9.99"` or `sats: 1000`; the POST body uses
  OpenReceive's snake_case wire fields.
- `lightningUri(invoice)`, `qrSvg(invoice)`, and `qrPngDataUrl(invoice)` render
  BOLT11 payment data.
- `copyInvoice({ invoice })` copies the BOLT11 string.
- `openWallet({ invoice })` launches the visitor's installed Lightning wallet
  app with this invoice prefilled. Call it from your own "Open in wallet"
  button's click handler.
- `createCheckoutController(options)` powers advanced headless checkout flows.

These helpers reject NWC connection strings. They work with display-safe BOLT11
invoice data only.

```ts
import { status } from "@openreceive/browser";

const response = await fetch("/create_order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart })
});
const { order, checkout } = await response.json();

console.log(status(checkout));
```

`status()` is a display helper. Your product still unlocks only after the
backend settlement hook runs.

## React

The default checkout is one prop:

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  checkout={checkout}
  statusUrl="/order_status"
  onSettled={() => showThankYou()}
/>;
```

`onSettled` is a UI hint from status refresh. It is useful for showing a thank-you panel,
but fulfillment stays in the backend settlement hook.

`statusUrl` is optional. If omitted, React does not invent a status route.
Apps without a frontend status route can render a static checkout surface
without status refresh:

```tsx
<Checkout checkout={checkout} polling={false} />;
```

Use `statusUrl={false}` to disable URL-based status refresh while still
allowing a custom `refreshStatus` function.

For app-wide theme attributes and the packaged light/dark toggle:

```tsx
import { Checkout, ThemeScope } from "@openreceive/react";

<ThemeScope as="main" className="page" themeToggle>
  <Checkout checkout={checkout} />
</ThemeScope>
```

To build your own checkout layout from the individual pieces (QR code, invoice
summary, copy button, open-wallet button) instead of using the default
`<Checkout>`:

```tsx
import {
  CopyInvoiceButton,
  InvoiceSummary,
  OpenWalletButton,
  QRCode,
  useCheckout
} from "@openreceive/react";

function CustomCheckout({ checkout }) {
  const model = useCheckout({ checkout });

  return (
    <section>
      <QRCode invoice={model.invoice} />
      <InvoiceSummary
        amountLabel={model.amountLabel}
        fiatLabel={model.fiatLabel}
        paymentHashLabel={model.paymentHashLabel}
        status={model.status}
      />
      <CopyInvoiceButton
        invoice={model.invoice}
        copyInvoice={model.copyInvoice}
      />
      <OpenWalletButton
        invoice={model.invoice}
        openWallet={model.openWallet}
      />
    </section>
  );
}
```

For a fully headless checkout, use `useCheckout({ checkout })` and render your
own markup. The hook owns status refresh, countdown state, copy/open-wallet
actions, retry, refresh, cancel, and the public `status` string.

Apps with design systems can also pass `components`, `classNames`, or a render
function as `children` to `Checkout`.

## Web Components

`@openreceive/elements` registers `<openreceive-checkout>` and
`<openreceive-theme-toggle>` for no-framework pages.

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

defineOpenReceiveElements();
```

```html
<openreceive-theme-toggle
  root-selector=".page"
  checkout-selector="openreceive-checkout"
  default-theme="light"
></openreceive-theme-toggle>

<openreceive-checkout
  invoice-id="or_inv_..."
  invoice="lnbc..."
  payment-hash="..."
  amount-msats="200000"
  status="pending"
  expires-at="1781943000"
  status-url="/order_status"
  theme="dark"
></openreceive-checkout>
```

The element renders QR, copy, open-wallet, waiting, countdown, and payment
wizard UI from display-safe data. It dispatches UI events such as
`openreceive-copy`, `openreceive-open-wallet`, `openreceive-state`,
`openreceive-settled`, and `openreceive-error`. Treat all frontend events as
display hints.

For automated swap payment methods, pass app-owned `swap-options-url`,
`swap-start-url`, and `swap-refund-url` attributes. Those endpoints call the
server-side `swapOptions`, `startSwap`, and `refundSwap` methods. If your UI
shows a live estimate before creating the provider order, expose an app-owned
quote endpoint that calls `swapQuote({ orderId, payInAsset })` after the payer
selects an asset. The browser receives deposit instructions and an `attempt_id`;
provider credentials and tokens remain server-side.

Authorize those endpoints in your application before calling OpenReceive.
`order_id`, `attempt_id`, and refund nonces are not authentication credentials.
When a refund is required, the browser first submits the refund address for
review and then sends a second request with `confirm: true`; the provider refund
is not dispatched on the first address submission.

## Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import type { Checkout as OpenReceiveCheckout } from "@openreceive/vue";
import "@openreceive/vue/styles.css";

defineProps<{ checkout: OpenReceiveCheckout }>();
</script>

<template>
  <Checkout
    :checkout="checkout"
    status-url="/order_status"
    :on-settled="showThankYou"
  />
</template>
```

## Svelte

```svelte
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  export let checkout;
</script>

<Checkout
  {checkout}
  statusUrl="/order_status"
  onSettled={showThankYou}
/>
```

## Angular

`@openreceive/angular` provides a thin typed binding around the shared web
component:

- `@openreceive/angular/checkout-component`

The common binding path creates the checkout element attributes and listeners
from the same checkout object:

```ts
import {
  createOpenReceiveAngularCheckoutShellBinding,
  defineOpenReceiveElements
} from "@openreceive/angular";

defineOpenReceiveElements();

const shell = createOpenReceiveAngularCheckoutShellBinding(checkout, {
  rootSelector: ".page",
  statusUrl: "/order_status",
  onSettled: () => showThankYou()
});
```

## Styling

Each frontend package exposes a `styles.css` wrapper:

```ts
import "@openreceive/react/styles.css";
import "@openreceive/elements/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import "@openreceive/angular/styles.css";
```

Use the package you installed. The CSS does not contain receive-only NWC codes or
live checkout authority.

## Browser Logs

Checkout helpers accept an optional `logger(entry)` callback. Log entries are
display-safe and omit BOLT11 strings, NWC connection strings, signed status or
refresh tokens, cookies, authorization headers, and request bodies.

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

<Checkout checkout={checkout} logger={logger} />;
```
