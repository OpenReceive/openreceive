# Node Quickstart

OpenReceive is the payment layer. On the server you mount its routes and supply
two callbacks: `prepareCheckout` (how much to charge) and `onPaid` (what to do
after settlement). Your frontend POSTs the cart to `/prepare`, then renders
`<Checkout orderId={…} />` with the returned order id.

The Hello Fruit Express demo
(`examples/hello-fruit/server/node-express`) follows this same shape.

## 1. Install

```sh
npm install openreceive @openreceive/express @openreceive/http express react react-dom
```

Install only what you use:

| Stack   | Package                |
| ------- | ---------------------- |
| Express | `@openreceive/express` |
| Fastify | `@openreceive/fastify` |
| Next.js | `@openreceive/next`    |
| React   | `@openreceive/react`   |
| Vue     | `@openreceive/vue`     |
| Svelte  | `@openreceive/svelte`  |
| Angular | `@openreceive/angular` |

See [Frontend Checkout](frontend-checkout.md) and [Authorization](authorization.md).

## 2. Configure

Copy `openreceive.yml.example` to `openreceive.yml` (git-ignored — it holds secrets):

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://... # receive-only, server-only, never sent to the browser
```

Defaults (override only when you need to):

| Setting          | Default                                       |
| ---------------- | --------------------------------------------- |
| store            | SQLite under `.openreceive/` (`local-sqlite`) |
| route prefix     | `/openreceive`                                |
| price currencies | `USD`                                         |

## 3. Configure payment with altcoins

You always settle to Lightning. Many payers cannot (or will not) pay Lightning
directly — they need Solana, Ethereum, Tether, or another asset your swap
provider supports (you can still price the order in USD). Add a swap provider
under `swap:` in the same server-only `openreceive.yml`:

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...

swap:
  providers:
    - id: primary
      protocol: ... # swap provider protocol id
      base_url: ...
      key: ...
      secret: ...
```

No extra app code: once credentials are set, `<Checkout>` lists payable assets
and the mounted routes handle quotes, deposits, and refunds. Leave `key` /
`secret` blank to keep swaps disabled. Never send provider keys to the browser.

Details, lifecycle states, and refunds: [Automated Swaps](automated-swaps.md).

## 4. Add OpenReceive to your server

One Express file: create the service with `onPaid`, mount the shipped router,
and pass `prepareCheckout`. That is the whole server integration.

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
// guestCheckout() — anonymous / no-account sites: anyone can prepare and create;
// Logged-in sites: use withUser(currentUserFromSession, { ownsOrder, isAdmin })
// instead so your session owns the order
import { guestCheckout } from "@openreceive/http";
// fulfillPaidCheckout is a function you define to mark the order paid, ship, email, etc.
import { fulfillPaidCheckout } from "./fulfill-paid-checkout";

const service = await createOpenReceive({
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfillPaidCheckout({ orderId, checkoutId, metadata });
  },
});

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    authorize: guestCheckout(),
    prepareCheckout: async ({ body }) => {
      const cart = validateCart(body); // your domain
      return {
        amount: { currency: "USD", value: cart.totalUsd },
        summary: { id: cart.id, lines: cart.lines }, // optional; returned by GET …/orders/:id/summary
      };
    },
  }),
);
```

That mounts payment HTTP under `/openreceive`, including:

- `POST /openreceive/prepare` — calls your `prepareCheckout`, persists amount + order id
- `POST /openreceive/checkouts` — create/replay checkout from the prepared amount
- `GET /openreceive/orders/:id/summary` — cart/order summary so host UI can redraw after refresh

### What `onPaid` does

`onPaid` is your fulfillment hook. OpenReceive calls it after the payment has
settled.

It may fire more than once (retries, sweeps, concurrent status polls). Deduplicate
on `checkoutId` (or your order id) and fulfill from the paid checkout snapshot,
not the live cart.

### What `prepareCheckout` does

`prepareCheckout` is a **server callback** you pass into `openReceiveExpress`.
It is not a route you write yourself. The mounted `POST /prepare` invokes it
when the browser submits cart/order context.

Validate the cart (or look up your order), return the amount to charge, and
OpenReceive persists it. Create-checkout never trusts an amount from the browser.

- Return `null` → 404
- Throw → 400
- Omit `orderId` and OpenReceive mints a UUID

### Request flow

```text
browser POST /openreceive/prepare  { cart }
        → mounted route
        → prepareCheckout({ body })
        → persist amount + order_id (+ optional summary)
        → response { order_id, summary? }

browser renders <Checkout orderId={order_id} />
        → create/replay checkout from the prepared amount
        → poll status until settled → onPaid
```

## 5. Prepare from the browser, then render checkout

`<Checkout>` does not send the cart or pick the price. Your app calls prepare
first (that hits your `prepareCheckout` hook), then mounts Checkout with the
returned `order_id`:

```tsx
import { requestPrepare } from "@openreceive/browser";
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

// 1. Price the cart on the server → get a stable order id
const { order_id, summary } = await requestPrepare({ body: { cart } });
setOrder(summary);

// 2. Checkout creates/polls the payment for that order
<Checkout
  orderId={order_id}
  onSummary={(summary) => setOrder(summary)}
  onSettled={reloadOrder}
  onStartOver={returnToCart}
/>;
```

After a page refresh, Checkout re-fetches
`GET /openreceive/orders/:id/summary` and calls `onSummary` so your host UI can
redraw the cart/total. That does not change the browser URL. If you also want
Checkout to write `/checkout/:orderId` into the address bar (History API), pass
`syncUrl` (optional `resumePathPrefix`, default `/checkout`) — many apps already
own routing and skip this. Capability tokens are minted and attached for you —
no token to manage.

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
