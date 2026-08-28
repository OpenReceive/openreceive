# OpenReceive agent directions (Node.js)

These directions describe OpenReceive 0.3.1.

Add OpenReceive to a Node application — the app you are already working in. You
do not need a copy of the OpenReceive source: the packages are on npm, and the
quickstart is appended to this file in full, so you can do the whole integration
without fetching anything. Prefer the published packages and the routes they
mount — do not reimplement wallet RPC, settlement, or pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, a signed-cookie visitor, an in-memory catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

## What OpenReceive is

A payment library that runs inside YOUR server. It mounts HTTP routes in the
application you are editing, issues Lightning invoices against a wallet the
merchant already controls, and calls back into your code when one settles. There
is no OpenReceive account and no API key, and OpenReceive never holds the funds —
the sats land in the wallet the merchant connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH, SOL or TRX instead, converted into that same
Lightning payment. You supply those credentials and three hooks — `authorize`, `amountFor`,
`onPaid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing packages or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, the process
   env, the deploy config, whatever this app already uses. If the app runs in a
   container the value is in none of those: ask the running process
   (`docker exec <container> printenv NWC_URI`), because finding the NAME in a
   compose file proves nothing about the value. Never print or echo the value
   itself; only report whether it is set. Check for `LSC_URI_PRIMARY` in the
   same pass.
2. If BOTH are already set — the common case in an existing app — say so and go
   straight to the quickstart. Steps 3 and 4 are for an environment that is
   missing one; do not stop to ask about altcoins that are already configured.
   If only `NWC_URI` is set, Bitcoin already works: continue, and raise the
   altcoin question at step 4 rather than blocking on it.
3. If `NWC_URI` is missing or empty, stop and tell the user:

   > OpenReceive cannot issue an invoice without a receive-only NWC code. Get
   > one at https://openreceive.org/get_a_nwc_code_to_receive_payments, set it
   > as `NWC_URI` in this app's server environment, and tell me when it's set.

   Wait for the user. Do not invent a placeholder value and do not continue.
4. If `LSC_URI_PRIMARY` was not already set, ask the user: "Do you want to
   accept altcoins and stablecoins (USDT, USDC, ETH, SOL, TRX) as well as
   Bitcoin?"

   - Yes → send them to https://openreceive.org/set_up_swap_provider for a
     swap-provider (LSC) code, and have them set `LSC_URI_PRIMARY` in the same
     server environment. Wait for them, same as above.
   - No → skip it. Bitcoin over Lightning works with `NWC_URI` alone, and you
     can add a swap provider later without changing application code.
5. Check the environment again and confirm `NWC_URI` is present (plus
   `LSC_URI_PRIMARY` if they asked for altcoins).
6. If OpenReceive is ALREADY installed here, check the installed versions of
   `@openreceive/node` and `@openreceive/browser` against the release named at
   the top of this file. The headless display models below do not exist in
   older versions, and the first tile click throws with nothing saying why.
   Upgrade first.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the library — not a second order model,
  and not a Prisma/Drizzle relation to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- The host owns the price. `amountFor` reads it from your own data; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Read a framework session; never trust a body field.
- `onPaid` must be idempotent. It runs once per `reference` — your order id, one
  per thing you fulfill, created before checkout, kept across retries, never
  reused. A fresh id per page load lets one order be paid twice.
- Receive-only NWC is required; a spend-capable code fails closed at boot unless
  explicitly overridden.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs, and only from the
  `refund_required` provider state. Do not build, promise, or imply a Lightning
  refund path.
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amountFor` and both drop-ins render it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  (It returns no rows while the rail is `checkout_lock` — before the payer has
  chosen anything there is no transaction — so render the caret only when the
  rows are non-empty.)
- HTTP JSON is snake_case; TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

