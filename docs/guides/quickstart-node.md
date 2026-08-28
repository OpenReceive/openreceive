# Node quickstart

Express + React. Requires Node ≥ 22.

## 1. Install

```sh
npm install @openreceive/express @openreceive/react
```

Install the adapter for your server and the UI package for your frontend; the
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is the CLI only — `npx openreceive …` below needs no
install. Different stack? Swap the two packages; the rest of this guide is
identical.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/express`, `@openreceive/fastify`, `@openreceive/next`                                                           |
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
2. Optionally set up a [swap provider](https://openreceive.org/set_up_swap_provider)
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code. Your application refuses to start if
the NWC code also advertises spend methods such as `pay_invoice`; mint a
receive-only code ([Security](security.md)).

OpenReceive reads `process.env`; creating a `.env` file is not enough on its
own. How that file (or production secrets) get into the process —
`dotenv` on Express/Fastify, Next.js auto-load, secret managers in
production — is on [Environment variables](environment-variables.md).

## 4. Wire OpenReceive

One factory: your hooks plus a database handle. The adapter builds the
wallet client and the host; there is no background reconciler —
settlement piggybacks on requests through the durable gate.

```ts
import express from "express";
import { openReceiveExpress } from "@openreceive/express";
import { db, orders, sessions } from "./app.ts"; // your existing database handle and models

const app = express();
app.use(express.json());
const openreceive = openReceiveExpress({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only NWC code; your app refuses to start otherwise
  storage: {
    db, // pg Pool/Client, node:sqlite, better-sqlite3, or a custom adapter
    onPaid: async ({ reference, paidAt, query }) => {
      // Settlement transaction; runs only for the first settled attempt for a
      // reference. The WHERE clause is the lock: a second fulfillment path of
      // yours (admin action, replayed job) updates zero rows and does nothing.
      // Use `query` here, not your ORM's other connection. `?` on sqlite, `$1`
      // on postgres.
      const claimed = await query(
        "UPDATE orders SET state = 'paid', paid_at = ? WHERE id = ? AND state = 'awaiting_payment' RETURNING id",
        [paidAt, reference],
      );
      if (claimed.length === 0) return;
    },
  },
  // The price for a reference — here, your order id — from your own data;
  // OpenReceive converts it into the Lightning invoice. Return null when
  // there is nothing to pay for. `value` is a decimal STRING from the order
  // row, never a float and never a request param. `description` is what the
  // payer is buying, in your own words.
  amountFor: async (reference) => {
    const order = await orders.find(reference);
    return order
      ? {
          currency: "USD",
          value: order.total.toString(),
          description: `${order.lines.length} items`,
        }
      : null;
  },
  // Your own access check: may this caller do this action to this reference?
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(
      await sessions.currentUser(request),
      resource.reference,
      action,
    ),
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

The middleware runs wallet preflight lazily (the first request awaits it) and
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
`createOpenReceive` and `createHost`, and pass
`{ service, host, authorize }` to the same adapter.
`maybeReconcilePayments` exposes the same gated settlement pass for
your own routes or middleware.
→ [createOpenReceive](api-reference.md#createopenreceive) ·
[createHost](api-reference.md#createhost) ·
[maybeReconcilePayments](api-reference.md#maybereconcilepayments)

Optionally, run one separate worker process with
`startNotificationWorker({ service, host })`: it subscribes to NWC-02
`payment_received` notifications — authenticated wallet data — and runs a periodic reconcile
pass in the same process. A settled payload settles the matching pending attempt directly
(same finality rule as scans; never a preimage alone); anything less only wakes a scan, and
the worker's own periodic pass is the safety net for notifications missed while it was down.
→ [startNotificationWorker](api-reference.md#startnotificationworker)

Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns the order id the page will pass as
the `reference`. OpenReceive never prices from payer input.

The `reference` is a string you choose, and it is the fulfillment identity:
your order id — one per thing you fulfill, created before checkout, kept
across retries, never reused. OpenReceive never looks inside it, but `onPaid`
runs once per reference, a new checkout under a reference that already
settled is refused with 409, and a fresh id per page load lets one order be
paid twice.

Naming boundary: TypeScript APIs use camelCase fields (`paymentHash`,
`amountMsats`); everything on the wire — the mounted HTTP routes and the
browser snapshots — is snake_case (`payment_hash`, `amount_msats`).

## 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout reference={order.id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself. The compiled `styles.css`
sheets (`@openreceive/react`, `@openreceive/elements`) are self-contained — a
plain `<link rel="stylesheet">` works with no build step.

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
([`examples/buttons/server/node-express`](../../examples/buttons/server/node-express)).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

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
