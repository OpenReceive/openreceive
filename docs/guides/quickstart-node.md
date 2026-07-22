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
| (browser) call `requestPrepareCheckout` then render UI around `<Checkout>` | `<Checkout>` component                                                  |

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

Call `requestPrepareCheckout` (runs your `prepareCheckout` on the server), then
pass the returned `order_id` to `<Checkout>`:

```tsx
import { requestPrepareCheckout } from "@openreceive/browser";
import { Checkout } from "openreceive/react";
import "@openreceive/react/styles.css";

// YOU: price the cart (hits your prepareCheckout). `cart` is your payload.
const { order_id } = await requestPrepareCheckout({ body: { cart } });

// OpenReceive: invoice + poll for that order
<Checkout orderId={order_id} />
```

Everything below is optional.

### Optional: redraw your cart/total UI (`onSummary`)

`requestPrepareCheckout` may return a `summary` (whatever your `prepareCheckout`
returned). On refresh, Checkout also loads `GET /openreceive/orders/:id/summary`
and calls `onSummary` again so your host UI can redraw:

```tsx
import { useState } from "react";

// YOU: your own React state for the cart/total UI
const [order, setOrder] = useState(null);

const { order_id, summary } = await requestPrepareCheckout({ body: { cart } });
setOrder(summary);

<Checkout
  orderId={order_id}
  onSummary={(summary) => setOrder(summary)} // YOU: redraw from `order`
/>
```

### Optional: UI after paid (`onSettled`)

Called with no arguments when the frontend sees settlement. Use it for thank-you
UI or a reload — **fulfillment still belongs in server `onPaid`**:

```tsx
<Checkout
  orderId={order_id}
  onSettled={() => {
    // YOU: show thank-you, navigate, reload order — not ship/fulfill
  }}
/>
```

### Optional: send the buyer back to the cart (`onStartOver`)

```tsx
<Checkout
  orderId={order_id}
  onStartOver={() => {
    // YOU: navigate back to cart / clear checkout UI
  }}
/>
```

### Optional: write `/checkout/:orderId` into the address bar (`syncUrl`)

By default the browser URL stays wherever you already were (e.g. `/cart`).
Checkout still works; you just may not have a shareable `/checkout/…` URL.

Pass `syncUrl` if you want Checkout to update the address bar with the History
API when checkout starts:

```tsx
<Checkout
  orderId={order_id}
  syncUrl // → history.pushState(…, "/checkout/" + order_id)
/>
```

What that does:

- When `<Checkout orderId={…} />` mounts, OpenReceive runs `history.pushState` so
  the address bar becomes `/checkout/<order_id>`
- A full page reload at that URL can show the same checkout again **if your app
  also routes `/checkout/:orderId` to a page that renders `<Checkout orderId={…} />`**
  (`syncUrl` only changes the URL string; it does not register a router route)
- Default path prefix is `/checkout`. Override with `resumePathPrefix`:

```tsx
<Checkout
  orderId={order_id}
  syncUrl
  resumePathPrefix="/pay" // → "/pay/<order_id>"
/>
```

Skip `syncUrl` on Next.js (or any file-based router): pass `routeOrderId` from
the page param instead. Checkout will not call `pushState` when `routeOrderId`
is set — your router already owns the URL.

## Retries and order ids

Payment checkouts can expire. OpenReceive does not silently start a new one
just because time passed or the UI is polling. Show try-again / start-over, then
create again from that user action (Checkout create, or `getOrCreateCheckout`).

- Same order id, already paid → returns the paid checkout.
- Same order id, same amount, still-open checkout → returns that checkout.
- Same order id, amount changed → replaces it with a new checkout.
- Same order id, only expired checkouts left → creates a fresh checkout (fiat
  re-quoted at current rates).
- Different order id → different order; a late payment on an old checkout still
  belongs to the old order.

Status polling never creates checkouts. Fulfillment must be idempotent on
`checkoutId` or your own order id.

## What's next

- [Authorization](authorization.md) — presets, prepareCheckout, Fastify / Next / Rails.
- [Frontend Checkout](frontend-checkout.md) · [Automated Swaps](automated-swaps.md) ·
  [Security](security.md).
