# Node Quickstart

OpenReceive is the payment layer. Your app owns orders, carts, sessions, and
fulfillment. You create an order, mount OpenReceive's routes with a
`resolveOrder` hook that prices it server-side, and drop in `<Checkout orderId />`.

## 1. Install

```sh
npm install openreceive @openreceive/express express react react-dom
```

`@openreceive/express` is an optional peer of the umbrella package (so a
React-only install never pulls the server graph). Checkout components for Vue,
Svelte, and Angular, and adapters for Fastify / Next.js, work the same way —
see [Frontend Checkout](frontend-checkout.md) and [Shipped Routes](routes.md).

## 2. Configure

Copy `openreceive.yml.example` to `openreceive.yml` (git-ignored — it holds secrets):

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...     # receive-only, server-only, never sent to the browser
```

Defaults (override only when you need to):

| Setting | Default |
| --- | --- |
| store | SQLite under `.openreceive/` (`local-sqlite`) |
| route prefix | `/openreceive` |
| capability tokens | minted automatically on create |
| price currencies | `USD` |

Optional: add a FixedFloat `swap:` block to let payers pay with crypto while you
still settle to Lightning — see [Automated Swaps](automated-swaps.md).

## 3. Your app creates the order

OpenReceive ships **no** create-order route. Persist the order in your own DB
first, then pass its id into checkout:

```ts
// Your cart / checkout controller — not OpenReceive.
const order = await db.orders.create({
  id: crypto.randomUUID(),
  total_usd: cart.totalUsd, // authoritative price you computed
  // ...line items, user, etc.
});
```

## 4. Mount the routes

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";

const service = await createOpenReceive({
  // Fires when a checkout settles — ship the product, grant access, etc.
  // May fire more than once: make it idempotent on checkoutId / orderId.
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfillPaidCheckout({ orderId, checkoutId, metadata });
  },
});

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    // Required. The create-checkout route never trusts a client price.
    resolveOrder: async ({ orderId }) => {
      const order = await db.orders.find(orderId);
      if (!order) return null; // → 404
      return { usd: order.total_usd };
    },
  }),
);
```

That mounts create checkout, order status, swap options/actions, and rates under
`/openreceive`. Reads are gated by a per-order capability token — you never
manage it. See [Shipped Routes](routes.md) for auth presets and other adapters.

## 5. Render checkout

```tsx
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order.id} onSettled={reloadOrder} onStartOver={returnToCart} />;
```

The component creates the checkout, renders the invoice + QR, polls status, and
shows the crypto wizard when swaps are configured.

## 6. Fulfill idempotently

`onPaid` may fire more than once. Deduplicate on `checkoutId` (or your order id)
and fulfill from the paid checkout snapshot, not the live cart. Backend status
refresh — not a frontend hint or a Lightning preimage — is the settlement
authority.

Organic traffic advances settlement automatically. Fully idle deployments can
opt into `startSweeper` — see [Settlement Sweeps](settlement-sweeps.md).

## What's next

- [Shipped Routes](routes.md) — route contract, amount authority, Fastify / Next / Rails.
- [Automated Swaps](automated-swaps.md) · [Checkout Retries](checkout-retries.md) ·
  [Frontend Checkout](frontend-checkout.md) · [Security](security.md).
