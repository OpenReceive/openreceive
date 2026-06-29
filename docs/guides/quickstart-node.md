# Node Quickstart

OpenReceive runs server-side inside your app. Your app owns orders, carts,
routes, sessions, and fulfillment; OpenReceive creates receive-only Lightning
checkouts and refreshes their settlement state.

## Install And Configure

Install the packages:

```sh
npm install @openreceive/node @openreceive/react
```

Configure OpenReceive with environment variables. Put these in your `.env` file
(or your host's secret manager) — never in client code:

```sh
# .env
OPENRECEIVE_NWC=nostr+walletconnect://...
```

`OPENRECEIVE_NWC` must be a receive-only NWC code and must stay server-side.
For production, also set a durable store:

```sh
# .env
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb
OPENRECEIVE_NAMESPACE=my_app
```

If `OPENRECEIVE_STORE` is omitted locally, OpenReceive uses local SQLite under
`.openreceive/`. The default file is `./.openreceive/default.sqlite3`; use Postgres anywhere; use SQLite only on a durable single-machine filesystem.

## Server

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  // `fulfillPaidCheckout` is your own function. OpenReceive calls it when a
  // checkout settles; you ship the product, grant access, etc.
  onPaid: async ({ order_id, checkout_id, metadata }) => {
    await fulfillPaidCheckout({ order_id, checkout_id, metadata });
  },
});
```

From a controller in your app, create one checkout for an order you already
own. Replace `myOrder` with however your app loads its order:

```ts
// In your own controller / route handler.
const checkout = await openreceive.createCheckout({
  order_id: myOrder.id,
  amount: {
    fiat: { currency: "USD", value: myOrder.total },
  },
  memo: `Order ${myOrder.number}`,
  // Optional: any data you want returned to you on settlement.
  metadata: { cart_version: myOrder.cart_version },
});
```

Invoices always expire after 10 minutes; OpenReceive renews them automatically
while the order stays open, so you never manage expiry yourself.

Add a status endpoint in a controller your app owns. It returns the order from
`getOrder`; the frontend component reads `display_checkout`.

```ts
// In your own controller / route handler.
export async function orderStatus(req, res) {
  const order = await openreceive.getOrder({
    order_id: req.body.order_id,
  });

  res.json({
    ...order,
    order_status: order.paid ? "paid" : "pending_payment",
  });
}
```

## React

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function CheckoutView({ checkout }) {
  return (
    <Checkout
      checkout={checkout}
      statusUrl="/order_status"
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
    status-url="/order_status"
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
  statusUrl="/order_status"
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
  statusUrl="/order_status"
  [onSettled]="reloadOrder"
  [onStartOver]="returnToCart"
></openreceive-angular-checkout>
```

## How Settlement Works

Notifications and frontend events are passive hints. Backend status refresh is
the settlement authority, and settlement requires `settled_at` or a settled
transaction state.

`onPaid` may run more than once. Fulfillment must be idempotent on
`checkout_id` or your own order id. Fulfill from the paid checkout snapshot and
its metadata, not from the live cart.

## Cart Changes

When a cart changes, call `createCheckout` again with the same `order_id` and
the new amount. OpenReceive returns the paid checkout if the order is already
paid, reuses or renews an open checkout when the amount matches, and supersedes
the old open checkout when the amount changes.

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
