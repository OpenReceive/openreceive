# Node Quickstart

OpenReceive runs server-side in your app. You own orders, carts, sessions, and
fulfillment. You **mount OpenReceive's routes** and drop in a checkout component — you never
write payment endpoints yourself. Optionally, payers can pay with crypto via automated
swaps while you still settle to Lightning. This is the whole happy path.

## 1. Install

```sh
npm install @openreceive/node @openreceive/express @openreceive/react
```

React and Express are shown here; there are adapters for Fastify and Next.js, and checkout
components for Vue, Svelte, and Angular — see [Frontend Checkout](frontend-checkout.md).

## 2. Configure `openreceive.yml`

Copy `openreceive.yml.example` to `openreceive.yml` (git-ignored — it holds secrets):

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...     # receive-only, server-only, never sent to the browser
OPENRECEIVE_NAMESPACE: my_app
OPENRECEIVE_STORE: local-sqlite                # or postgres://user:pass@host:5432/appdb in production
OPENRECEIVE_PRICE_CURRENCIES: [USD, EUR, GBP]  # USD only by default
```

With no `OPENRECEIVE_STORE` locally, OpenReceive uses SQLite under `.openreceive/`; use
Postgres for production.

## 3. Add automated swaps (optional)

Let payers pay with USDT, SOL, ETH, or USDC while you keep settling to Lightning.
**There is no swap-specific app code — just config:**

1. Create a FixedFloat account at <https://ff.io> and generate an **API key** and
   **secret** in your account's API settings.
2. Add a provider block to `openreceive.yml`:

```yaml
swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key: YOUR_FIXEDFLOAT_KEY
      secret: YOUR_FIXEDFLOAT_SECRET
```

`createOpenReceive()` auto-enables the provider at startup, and the checkout component shows
the "pay with crypto" wizard automatically. Leave `key`/`secret` blank (or omit the `swap`
block) to keep swaps off. See [Automated Swaps](automated-swaps.md) for the supported assets,
refunds, and the state lifecycle.

## 4. Server — mount the routes

Create the service, then mount the router. That is the entire payment backend — no invoice,
status, or swap endpoints to write.

```ts
import express from "express";
import { createOpenReceive } from "@openreceive/node";
import { openReceiveExpress } from "@openreceive/express";

const openreceive = await createOpenReceive({
  // Your own function. OpenReceive calls it when a checkout settles — ship the product,
  // grant access, etc. It may fire more than once, so make it idempotent (see step 6).
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfillPaidCheckout({ orderId, checkoutId, metadata });
  },
});

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service: openreceive,
    // The client can never set the price. You return the authoritative amount for an order.
    resolveAmount: async ({ orderId }) => {
      const order = await loadYourOrder(orderId);
      return { usd: order.total_usd }; // or { sats } / { amount: { fiat: { currency, value } } }
    },
  }),
);
```

That mounts (under `/openreceive` by default): create checkout, read order status, list swap
options, run swap quote/start/refund, list rates. Reads are protected automatically by a
per-order capability token — you never manage it. The default policy allows anonymous checkout
and gates reads by that token; to tie checkouts to your logged-in users instead, pass a preset:
`authorize: withUser((req) => currentUser(req))`. See [Shipped Routes](routes.md).

## 5. Frontend — drop in the component

Pass the order id. The component creates the checkout against the mounted routes, renders the
invoice + QR, polls status, and — when swap providers are configured — shows the "pay with
crypto" wizard. The capability token is handled for you; there is no fetch to write and no token
to pass.

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order.id} onSettled={reloadOrder} onStartOver={returnToCart} />;
```

`prefix` defaults to `/openreceive` (where you mounted the router); pass `prefix="..."` if you
mounted somewhere else. That is the entire frontend.

## 6. Fulfillment

`onPaid` may fire more than once, so make fulfillment idempotent on `checkoutId` (or your own
order id), and fulfill from the paid checkout snapshot and its metadata, not the live cart.
Backend status refresh — not a frontend hint or a Lightning preimage — is the settlement
authority. Organic traffic advances settlement automatically; for latency that does not depend
on traffic, run the sweep on an interval:

```ts
setInterval(() => void openreceive.sweepPendingInvoices(), 1000);
```

## What's next

- [Shipped Routes](routes.md) — the full route contract, tying checkouts to your logged-in
  users, and mounting on Fastify / Next.js / Rails.
- [Automated Swaps](automated-swaps.md) · [Checkout Retries](checkout-retries.md) ·
  [Frontend Checkout](frontend-checkout.md).

## Prefer to call the methods directly?

If you would rather not mount the router, `createOpenReceive()` also returns the service
methods (`getOrCreateCheckout`, `getOrder`, `order`, `sweepPendingInvoices`, …) to call from
your own controllers. The mounted router above is the recommended path because it ships those
routes — and the capability-token protection — for you.
