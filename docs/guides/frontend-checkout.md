# Frontend Checkout

Frontend code receives display-safe checkout data only. Keep NWC connection
strings, wallet clients, and fulfillment on the backend.

## Self-contained component (recommended)

If your backend mounts OpenReceive (see the [Node](quickstart-node.md) /
[Rails](quickstart-rails.md) quickstarts), the checkout component owns its whole
lifecycle — it creates the checkout, polls status, and drives swaps. You pass
only an order id; auth for those polls is handled for you.

Create-mode checkout (`orderId` / `order-id`) **defers the payer Lightning invoice**
until the visitor selects Bitcoin. On mount it locks the amount (`mint_lightning: false`)
so the method grid can load; altcoin swaps mint only their shadow invoice. Choosing
Bitcoin (or returning from a swap) mints or reuses the payable bolt11 — reuse requires
more than 60 seconds remaining before expiry.

```tsx
// React
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order.id}
  resume
  onSummary={setOrder}
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>;
```

```html
<!-- Web component -->
<openreceive-checkout order-id="order-123" resume></openreceive-checkout>
```

`prefix` defaults to `/openreceive` (where you mounted the router). Pass `prefix` /
`order-id="…" prefix="…"` if you mounted elsewhere. Vue, Svelte, and Angular expose the same
`orderId` + `prefix` + `resume` inputs.

### Guest resume

`resume` fetches `GET {prefix}/orders/{orderId}/summary` (no capability token) so a
refresh can redraw your cart/total UI, and optionally syncs `/checkout/:orderId` via
the History API (`resumePathPrefix`, default `/checkout`). On Next.js, pass
`routeOrderId` from the page param instead of History API sync.

Prepare first (server-priced), then navigate:

```ts
import { requestPrepare } from "@openreceive/browser";

const { order_id, summary } = await requestPrepare({
  body: { cart },
});
```

Without a stable public `orderId` after refresh, the payer can lose the checkout
surface even though payment or a swap refund may still be in progress.

Prefer to create the checkout server-side and hand the snapshot to the component instead? Pass
`checkout={snapshot}` (and an `orderUrl`) — that mode is unchanged and documented per framework
below.

## Browser Helpers

`@openreceive/browser` is the small app-facing browser entry:

- `requestPrepare({ prefix, body })` — `POST {prefix}/prepare` → `{ order_id, summary? }`.
- `requestOrderSummary({ prefix, orderId })` — `GET {prefix}/orders/{orderId}/summary`.
- `status(invoiceLike)` returns `"pending"`, `"settled"`, `"expired"`, or
  `"failed"` from display-safe fields.
- `requestCheckout(options)` posts to a checkout-creation URL. Against the
  **mounted** OpenReceive create route, pass `{ prefix, orderId }` (and optional
  `memo` / `metadata`) — the body is `{ order_id }` only; the server's prepared
  amount sets the price.
- `lightningUri(invoice)`, `qrSvg(invoice)`, and `qrPngDataUrl(invoice)` render
  BOLT11 payment data.
- `copyInvoice({ invoice })` copies the BOLT11 string.
- `openWallet({ invoice })` launches the visitor's installed Lightning wallet
  app with this invoice prefilled.
- `createCheckoutController(options)` powers advanced headless checkout flows.

These helpers reject NWC connection strings. They work with display-safe BOLT11
invoice data only.

```ts
import { requestPrepare, status } from "@openreceive/browser";

const { order_id } = await requestPrepare({ body: { cart } });
// <Checkout orderId={order_id} resume /> creates + polls; status() is for custom UIs.
```

`status()` is a display helper. Your product still unlocks only after the
backend settlement hook runs.

## React

The default checkout is one prop (plus `resume` for guest sites):

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order.id}
  resume
  onSettled={() => showThankYou()}
/>;
```

Or pass a pre-built snapshot:

```tsx
<Checkout
  checkout={checkout}
  orderUrl="/order"
  onSettled={() => showThankYou()}
/>;
```

`onSettled` is a UI hint from status refresh. It is useful for showing a thank-you panel,
but fulfillment stays in the backend settlement hook.

`orderUrl` is optional when using a snapshot. If omitted, React does not invent an order route.
Apps without one can render a static checkout surface without status refresh:

```tsx
<Checkout checkout={checkout} polling={false} />;
```

For app-wide theme attributes and the packaged light/dark toggle:

```tsx
import { Checkout, ThemeScope } from "@openreceive/react";

<ThemeScope as="main" className="page" themeToggle>
  <Checkout orderId={order.id} resume />
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
own markup. Apps with design systems can also pass `components`, `classNames`, or a render
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
<openreceive-checkout
  order-id="order-123"
  resume
  resume-path-prefix="/checkout"
></openreceive-checkout>
```

The element dispatches UI events such as
`openreceive-copy`, `openreceive-open-wallet`, `openreceive-state`,
`openreceive-settled`, `openreceive-summary`, and `openreceive-error`. Treat all frontend events as
display hints.

## Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

defineProps<{ orderId: string }>();
</script>

<template>
  <Checkout
    :order-id="orderId"
    resume
    :on-settled="showThankYou"
  />
</template>
```

## Svelte

```svelte
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  export let orderId;
</script>

<Checkout
  {orderId}
  resume
  onSettled={showThankYou}
/>
```

## Angular

`@openreceive/angular` provides a thin typed binding around the shared web
component. Pass `orderId`, `resume`, and optional `onSummary` / `onSettled` through the shell options.

## Styling

Each frontend package exposes a `styles.css` wrapper:

```ts
import "@openreceive/react/styles.css";
import "@openreceive/elements/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import "@openreceive/angular/styles.css";
```

## Browser Logs

Checkout helpers accept an optional `logger(entry)` callback. Log entries are
display-safe and omit BOLT11 strings, NWC connection strings, signed status or
refresh tokens, cookies, authorization headers, request bodies, refund addresses,
and refund nonces (`refund_nonce_present` is logged instead).

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

<Checkout orderId={order.id} resume logger={logger} />;
```
