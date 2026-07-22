# Frontend Checkout

Frontend code receives display-safe checkout data only. Keep NWC connection
strings, wallet clients, and fulfillment on the backend.

## Self-contained component (recommended)

If your backend mounts OpenReceive (see the [Node](quickstart-node.md) /
[Rails](quickstart-rails.md) quickstarts), the checkout component owns its whole
lifecycle — it creates the checkout, polls status, and drives swaps. You pass
only an order id; auth for those polls is handled for you.

```tsx
// React
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order.id}
  onSummary={setOrder}
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>;
```

```html
<!-- Web component -->
<openreceive-checkout order-id="order-123"></openreceive-checkout>
```

`prefix` defaults to `/openreceive`. Pass `prefix` if you mounted elsewhere.
Create-mode checkout defers the Lightning invoice until the visitor selects
Bitcoin; altcoin swaps mint only their shadow invoice.

### Guest resume

Create mode always fetches `GET {prefix}/orders/{orderId}/summary` (no
capability token) so a refresh can redraw your cart/total UI via `onSummary`.

URL sync is separate and off by default — many hosts own routing or other state
themselves. Pass `syncUrl` to push `/checkout/:orderId` via the History API
(`resumePathPrefix`, default `/checkout`). On Next.js, pass `routeOrderId` from
the page param instead (Checkout will not mutate the URL).

Prepare first (server-priced), then navigate:

```ts
import { requestPrepareCheckout } from "@openreceive/browser";

const { order_id, summary } = await requestPrepareCheckout({
  body: { cart },
});
```

Without a stable public `orderId` after refresh, the payer can lose the checkout
surface even though payment or a swap refund may still be in progress.

Prefer to create the checkout server-side and hand the snapshot to the component?
Pass `checkout={snapshot}` and an `orderUrl` — see
[Custom Controller Integration](../internal/custom-controller-integration.md).

## Browser helpers

`@openreceive/browser` is the small app-facing browser entry:

- `requestPrepareCheckout({ prefix, body })` — `POST {prefix}/prepare`
- `requestOrderSummary({ prefix, orderId })` — guest resume summary
- `status(invoiceLike)` — display helper (`pending` / `settled` / `expired` / `failed`)
- `lightningUri` / `qrSvg` / `qrPngDataUrl` / `copyInvoice` / `openWallet`

These helpers reject NWC connection strings. `status()` is a display helper —
fulfillment stays in the backend settlement hook. Full package list:
[API Reference](api-reference.md).

## React

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order.id}
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

`onSettled` is a UI hint. Fulfillment stays in the backend settlement hook.

For app-wide theme attributes:

```tsx
import { Checkout, ThemeScope } from "@openreceive/react";

<ThemeScope as="main" className="page" themeToggle>
  <Checkout orderId={order.id} />
</ThemeScope>
```

For a fully custom layout, use `useCheckout({ checkout })` with the packaged
pieces (`QRCode`, `InvoiceSummary`, `CopyInvoiceButton`, `OpenWalletButton`), or
pass `components` / `classNames` / `children` to `Checkout`.

## Framework bindings

| Package | Entry |
| --- | --- |
| `@openreceive/react` | `<Checkout orderId />` |
| `@openreceive/elements` | `<openreceive-checkout order-id>` after `defineOpenReceiveElements()` |
| `@openreceive/vue` | `<Checkout :order-id />` |
| `@openreceive/svelte` | `<Checkout {orderId} />` |
| `@openreceive/angular` | typed shell around the web component; pass `orderId` |

Each package exposes `styles.css` — import the one for your stack.

### Web Components

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

defineOpenReceiveElements();
```

```html
<openreceive-checkout
  order-id="order-123"
  sync-url
  resume-path-prefix="/checkout"
></openreceive-checkout>
```

`sync-url` is optional — only set it when you want the element to push
`/checkout/:orderId`. Events such as `openreceive-settled` are display hints
only.

### Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

defineProps<{ orderId: string }>();
</script>

<template>
  <Checkout :order-id="orderId" :on-settled="showThankYou" />
</template>
```

### Svelte

```svelte
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  export let orderId;
</script>

<Checkout {orderId} onSettled={showThankYou} />
```

### Angular

`@openreceive/angular` provides a thin typed binding around the shared web
component. Pass `orderId` and optional `onSummary` / `onSettled` / `syncUrl`
through the shell options.

### Styling

```ts
import "@openreceive/react/styles.css";
import "@openreceive/elements/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import "@openreceive/angular/styles.css";
```

## Mobile apps

Mobile apps are checkout clients, not NWC wallet backends. They may create an
order through your backend, display BOLT11/QR/status, copy the invoice, open a
Lightning wallet via deep link, and poll status. They must leave
`nwc`, invoice creation, idempotency, payment verification, and
`onPaid` on the server. Native UI kits, when shipped, stay on the same
display-safe side of that boundary.
