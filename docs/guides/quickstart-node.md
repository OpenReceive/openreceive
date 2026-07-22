# Node Quickstart

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

## 2. Get payment credentials

| Priority        | What                                                                   | Why                                                           |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Required**    | [NWC code](https://openreceive.org/get_a_nwc_code_to_receive_payments) | Receive Lightning payments into your wallet                   |
| **Recommended** | [Swap provider](https://openreceive.org/set_up_swap_provider)          | Accept USDT, USDC, SOL, and ETH (you still settle to Bitcoin) |

## 3. Configure `openreceive.yml`

Make an `openreceive.yml` in the root of your project.

```sh
touch openreceive.yml
```

Set your NWC code.

```yaml
nwc: nostr+walletconnect://...
```

To accept USDT, USDC, SOL and ETH, add swap providers under `swap:` in the same file:

```yaml
nwc: nostr+walletconnect://...

swap:
  providers:
    - base_url: https://ff.io
      key: ...
      secret: ...
```

See [`openreceive.yml.example`](../../openreceive.yml.example) for all settings and defaults.

## 4. Add OpenReceive to your server

You write **two callbacks**. Everything else (routes, invoices, polling, tokens)
comes from OpenReceive.

| You define                                                             | OpenReceive provides                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `prepareCheckout` — validate cart / order, return the amount to charge | `createOpenReceive`, `openReceiveExpress`, mounted `/openreceive/*` routes |
| `onPaid` — fulfill after settlement (mark paid, ship, email)           | `guestCheckout()` / `withUser()` auth presets                              |
| (browser) call `requestPrepare` then render UI around `<Checkout>`     | `<Checkout>` component                                                     |

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout } from "@openreceive/http";
// Logged-in apps: import { withUser } and pass your session lookup instead of guestCheckout()

// ── YOU DEFINE: price the order (required) ──────────────────────────
// OpenReceive calls this from POST /openreceive/prepare.
async function prepareCheckout({ body }) {
  // Your app code: validate `body` (cart, SKU, tip, …) against your catalog/DB
  // and compute the total with your own decimal money math.
  return {
    amount: { currency: "USD", value: "19.99" }, // required — what to charge
  };
}

// ── YOU DEFINE: fulfill after paid (recommended) ────────────────────
// OpenReceive calls this after backend-verified settlement. May run more than
// once — dedupe on checkoutId (or your order id).
async function onPaid({ orderId, checkoutId, metadata }) {
  // Your app code only — e.g. UPDATE orders SET paid_at = … WHERE id = orderId
  // AND NOT already fulfilled for this checkoutId; then ship / email.
}

const service = await createOpenReceive({ onPaid });

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    prepareCheckout, // ← your function from above
    authorize: guestCheckout(), // ← OpenReceive preset (or withUser(...))
  }),
);
```

`prepareCheckout` must return `amount`. Optionally also return:

| Field     | If you omit it                    | If you set it                                                                                                                                      |
| --------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderId` | OpenReceive mints a UUID          | Use your own order id (string)                                                                                                                     |
| `summary` | Summary route has nothing to show | Any JSON your UI needs after refresh (line items, totals, …). Served at `GET /openreceive/orders/:id/summary` and passed to `<Checkout onSummary>` |

`app.use(openReceiveExpress(...))` adds these routes to your Express app:

- `POST /openreceive/prepare` — runs **your** `prepareCheckout`, persists amount + order id
- `POST /openreceive/checkouts` — create/replay checkout from the prepared amount
- `GET /openreceive/orders/:id/summary` — returns the `summary` you supplied (for UI redraw)

These are openreceive-owned routes. Don't create them manually.

### Request flow

```text
browser POST /openreceive/prepare  { cart }
        → OpenReceive route (from openReceiveExpress)
        → your prepareCheckout({ body })
        → OpenReceive persists amount + order_id (+ optional summary)
        → response { order_id, summary? }

browser renders <Checkout orderId={order_id} />
        → OpenReceive creates/polls checkout from the prepared amount
        → when settled → your onPaid
```

## 5. Prepare from the browser, then render checkout

Call `requestPrepare` (runs your `prepareCheckout` on the server), then pass the
returned `order_id` to `<Checkout>`:

```tsx
import { requestPrepare } from "@openreceive/browser";
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

// YOU: price the cart (hits your prepareCheckout). `cart` is your payload.
const { order_id, summary } = await requestPrepare({ body: { cart } });
setOrder(summary); // your UI state

// OpenReceive: invoice + poll for that order
<Checkout
  orderId={order_id}
  onSummary={(summary) => setOrder(summary)} // YOU: redraw host cart/total
  onSettled={() => {/* YOU: optional UI refresh; fulfillment is onPaid */}}
  onStartOver={() => {/* YOU: send buyer back to cart */}}
/>
```

On refresh, Checkout loads `GET /openreceive/orders/:id/summary` and calls
`onSummary` so your host UI can redraw the cart/total. To also sync the address
bar to `/checkout/:orderId` (History API), pass `syncUrl` (optional
`resumePathPrefix`, default `/checkout`). Capability tokens are minted and
attached for you.

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
