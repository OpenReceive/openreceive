# Node Quickstart

OpenReceive is the payment layer. Your app returns the amount to charge in
`prepareCheckout`, fulfills in `onPaid`, and mounts the routes. Your frontend
renders `<Checkout orderId={…} />`: pass the order id from prepare. Summary
restore on refresh is automatic; add `syncUrl` only if you want Checkout to
push `/checkout/:orderId` itself.

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

## 3. Set the amount (`prepareCheckout`)

`prepareCheckout` runs on **POST `/prepare`** only. Validate the cart (or look
up your order), return the amount to charge, and OpenReceive persists it.
Create-checkout never trusts an amount from the browser.

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

- `POST /openreceive/prepare` — your amount hook
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
  onSummary={(summary) => setOrder(summary)}
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>;
```

Create mode always fetches `GET /openreceive/orders/:id/summary` after refresh
so host UI can redraw. Pass `syncUrl` (and optional `resumePathPrefix`) only if
you want History API URL sync — many apps own routing themselves. Capability
tokens are minted and attached for you — no token to manage.

## 7. Fulfill idempotently

`onPaid` may fire more than once. Deduplicate on `checkoutId` (or your order id)
and fulfill from the paid checkout snapshot, not the live cart. Backend status
refresh — not a frontend hint or a Lightning preimage — is the settlement
authority.

Organic traffic advances settlement automatically. Fully idle deployments can
opt into `startSweeper` — see
[Settlement Sweeps](../internal/settlement-sweeps.md).

## Retries and order ids

Invoices expire. OpenReceive does not mint a replacement just because time
passes or the frontend polls. Show try-again / start-over, then create again
from that user action (mounted create, or `getOrCreateCheckout`).

- Same order id, already paid → returns the paid checkout (no new invoice).
- Same order id, same amount, unexpired open checkout → returns that checkout.
- Same order id, amount changed → supersedes and creates a new checkout.
- Same order id, only expired checkouts left → mints a fresh checkout (fiat
  re-quoted at current rates).
- Different order id → different order; late payment to an old invoice still
  belongs to the old order.

Status polling never mints invoices. Fulfillment must be idempotent on
`checkoutId` or your own order id.

## What's next

- [Authorization](authorization.md) — presets, prepareCheckout, Fastify / Next / Rails.
- [Frontend Checkout](frontend-checkout.md) · [Automated Swaps](automated-swaps.md) ·
  [Security](security.md).
