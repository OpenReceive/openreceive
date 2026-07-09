# Node Quickstart

OpenReceive is the payment layer. Your app owns orders, carts, sessions, and
fulfillment. Define how orders are priced (`getCheckoutAmount`), what happens
when they settle (`onPaid`), mount the routes, create the order in your app,
then drop in `<Checkout orderId />`.

## 1. Install

```sh
npm install openreceive @openreceive/express express react react-dom
```

Install only what you use:

| Stack | Package |
| --- | --- |
| Express | `@openreceive/express` |
| Fastify | `@openreceive/fastify` |
| Next.js | `@openreceive/next` |
| React | `@openreceive/react` |
| Vue | `@openreceive/vue` |
| Svelte | `@openreceive/svelte` |
| Angular | `@openreceive/angular` |

See [Frontend Checkout](frontend-checkout.md) and [Authorization](authorization.md).

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
| price currencies | `USD` |

Optional: add a FixedFloat `swap:` block to let payers pay with crypto while you
still settle to Lightning — see [Automated Swaps](automated-swaps.md).

## 3. Price the order

`getCheckoutAmount` runs on **create checkout** only (`POST /checkouts`) — not on
GET order status. It is required: the create body never carries a client price.

```ts
const getCheckoutAmount = async ({ orderId }) => {
  const order = await db.orders.find(orderId);
  if (!order) return null; // → 404
  return { amount: { currency: "USD", value: order.total_usd } };
};
```

## 4. Handle payment

`onPaid` fires when a checkout settles. Call YOUR app's fulfillment here
(`fulfillPaidCheckout` is your function — OpenReceive does not provide it).
May fire more than once: make it idempotent on `checkoutId` / `orderId`.

```ts
const onPaid = async ({ orderId, checkoutId, metadata }) => {
  await fulfillPaidCheckout({ orderId, checkoutId, metadata });
};
```

`onPaid` gives you:

- `orderId` — your order (look it up and fulfill it)
- `checkoutId` — this payment attempt. Prefer it for dedupe: `onPaid` can fire
  more than once for the same payment, and a retry after expiry mints a new
  checkout under the same `orderId`
- `metadata` — optional JSON you attached at create time, returned as-is

## 5. Mount the routes

Wire those two hooks into the service and Express adapter:

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";

const service = await createOpenReceive({ onPaid });

const app = express();
app.use(express.json());
app.use(openReceiveExpress({ service, getCheckoutAmount }));
```

That mounts payment HTTP under `/openreceive`. Order reads are gated for you —
you never manage tokens. See [Authorization](authorization.md) for auth presets
and Fastify / Next / Rails mounts.

## 6. Your app creates the order

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

## 7. Render checkout

```tsx
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order.id} onSettled={reloadOrder} onStartOver={returnToCart} />;
```

The component creates the checkout, renders the invoice + QR, polls status, and
shows the crypto wizard when swaps are configured.

## 8. Fulfill idempotently

`onPaid` may fire more than once. Deduplicate on `checkoutId` (or your order id)
and fulfill from the paid checkout snapshot, not the live cart. Backend status
refresh — not a frontend hint or a Lightning preimage — is the settlement
authority.

Organic traffic advances settlement automatically. Fully idle deployments can
opt into `startSweeper` — see [Settlement Sweeps](settlement-sweeps.md).

## What's next

- [Authorization](authorization.md) — presets, amount authority, Fastify / Next / Rails.
- [Automated Swaps](automated-swaps.md) · [Checkout Retries](checkout-retries.md) ·
  [Frontend Checkout](frontend-checkout.md) · [Security](security.md).
