# Node Quickstart

OpenReceive runs as a server-side service object inside your app. It does not
define the surrounding app boundary or response schema for you. Your app keeps
orders, carts, users, sessions, and fulfillment; OpenReceive creates Lightning
checkouts and refreshes their settlement state.

## Environment

Set a receive-only NWC code only in your server environment:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
```

Storage is optional during local setup. If `OPENRECEIVE_STORE` is omitted and no
managed platform is detected, OpenReceive uses `local-sqlite` and creates
SQLite storage. The default file is `./.openreceive/default.sqlite3`, or
`./.openreceive/<namespace>.sqlite3` when you set `OPENRECEIVE_NAMESPACE`. For
deployment, use Postgres anywhere; use SQLite only on a single durable
mounted-volume instance.

```sh
# Optional locally. Use Postgres for shared production deployments.
OPENRECEIVE_STORE=postgres://user:pass@host:5432/appdb
OPENRECEIVE_NAMESPACE=my_app
```

OpenReceive stores invoice state only. Your app keeps orders, carts, users, and
fulfillment state in your own tables.

## Server Object

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});
```

`onPaid` runs after backend-verified settlement and may run more than once. Use
`orderId` for idempotent fulfillment. When a cart changes and the customer pays
an older checkout, fulfill from `order.paidCheckout`, not from the current cart.

## Create A Checkout

```sh
npm install @openreceive/node
```

```ts
export async function createCheckoutForCart(user, cart) {
  const order = await createOrderFromCart(user, cart);
  const checkout = await openreceive.createCheckout({
    orderId: order.uuid,
    amount: {
      fiat: {
        currency: order.totalAmount.currency,
        value: order.totalAmount.value
      }
    },
    memo: `Order ${order.number}`,
    expiresInSeconds: 600
  });

  return { order, checkout };
}
```

Call this function from the server-side entry point your app already owns.
OpenReceive does not choose that boundary.

For Bitcoin-denominated products, skip price feeds and pass a direct amount:
`{ amount: { btc: { currency: "BTC", value: "0.005" } } }`,
`{ amount: { sats: "7000" } }`, or `{ amount: { msats: "7000000" } }`.

## Refresh Status

```ts
export async function refreshOrderStatus(orderId) {
  const order = await openreceive.getOrder({ orderId });

  return {
    order,
    checkout: order.paidCheckout ?? order.activeCheckout,
    orderStatus: order.paid ? "paid" : "pending_payment"
  };
}
```

`getOrder` performs one bounded backend settlement refresh for unpaid,
unexpired invoices on that order. It uses NWC `list_transactions`, checks at
most 50 wallet transactions in one call, and does not use `lookup_invoice`.

## React

Pass the checkout returned by your server function to the React component:

```tsx
import { Checkout } from "@openreceive/react";

export function CheckoutView({ checkout }) {
  return (
    <Checkout
      invoice={checkout}
      refreshStatus={async (state) => {
        const next = await refreshOrderStatus(state.order_id);
        return next.checkout ?? {};
      }}
      onSettled={() => reloadOrder()}
      onStartOver={() => restartCheckout()}
    />
  );
}
```

`refreshStatus` is your own data-refresh function. You can also omit it and
refresh order state another way.

## Vue

```ts
import {
  createOpenReceiveVueCheckoutBinding
} from "@openreceive/vue";

const binding = createOpenReceiveVueCheckoutBinding(checkout, {
  refreshStatus: async (state) => {
    const next = await refreshOrderStatus(state.order_id);
    return next.checkout ?? {};
  }
});
```

## Svelte

```ts
import {
  createOpenReceiveSvelteCheckoutBinding
} from "@openreceive/svelte";

const binding = createOpenReceiveSvelteCheckoutBinding(checkout, {
  refreshStatus: async (state) => {
    const next = await refreshOrderStatus(state.order_id);
    return next.checkout ?? {};
  }
});
```

## Angular

```ts
import {
  createOpenReceiveAngularCheckoutBinding
} from "@openreceive/angular";
import "@openreceive/angular/checkout-component";

const binding = createOpenReceiveAngularCheckoutBinding(checkout, {
  refreshStatus: async (state) => {
    const next = await refreshOrderStatus(state.order_id);
    return next.checkout ?? {};
  }
});
```

## Optional Scheduler

Notifications are passive hints. Backend status refresh is the settlement
authority. If your app wants background reconciliation, call `getOrder` for
unpaid order ids from your own worker. OpenReceive uses bounded
`list_transactions` scans and never asks the wallet for send-payment methods.
