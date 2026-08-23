# Node quickstart

Express + React, receiving Lightning payments. Requires Node ≥ 22 (the workspace
`.nvmrc` and every package's `engines` field).

## 1. Install

```sh
npm install @openreceive/express @openreceive/react
```

Install the adapter for your server and the UI package for your frontend; the
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is the CLI only — `npx openreceive …` below needs no
install. Different stack? Swap the two packages; the rest of this guide is
identical.

|          | Packages                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`                              |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

## 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` emits one schema/migration file for your ORM —
`openreceive_payments` plus `openreceive_meta`, the durable reconcile gate —
and a wiring guide; it never touches a database.
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments)

Then run the emitted migration through your normal workflow (for example
`npx prisma migrate dev`). OpenReceive owns the tables' logic at runtime; there
is nothing else to generate. Details:
[Payment storage](storage.md), [Node ORM recipes](node-orms.md).

## 3. Add wallet credentials

Create a server-only `.env`:

```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments))
   → `NWC_URI`.
2. Optionally set up a swap provider (also covered on
   [openreceive.org](https://openreceive.org))
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code. Boot fails closed if the NWC code also
advertises spend methods such as `pay_invoice`; mint a receive-only code
([Security](security.md)).

## 4. Wire OpenReceive

One factory: your order hooks plus a database handle. The adapter builds the
wallet client and the order bridge; there is no background reconciler —
settlement piggybacks on requests through the durable gate.

```ts
import express from "express";
import { openReceiveExpress } from "@openreceive/express";
import { db, orders, sessions } from "./app.ts"; // your existing database handle and models

const app = express();
app.use(express.json());
const openreceive = openReceiveExpress({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only NWC code; boot fails closed otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ orderId, query }) => {
      // Settlement transaction; runs only for the order's first settled attempt.
      await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
    },
  },
  // Look up one of your orders by id; return null when there is no such order.
  loadOrder: (orderId) => orders.find(orderId),
  // Price that order; OpenReceive converts this into the Lightning invoice.
  amountForOrder: (order) => ({ currency: "USD", value: order.total.toString() }),
  // Your own access check: may this caller do this action to this order?
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(await sessions.currentUser(request), resource.orderId, action),
  // Recommended for public web shops: caps invoice creation at 60 per client IP
  // per hour. Leave it off (the default) for point-of-sale deployments, where
  // many payers share the terminal's IP.
  rateLimiting: true,
});
app.use(openreceive);
// Behind a reverse proxy or load balancer, rate limiting needs the real client
// IP — without this every payer shares the proxy's IP and one abuser can lock
// checkout for everyone: app.set("trust proxy", 1)  (see the rate-limiting guide)
```

The middleware boots lazily (the first request awaits wallet preflight) and
runs the opportunistic reconcile on every OpenReceive request; restarts and
payers who close the page are covered because any later call wins the gate and
settles their invoices. `authorize` runs on every request with
`{ action, request, resource, native }`.
→ [openReceiveExpress](api-reference.md#openreceiveexpress) ·
[authorize context](api-reference.md#the-authorize-context)

`rateLimiting: true` is opt-in on purpose — set it for public web shops, and
leave it off for point-of-sale or any deployment where payers share one IP.
Limits, custom messages, and how counting works: → [Rate limiting](rate-limiting.md)

Composing the pieces yourself — a shared wallet client, a custom payments
repository, or direct handler tests — is fully supported: build them with
`createOpenReceive` and `createOpenReceiveHost`, and pass
`{ service, host, authorize }` to the same adapter.
`maybeReconcileOpenReceivePayments` exposes the same gated settlement pass for
your own routes or middleware.
→ [createOpenReceive](api-reference.md#createopenreceive) ·
[createOpenReceiveHost](api-reference.md#createopenreceivehost) ·
[maybeReconcileOpenReceivePayments](api-reference.md#maybereconcileopenreceivepayments)

Optionally, run one separate worker process with
`startOpenReceiveNotificationWorker({ service, host })`: it subscribes to NWC-02
`payment_received` notifications — authenticated wallet data — and runs a periodic reconcile
pass in the same process. A settled payload settles the matching pending attempt directly
(same finality rule as scans; never a preimage alone); anything less only wakes a scan, and
the worker's own periodic pass is the safety net for notifications missed while it was down.
→ [startOpenReceiveNotificationWorker](api-reference.md#startopenreceivenotificationworker)

Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns `{ order_id }`. OpenReceive never
prices from payer input.

Naming boundary: TypeScript APIs use camelCase fields (`orderId`,
`paymentHash`); everything on the wire — the mounted HTTP routes and the
browser snapshots — is snake_case (`order_id`, `payment_hash`).

## 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout orderId={order_id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself. The compiled `styles.css`
sheets (`@openreceive/react`, `@openreceive/elements`) are self-contained — a
plain `<link rel="stylesheet">` works with no build step.

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.

## 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and swap-provider configuration
without touching a database. → [openreceive doctor](api-reference.md#openreceive-doctor)

## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the library-owned table and state machine
- [Frontend Checkout](frontend-checkout.md) — browser responsibilities
- [Automated Swaps](automated-swaps.md) — `swap_data` and refunds
- [Security](security.md) — server-only secret boundaries

Request flow, retry/concurrency semantics, and direct server checkout are
covered across [Authorization](authorization.md), [Payment storage](storage.md),
and the [API reference](api-reference.md).