`npx openreceive scaffold payments` emits `openreceive_payments` and
`openreceive_meta` for THIS application's database. That is the whole
persistence OpenReceive needs. It does not replace your orders, users, or
products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<Checkout>` /
  `<openreceive-checkout>`. A fresh id per page load lets one order be paid
  twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amountFor` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `{ currency, value }` as a decimal STRING, plus a `description` of what they
  are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  `sessions.currentUser(request)`, a cookie, whatever it is.
  `resource.reference` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **Pass this app's `db` handle.** Do not add a Prisma/Drizzle relation from
  Order to `openreceive_payments`, and do not implement `PaymentRepository`
  unless no supported handle can reach this database. `reference` is not unique
  (many attempts per order). Fulfillment is a guarded transition on YOUR order
  row inside `onPaid` — `UPDATE … WHERE state = 'awaiting_payment'` (or this
  app's equivalent) through the `query` the library hands you, on that same
  settlement transaction, not a second connection from your ORM. Database writes
  only in the hook; emails, jobs, and pushes after commit. Placeholder style is
  the dialect you declared: `?` on sqlite, `$1` on postgres.

## If you build your own checkout UI

The drop-ins (`<Checkout>`, `<openreceive-checkout>`) already obey all of this.
This list is the short form of https://openreceive.org/guides/checkout-ux.md, for a
UI built on `@openreceive/browser/headless`. Read that before writing
components.

- `createCheckoutController` is the engine. Do not hand-roll a poll loop.
- `createCheckoutStatusModel` for status, and never a Cart → Pay → Done stepper:
  the wire vocabularies are 4, 6 and 12 values, and mostly outcomes.
- `resolveWizardSelection` decides whether to ask "which network?". A
  one-network asset (SOL, ETH) must not be asked — ceremony where there is no
  question teaches the payer to click past USDT, where it is unrecoverable. The
  `selectedAssetByGroup` map it returns and `createMethodGridDisplay` takes is
  keyed by GROUP KEY (`USDT`) and valued by the chosen option's `pay_in_asset`
  (`USDT_TRON`) — not its `network_label`.
- `createMethodGridDisplay` for tiles, including `limitMessage` ("Minimum amount
  $2.71") so an unavailable method says why in the payer's own currency.
- `createSwapDisplayModel` → `display.copyRows` for deposits: address, memo AND
  the bare amount each get a labelled copy row. `swap.networkWarning*` is scoped
  per rail; do not hard-code one banner for every asset.
- `createCheckoutSession` owns the deferred Lightning mint and the swap start,
  with the guards that make both safe to double-click. To start swaps, pass its
  `swap` option — `selection` (five accessors over state you already hold),
  `prefix` and `fetch`, together or not at all. Without it `startSwap` reports
  through `onError` instead of starting anything.
- `createQrSvg` / `createQrPayloadSvg` are ASYNC. Handing the promise straight
  to `dangerouslySetInnerHTML` type-checks and renders `[object Promise]`; use
  `createQrSvgController`, which also drops an encode that lands after the
  payload changed.
- `checkoutLabels` for every payer-facing string. Only write copy it lacks.
- `stageSwapRefund` then `confirmSwapRefund` — two steps, and only the second
  submits. Validate with `getSwapRefundFormError`, and treat `409 CONFLICT` as a
  normal outcome.
- A swap refund needs a URL the payer can come back to. Tell
  `createSwapDisplayModel` whether your checkout has one (`{ resumable: true }`)
  and render `display.refundReturnLabel`: without a per-order route, a payer who
  closes the tab loses the order id and the deposit with it. The resume
  machinery — `createGuestCheckoutResume`, `createGuestOrderFetcher` — is on
  `@openreceive/browser`, not on `/headless`.
- No "Open wallet" button on desktop: it navigates the window that is polling
  for settlement away from the payment.
- Wallet suggestions under the invoice come from `getPaymentWizardRoutes()` +
  `createWizardRouteDisplays` (both on `@openreceive/browser/headless`; the
  registry itself is `@openreceive/provider-data`). Lightning only, present them
  as suggestions, and host the icons yourself via `assetBaseUrl` /
  `asset-base-url` or they break outside Vite. The registry answers ~37 wallets:
  pass `providerPreviewLimit` and build "show all" from
  `display.providerCount`, or they push the QR off the screen.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/node-orms.md — recipes for Prisma, Drizzle, Knex, TypeORM, Sequelize
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's props, attributes and slots
- https://openreceive.org/guides/checkout-ux.md — read before building any custom UI
- https://openreceive.org/guides/headless-checkout.md — the controller, the display models, refunds
- https://openreceive.org/guides/provider-registry.md — where the packaged icons and pay
  tutorials come from, and how to serve them. The asset rule is the one a custom
  UI is most likely to get wrong; this is the page that owns it, not the summary
  in checkout-ux.md
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/price-feeds.md — where the fiat→sats rate comes from, and how to replace it
- https://openreceive.org/guides/host-testing.md — testing your three hooks without a live wallet or provider
- https://openreceive.org/guides/rate-limiting.md — before a public shop goes live
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides/api-reference.md — every route, option and error code
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the shipped adapter's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-node.

## Node quickstart

Express + React. Requires Node ≥ 22.

### 1. Install

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

### 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` emits one schema/migration file for your ORM —
`openreceive_payments` plus `openreceive_meta`, the durable reconcile gate —
and a wiring guide; it never touches a database.
→ [openreceive scaffold payments](https://openreceive.org/guides/api-reference.md#openreceive-scaffold-payments)

Then run the emitted migration through your normal workflow (for example
`npx prisma migrate dev`). OpenReceive owns the tables' logic at runtime; there
is nothing else to generate. Details:
[Payment storage](https://openreceive.org/guides/storage.md), [Node ORM recipes](https://openreceive.org/guides/node-orms.md).

### 3. Add wallet credentials

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
receive-only code ([Security](https://openreceive.org/guides/security.md)).

OpenReceive reads `process.env`; creating a `.env` file is not enough on its
own. How that file (or production secrets) get into the process —
`dotenv` on Express/Fastify, Next.js auto-load, secret managers in
production — is on [Environment variables](https://openreceive.org/guides/environment-variables.md).

### 4. Wire OpenReceive

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
→ [openReceiveExpress](https://openreceive.org/guides/api-reference.md#openreceiveexpress) ·
[authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context)

`rateLimiting: true` is opt-in on purpose — set it for public web shops, and
leave it off for point-of-sale or any deployment where payers share one IP.
Limits, custom messages, and how counting works: → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

Composing the pieces yourself — a shared wallet client, a custom payments
repository, or direct handler tests — is fully supported: build them with
`createOpenReceive` and `createHost`, and pass
`{ service, host, authorize }` to the same adapter.
`maybeReconcilePayments` exposes the same gated settlement pass for
your own routes or middleware.
→ [createOpenReceive](https://openreceive.org/guides/api-reference.md#createopenreceive) ·
[createHost](https://openreceive.org/guides/api-reference.md#createhost) ·
[maybeReconcilePayments](https://openreceive.org/guides/api-reference.md#maybereconcilepayments)

Optionally, run one separate worker process with
`startNotificationWorker({ service, host })`: it subscribes to NWC-02
`payment_received` notifications — authenticated wallet data — and runs a periodic reconcile
pass in the same process. A settled payload settles the matching pending attempt directly
(same finality rule as scans; never a preimage alone); anything less only wakes a scan, and
the worker's own periodic pass is the safety net for notifications missed while it was down.
→ [startNotificationWorker](https://openreceive.org/guides/api-reference.md#startnotificationworker)

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

### 5. Render checkout

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
(`examples/buttons/server/node-express`).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

### 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and swap-provider configuration
without touching a database. → [openreceive doctor](https://openreceive.org/guides/api-reference.md#openreceive-doctor)
