# Node Quickstart

OpenReceive runs server-side inside your app. Your app owns orders, carts,
routes, sessions, and fulfillment; OpenReceive creates receive-only Lightning
checkouts and refreshes their settlement state.

## Install And Configure

Install the packages:

```sh
npm install @openreceive/node @openreceive/react
```

Configure OpenReceive with `openreceive.yml`. Copy the committed example, then
put private values only in the ignored local file:

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...
OPENRECEIVE_NAMESPACE: my_app
OPENRECEIVE_STORE: local-sqlite
```

`OPENRECEIVE_NWC` must be a receive-only NWC code and must stay server-side.
OpenReceive uses USD fiat quotes by default. To allow more fiat checkout
currencies, add:

```yaml
OPENRECEIVE_PRICE_CURRENCIES:
  - USD
  - EUR
  - GBP
```

For production, set a durable store:

```yaml
OPENRECEIVE_STORE: postgres://user:pass@host:5432/appdb
OPENRECEIVE_NAMESPACE: my_app
```

If `OPENRECEIVE_STORE` is omitted locally, OpenReceive uses local SQLite under
`.openreceive/`. The default file is `./.openreceive/default.sqlite3`; use Postgres anywhere; use SQLite only on a durable single-machine filesystem.

Optional automated swap providers live in the same file, and need no extra app
code — `createOpenReceive()` auto-enables them:

```yaml
swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key: ...
      secret: ...
      invoice_expiry_seconds: 1620
```

See [Automated Swaps](automated-swaps.md) for the provider fields, the payer
flow, and refunds.

## Server

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  // `fulfillPaidCheckout` is your own function. OpenReceive calls it when a
  // checkout settles; you ship the product, grant access, etc.
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfillPaidCheckout({ orderId, checkoutId, metadata });
  },
});
```

Whe you user wants to pay for something, or you want to get an inbound payment: From a controller in your app, create one checkout for an order you already
own. Replace `myOrder` with however your app loads its order:

```ts
// In your own controller / route handler.
async function createCheckoutForCart(myOrder) {
  return await openreceive.getOrCreateCheckout({
    orderId: myOrder.id,
    usd: myOrder.total_amount.value,
    memo: `Order ${myOrder.number}`,
    // Optional arbitrary app-owned JSON returned to your settlement hook.
    metadata: {
      app_context: {
        fulfillment: "digital",
        internal_order_number: myOrder.number,
      },
    },
  });
}
```

Invoices expire. OpenReceive does not create replacement invoices just because
time passes or because the frontend polls status. When an invoice expires, show a
try-again or start-over action and call `getOrCreateCheckout` again from that user
action. See [Checkout Retries](checkout-retries.md) for the exact outcomes when
the order id or amount changes.

Add a status endpoint in a controller your app owns. It returns the order from
`getOrder`; the frontend component reads `display_checkout`.

```ts
// In your own controller / route handler.
export async function orderStatus(req, res) {
  const order = await openreceive.getOrder({
    orderId: req.body.order_id,
  });

  res.json({
    ...order,
    order_status: order.paid ? "paid" : "pending_payment",
  });
}
```

Organic traffic drives settlement sweeps automatically: checkout creation and
`getOrder` each advance at most one globally gated wallet page. If you want
settlement latency that does not depend on traffic, run the optional sweep in a
background task:

```ts
setInterval(() => {
  void openreceive.sweepPendingInvoices();
}, 1000);
```

## React

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function CheckoutView({ checkout }) {
  return (
    <Checkout
      checkout={checkout}
      orderUrl="/order"
      onSettled={reloadOrder}
      onStartOver={returnToCart}
    />
  );
}
```

## Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import "@openreceive/vue/styles.css";

defineProps<{ checkout: unknown }>();
</script>

<template>
  <Checkout
    :checkout="checkout"
    order-url="/order"
    :on-settled="reloadOrder"
    :on-start-over="returnToCart"
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
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>
```

## Angular

```ts
import { CheckoutComponent } from "@openreceive/angular/checkout-component";
import "@openreceive/angular/styles.css";
```

```html
<openreceive-angular-checkout
  [checkout]="checkout"
  orderUrl="/order"
  [onSettled]="reloadOrder"
  [onStartOver]="returnToCart"
></openreceive-angular-checkout>
```

## How Settlement Works

Notifications and frontend events are passive hints. Backend status refresh is
the settlement authority, and settlement requires `settled_at` or a settled
transaction state.

`onPaid` may run more than once. Fulfillment must be idempotent on
`checkoutId` or your own order id. Fulfill from the paid checkout snapshot and
its metadata, not from the live cart.

## Cart Changes

When a cart changes, call `getOrCreateCheckout` again with the same order id and
the new amount. OpenReceive returns the paid checkout if the order is already
paid, reuses an unexpired open checkout when the amount matches, creates a fresh
checkout when an expired checkout is retried, and supersedes the old open
checkout when the amount changes.

Old checkouts remain settlement-watchable. If a superseded checkout is later
paid, `getOrder` exposes it as `paid_checkout` and `display_checkout`.

## Advanced: Web-Component Bindings

The framework packages also expose thin binding helpers for custom element
bridges. Prefer the component examples above unless you need direct access to
attributes and event listeners.

```ts
import { createOpenReceiveVueCheckoutBinding } from "@openreceive/vue";
import { createCheckoutBinding } from "@openreceive/svelte";
import { createOpenReceiveAngularCheckoutBinding } from "@openreceive/angular";
```
