# Node Quickstart

OpenReceive is the payment layer. You price orders with `prepareCheckout`, fulfill
with `onPaid`, mount the routes, then drop in `<Checkout orderId resume />`.

The Hello Fruit Express demo
(`examples/hello-fruit/server/node-express`) follows this same shape.

## 1. Install

```sh
npm install openreceive @openreceive/express @openreceive/http express react react-dom
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

## 3. Price the order (`prepareCheckout`)

`prepareCheckout` runs on **POST `/prepare`** only. It validates the cart (or
looks up your order), returns the authoritative amount, and OpenReceive persists
it. Create-checkout never trusts a client price.

```ts
const prepareCheckout = async ({ body }) => {
  const cart = validateCart(body); // your domain
  return {
    amount: { currency: "USD", value: cart.totalUsd },
    summary: { id: cart.id, lines: cart.lines }, // optional; returned by GET …/orders/:id/summary
  };
};
```

Return `null` → 404. Throw → 400. Omit `orderId` and OpenReceive mints a UUID.

## 4. Handle payment

`onPaid` fires when a checkout settles. Call YOUR app's fulfillment here.
May fire more than once: make it idempotent on `checkoutId` / `orderId`.

```ts
const onPaid = async ({ orderId, checkoutId, metadata }) => {
  await fulfillPaidCheckout({ orderId, checkoutId, metadata });
};
```

## 5. Mount the routes

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout } from "@openreceive/http";

const service = await createOpenReceive({ onPaid });

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    authorize: guestCheckout(),
    prepareCheckout,
  }),
);
```

That mounts payment HTTP under `/openreceive`, including:

- `POST /openreceive/prepare` — your pricing hook
- `POST /openreceive/checkouts` — create/replay checkout from prepared amount
- `GET /openreceive/orders/:id/summary` — guest resume display payload

For a signed-in app, swap `authorize` for `withUser` instead. See
[Authorization](authorization.md).

## 6. Prepare from the browser, then render checkout

```ts
const { order_id, summary } = await (
  await fetch("/openreceive/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cart }),
  })
).json();
```

```tsx
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  orderId={order_id}
  resume
  onSummary={(summary) => setOrder(summary)}
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>;
```

`resume` fetches `GET /openreceive/orders/:id/summary` after refresh and optionally
syncs `/checkout/:orderId` via the History API. Capability tokens are minted and
attached for you — no token to manage.

## 7. Fulfill idempotently

`onPaid` may fire more than once. Deduplicate on `checkoutId` (or your order id)
and fulfill from the paid checkout snapshot, not the live cart. Backend status
refresh — not a frontend hint or a Lightning preimage — is the settlement
authority.

Organic traffic advances settlement automatically. Fully idle deployments can
opt into `startSweeper` — see [Settlement Sweeps](settlement-sweeps.md).

## What's next

- [Authorization](authorization.md) — presets, prepareCheckout, Fastify / Next / Rails.
- [Automated Swaps](automated-swaps.md) · [Checkout Retries](checkout-retries.md) ·
  [Frontend Checkout](frontend-checkout.md) · [Security](security.md).
