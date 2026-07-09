# Frontend Checkout

Frontend code receives display-safe checkout data only. Keep NWC connection
strings, wallet clients, and fulfillment on the backend.

## Self-contained component (recommended)

If your backend mounts the shipped router (see [Shipped Routes](routes.md)), the checkout
component owns its whole lifecycle — it creates the checkout, polls status, and drives swaps
against the mounted routes. You pass only an order id; the per-order capability token is stored
and attached for you (and same-origin browsers also carry it as a cookie), so there is no fetch
to write and no token to manage.

```tsx
// React
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order.id} onSettled={reloadOrder} onStartOver={returnToCart} />;
```

```html
<!-- Web component (used directly, or via Vue/Svelte/Angular below) -->
<openreceive-checkout order-id="order-123"></openreceive-checkout>
```

`prefix` defaults to `/openreceive` (where you mounted the router). Pass `prefix` /
`order-id="…" prefix="…"` if you mounted elsewhere. Vue, Svelte, and Angular expose the same
`orderId` + `prefix` inputs:

```vue
<Checkout :order-id="order.id" @settled="reloadOrder" />
```
```svelte
<Checkout orderId={order.id} onSettled={reloadOrder} />
```
```html
<openreceive-angular-checkout [orderId]="order.id" [onSettled]="reloadOrder"></openreceive-angular-checkout>
```

Prefer to create the checkout server-side and hand the snapshot to the component instead? Pass
`checkout={snapshot}` (and an `orderUrl`) — that mode is unchanged and documented per framework
below.

## Browser Helpers

`@openreceive/browser` is the small app-facing browser entry:

- `status(invoiceLike)` returns `"pending"`, `"settled"`, `"expired"`, or
  `"failed"` from display-safe fields.
- `requestCheckout(options)` posts to a checkout-creation URL. Against the
  **mounted** OpenReceive create route, pass `{ prefix, orderId }` (and optional
  `memo` / `metadata`) — the body is `{ order_id }` only; the server's
  `resolveOrder` sets the price. Trusted service/library calls use
  `{ amount: { currency, value } }` or `{ amount: { sats } }`. Top-level
  `usd`/`sats` shortcuts are gone. Those shapes are for posting to **your own**
  create URL that then calls `getOrCreateCheckout` with a trusted server-side
  amount; they are rejected by the shipped create route.
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
  orderUrl="/order"
  onSettled={() => showThankYou()}
/>;
```

`orderUrl` is the single app route that authorizes the order and calls
`getOrder` / `swapOptions` / `swapQuote` / `startSwap` / `refundSwap` (or mounts
the shipped HTTP handler, which does the same). The component polls it for status
and drives any automated-swap payment methods through it — see
[Automated Swaps](./automated-swaps.md).

`onSettled` is a UI hint from status refresh. It is useful for showing a thank-you panel,
but fulfillment stays in the backend settlement hook.

`orderUrl` is optional. If omitted, React does not invent an order route.
Apps without one can render a static checkout surface without status refresh:

```tsx
<Checkout checkout={checkout} polling={false} />;
```

Use `orderUrl={false}` to disable URL-based status refresh while still
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
  order-url="/order"
  theme="dark"
></openreceive-checkout>
```

The element renders QR, copy, open-wallet, waiting, countdown, and payment
wizard UI from display-safe data. It dispatches UI events such as
`openreceive-copy`, `openreceive-open-wallet`, `openreceive-state`,
`openreceive-settled`, and `openreceive-error`. Treat all frontend events as
display hints.

Automated swap payment methods ride the same `order-url`: the element lists
payable assets, creates deposit addresses, and drives refunds through that one
route, and provider credentials and tokens stay server-side. Your route must
authorize the caller before calling the typed service methods (or the mounted
handler) — `order_id`, `attempt_id`, and refund nonces are not authentication
credentials. See [Automated Swaps](./automated-swaps.md) for the backend route
and refund flow.

## Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import type { Checkout as Checkout } from "@openreceive/vue";
import "@openreceive/vue/styles.css";

defineProps<{ checkout: Checkout }>();
</script>

<template>
  <Checkout
    :checkout="checkout"
    order-url="/order"
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
  orderUrl="/order"
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
  orderUrl: "/order",
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
refresh tokens, cookies, authorization headers, request bodies, refund addresses,
and refund nonces (`refund_nonce_present` is logged instead).

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

<Checkout checkout={checkout} logger={logger} />;
```

On status polls the client emits `checkout.state.refreshed` (debug) and, when swap
fields move, `swap.state.changed` with `provider_state`, `attention_reason`,
`refund_nonce_present`, and `wallet_settled` / `ui_label` so you can audit
"Finalizing" vs "Payment complete" without server access. Swap start/refund HTTP
calls emit `swap.start.*` / `swap.refund.*` when the same `logger` is wired.
