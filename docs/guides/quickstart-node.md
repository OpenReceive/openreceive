# Node Quickstart

OpenReceive runs server-side inside your app. Your app owns orders, carts,
routes, sessions, and fulfillment; OpenReceive creates receive-only Lightning
checkouts and refreshes their settlement state.

## Install And Configure

```sh
npm install @openreceive/node @openreceive/react
OPENRECEIVE_NWC=nostr+walletconnect://...
```

`OPENRECEIVE_NWC` must be a receive-only NWC code and must stay server-side.
For production, set a durable store:

```sh
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb
OPENRECEIVE_NAMESPACE=my_app
```

If `OPENRECEIVE_STORE` is omitted locally, OpenReceive uses local SQLite under
`.openreceive/`. The default file is `./.openreceive/default.sqlite3`; use Postgres anywhere; use SQLite only on a durable single-machine filesystem.

## Server

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  onPaid: async ({ order_id, checkout_id, amount_msats, metadata }) => {
    await fulfillPaidCheckout({
      order_id,
      checkout_id,
      amount_msats,
      metadata
    });
  }
});
```

Create one checkout from your own order route:

```ts
export async function createCheckoutForCart(user, cart) {
  const order = await createOrderFromCart(user, cart);
  const checkout = await openreceive.createCheckout({
    order_id: order.uuid,
    amount: {
      fiat: {
        currency: order.total_amount.currency,
        value: order.total_amount.value
      }
    },
    memo: `Order ${order.number}`,
    expires_in_seconds: 600,
    metadata: {
      cart_version: order.cart_version
    }
  });

  return { order, checkout };
}
```

Add an app-owned status endpoint. It returns the order from `getOrder`; the
frontend component reads `display_checkout`.

```ts
export async function orderStatus(req, res) {
  const order = await openreceive.getOrder({
    order_id: req.body.order_id
  });

  res.json({
    ...order,
    order_status: order.paid ? "paid" : "pending_payment"
  });
}
```

For Bitcoin-denominated products, skip price feeds and pass a direct amount:
`{ amount: { btc: { currency: "BTC", value: "0.005" } } }`,
`{ amount: { sats: "7000" } }`, or `{ amount: { msats: "7000000" } }`.

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
