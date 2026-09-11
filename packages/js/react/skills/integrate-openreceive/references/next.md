# OpenReceive agent directions (Next.js)

These directions describe OpenReceive 0.4.6.

Add OpenReceive to a Next.js App Router application — the app you are already
working in. You do not need a copy of the OpenReceive source: the packages are
on npm, and the quickstart is appended to this file in full, so you can do the
whole integration without fetching anything. Prefer the published packages and
the route handlers they export — do not reimplement wallet RPC, settlement, or
pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, a signed-cookie visitor, an in-memory catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's frontend framework, authentication and database. Pick
the UI package that matches the frontend that is already here
(`@openreceive/react`, `/vue`, `/svelte`, `/angular`, or `/elements` for
plain HTML) — do not add React to a Vue app. Reuse the app's existing
session/auth in `authorize` and its existing database handle in `storage.db`.

## What OpenReceive is

A payment library that runs inside YOUR server. It mounts as ONE catch-all
route handler (`app/openreceive/[...openreceive]/route.ts`, on the Node
runtime, `force-dynamic`) in the application you are editing, issues Lightning
invoices against a wallet the merchant already controls, and calls back into
your code when one settles. There is no OpenReceive account and no API key, and
OpenReceive never holds the funds — the sats land in the wallet the merchant
connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH or SOL instead, converted into that same
Lightning payment. You supply those credentials and three hooks — `authorize`, `amountFor`,
`onPaid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing packages or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env.local`, the
   process env, the deploy config, whatever this app already uses. Next loads
   `.env.local` itself: do not add `dotenv`, and never give a credential a
   `NEXT_PUBLIC_` prefix, which inlines it into the browser bundle. If the app runs in a
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
3. If `NWC_URI` is missing or empty, stop and tell the user exactly what to
   create:

   > OpenReceive cannot issue an invoice without a receive-only NWC code. Get
   > one at https://openreceive.org/get_a_nwc_code_to_receive_payments, then
   > put `NWC_URI=<the code>` in this app's server environment — for a Next
   > app that is `.env.local` in the project root — and tell me when it's set.

   Wait for the user before wiring OpenReceive; do not invent a placeholder
   value. Waiting is not idleness: you may write `.env.example` with the
   variable NAMES only (`NWC_URI=`, `LSC_URI_PRIMARY=`) so the merchant has a
   file to copy, and keep building the parts of the host that do not touch
   OpenReceive — the order model, the cart, the routes. The stop guards the
   credential, not the rest of the app.
4. If `LSC_URI_PRIMARY` was not already set, ask the user: "Do you want to
   accept altcoins and stablecoins (USDT, USDC, ETH, SOL) as well as
   Bitcoin?"

   - Yes → send them to https://openreceive.org/set_up_swap_provider for a
     swap-provider (LSC) code, to set as `LSC_URI_PRIMARY` in the same server
     environment. Do NOT wait for it: no application code reads the value, so
     the integration is identical with or without it — the library picks it up
     from the environment and swaps switch on. What a yes DOES change is the
     refund route back (the swap non-negotiable below): build it as part of
     this integration, not when the code arrives.
   - No → skip it. Bitcoin over Lightning works with `NWC_URI` alone, and you
     can add a swap provider later without changing application code.
5. Check the environment again and confirm `NWC_URI` is present.
   `LSC_URI_PRIMARY` may land later; swaps stay off until it does, and no code
   changes when it arrives.
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
- IF YOU TURN SWAPS ON, BUILD THE ROUTE BACK. A deposit that arrives short or
  late becomes `refund_required`, and the payer claims it on a SECOND VISIT,
  after leaving your page to fetch an address from another wallet. Three things
  must exist or that money is unreachable through your UI: a per-order URL your
  server serves (`/checkout/:reference` — `syncUrl` on the drop-ins), your own
  order-summary route to restore the order from, and the ATTEMPT.
  `/checkouts/prepare` returns no attempts, so a checkout rebuilt from the
  reference alone opens on the method grid. Re-picking the same coin
  (`POST /swaps`) re-serves the committed attempt — but only while it is live,
  and the shadow invoice behind a swap lasts about half an hour, after which the
  same click mints a NEW deposit address and the refund is off-screen. Keep the
  `payment_hash` and reopen the attempt with `POST /swaps/status`, which has no
  such window. https://openreceive.org/guides/swap-refunds.md
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amountFor` and both drop-ins render it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<Checkout>` / `<openreceive-checkout>` already render this panel and the
  `description` — these two rules cost you code only on a custom UI or your own
  receipt page, never a reason to replace the drop-in. (It returns no rows
  while the rail is `checkout_lock` — before the payer has chosen anything
  there is no transaction — so render the caret only when the rows are
  non-empty.)
- The route file is a SERVER module and stays on the Node runtime with
  `export const runtime = "nodejs"` and `export const dynamic =
  "force-dynamic"` — never the Edge runtime, never cached. Nothing in it may be
  imported from a client component. `<Checkout>` is a CLIENT component: it
  lives in a `"use client"` file, which also imports `styles.css`. Render it
  at `app/checkout/[reference]/page.tsx`, the order's own resumable URL.
- `rateLimiting` on Next needs an IP source (`trustProxyIpHeader: true` behind
  your own proxy or platform); a web Request has no socket IP and the adapter
  refuses to construct without one.
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
- `createCheckoutStatusModel` for the status line. Do not draw a
  Cart → Pay → Done stepper. Read the model's `phase`, not the snapshot's.
- `resolveWizardSelection` decides whether to ask "which network?". A
  one-network asset starts the swap from the tile. Key `selectedAssetByGroup`
  by group (`USDT`), valued by `pay_in_asset` (`USDT_TRON`).
- `createMethodGridDisplay` for tiles, including `limitMessage` so an
  unavailable method says the minimum in the payer's currency.
- `createSwapDisplayModel` → `display.copyRows` for deposits: address, memo,
  and the bare amount each get a copy row. Render `swap.networkWarning*` as
  the model gives it.
- `createCheckoutSession` owns mint and swap start. To start swaps, pass its
  `swap` option (`selection`, `prefix`, `fetch`) together. Without it
  `startSwap` reports through `onError`.
- `createQrSvg` is async. Use `createQrSvgController` so you do not render
  `[object Promise]`.
- `checkoutLabels` for every payer-facing string. Only write copy it lacks.
- `stageSwapRefund` then `confirmSwapRefund` — only the second submits.
  Validate with `getSwapRefundFormError`. Treat `409` as a normal outcome.
- Pass `{ resumable: true }` to `createSwapDisplayModel` when the payer has
  a URL they can come back to, and render `display.refundReturnLabel`.
  Resume helpers (`createGuestCheckoutResume`, `createGuestOrderFetcher`)
  are on `@openreceive/browser`, not `/headless`.
- A refund replaces the deposit panel. On `refund_required` also drop
  "switch payment method".
- No "Open wallet" button on desktop.
- Wallet suggestions: `getPaymentWizardRoutes()` +
  `createWizardRouteDisplays`. Lightning only. Logos are data URIs; tutorial
  images load from a JavaScript chunk. For a custom headless UI, load it when
  a tutorial opens and look up the returned table by the tutorial's `path`:

  ```js
  import { loadPayTutorialImages } from "@openreceive/browser/headless";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Render `src` as the image source and update your UI after loading. Existing
  display objects do not update: their `tutorial.image` stays `undefined` if
  created before loading. Alternatively, await the loader, recreate the displays
  with `createWizardRouteDisplays`, and render the new `tutorial.image`.
  Show the caption while loading or if loading fails; never use an empty image
  source. Deploy all JavaScript chunks and allow `data:` in CSP `img-src`.
  For missing images, check CSP errors, failed chunks, and stale displays.
  Registry paths are lookup keys; there is no asset option or image route.

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
- https://openreceive.org/guides/provider-registry.md — where the wallet logos and pay
  tutorials come from: inside the JavaScript, nothing to serve. This is the page
  that owns the image rule, not the summary in checkout-ux.md
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it. Read it before you turn swaps on
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
passes. The page it comes from is https://openreceive.org/guides/quickstart-next.

## Next.js quickstart

Next.js App Router + React. Requires Node ≥ 22 and Next ≥ 15 (App Router).

### 1. Install

```sh
npm install @openreceive/next @openreceive/react
```

Install the adapter for your server and the UI package for your frontend; the
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is the CLI only — `npx openreceive …` below needs no
install. Different stack? Swap the two packages; the rest of this guide is
identical.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/next`, `@openreceive/express`, `@openreceive/fastify`                                                           |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Express: [quickstart-node.md](https://openreceive.org/guides/quickstart-node.md) · Fastify:
[quickstart-fastify.md](https://openreceive.org/guides/quickstart-fastify.md). This page is the Next.js one,
and it is where an agent handed the Express guide goes wrong: no `dotenv`, no
`app.use`, a client component for the checkout.

On a fresh project, the App Router is what `create-next-app` scaffolds; no
env loader is needed (Next loads `.env.local` itself). Install your ORM
before step 2 (`npm install prisma @prisma/client` on the Prisma path) —
`openreceive scaffold` emits files for the ORM you name but never installs it.

npm environments that run with `ignore-scripts` (some editor sandboxes) skip
Prisma's engine download and esbuild's binary postinstall, so a typecheck or
build that fails only there is environmental, not a code problem.

### 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` emits one schema/migration file for your ORM
and a wiring guide. It never touches a database.
→ [openreceive scaffold payments](https://openreceive.org/guides/api-reference.md#openreceive-scaffold-payments)

Then run the emitted migration through your normal workflow (for example
`npx prisma migrate dev`). OpenReceive owns the tables' logic at runtime; there
is nothing else to generate. Details:
[Payment storage](https://openreceive.org/guides/storage.md), [Node ORM recipes](https://openreceive.org/guides/node-orms.md).

No ORM? A bare driver handle (`pg`, `node:sqlite`, `better-sqlite3`) is a
supported `db` in step 4, and there is no scaffold flavor for it — execute the
same DDL once yourself with `paymentsSchemaSql(dialect)` from
`@openreceive/http` instead of scaffolding.

### 3. Add wallet credentials

Create a server-only `.env.local` (Next loads it into `process.env` on its
own — do **not** add `dotenv`, and never prefix these with `NEXT_PUBLIC_`,
which would inline them into the browser bundle):

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

In production supply the same variables through your host's secret manager or
process environment; `.env.local` is for development and is gitignored by
`create-next-app`. → [Environment variables](https://openreceive.org/guides/environment-variables.md).

### 4. Wire OpenReceive

One catch-all route file: your hooks plus a database handle. The adapter
builds the wallet client and the host and returns the `GET`/`POST` exports the
App Router expects; there is no background reconciler — settlement piggybacks
on requests through the durable gate, which is what makes it serverless-safe.

```ts
// app/openreceive/[...openreceive]/route.ts
import { openReceiveNextHandlers } from "@openreceive/next";
import { db, orders, sessions } from "@/lib/app"; // your existing database handle and models

// The wallet relay and your database driver need Node, never the Edge runtime,
// and a payment route must never be cached or statically rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = openReceiveNextHandlers({
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
  // `resource.reference` is your own order id, sent back by the payer's
  // browser — a claim, not proof — already validated as a non-empty string.
  // `request` is the Web Request; read cookies or headers from it the way you
  // would in any route handler (`native` is the same NextRequest).
  authorize: async ({ action, request, resource }) =>
    orders.viewerMay(
      await sessions.currentUser(request),
      resource.reference,
      action,
    ),
  // Recommended for public web shops: caps invoice creation at 60 per client IP
  // per hour. A web Request has no socket IP, so on Next this ALSO needs an
  // IP source: `trustProxyIpHeader: true` reads the first hop of
  // x-forwarded-for, which is safe only when YOUR reverse proxy or hosting
  // platform sets it (Vercel, Cloudflare and most load balancers do). Without
  // an IP source the adapter refuses to construct rather than run an
  // inactive limiter. Leave both off for point-of-sale deployments, where
  // many payers share the terminal's IP.
  rateLimiting: true,
  trustProxyIpHeader: true,
});
```

The route file is a **server module** — it imports your database handle and
reads `process.env`, and nothing in it may be imported from a client
component. The default prefix is `/openreceive`, which is the directory the
file sits in; put the catch-all under another directory and pass `prefix` to
match.

When the options are themselves async (a database opened lazily, a wallet
client shared with a worker), build the handlers per request instead of at
module load — the Buy a Button example does exactly this:

```ts
async function handle(request: Request): Promise<Response> {
  const { GET, POST } = openReceiveNextHandlers(await httpOptions());
  return request.method === "GET" ? GET(request) : POST(request);
}
export { handle as GET, handle as POST };
```

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
`authorize` runs on every request.
→ [openReceiveNextHandlers](https://openreceive.org/guides/api-reference.md#openreceivenexthandlers) ·
[authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context)

`rateLimiting: true` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. It is a separate long-lived Node process, not a route — on a serverless
host, skip it and rely on the request-path settlement above.
→ [startNotificationWorker](https://openreceive.org/guides/api-reference.md#startnotificationworker)

Composing the pieces yourself (`createOpenReceive` + `createHost`) is
supported when you need a shared wallet client or a custom repository.
→ [createOpenReceive](https://openreceive.org/guides/api-reference.md#createopenreceive) ·
[createHost](https://openreceive.org/guides/api-reference.md#createhost)

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

`<Checkout>` polls and holds state, so it is a **client component**. Put it in
a file that starts with `"use client"` and import the stylesheet from that
same module; the page that renders it can stay a server component.

```tsx
// app/checkout/[reference]/order-checkout.tsx
"use client";

import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

export function OrderCheckout({ reference }: { reference: string }) {
  return <Checkout reference={reference} prefix="/openreceive" />;
}
```

```tsx
// app/checkout/[reference]/page.tsx — the order's own, resumable URL
import { OrderCheckout } from "./order-checkout";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  return <OrderCheckout reference={reference} />;
}
```

`/checkout/[reference]` is deliberately a page of its own rather than a modal
on the cart: a payer with a swap deposit in flight has no account and no email
from you, so this URL is the only thing that brings them back to their payment
— it has to survive a reload and a bookmark
([Swap refunds](https://openreceive.org/guides/swap-refunds.md)). Do not render the checkout for a
reference the current session may not see; the page can read the session and
404 before it renders, and `authorize` refuses the routes regardless.

The checkout renders, polls, and settles itself. The compiled `styles.css`
sheets (`@openreceive/react`, `@openreceive/elements`) are self-contained and
scoped: every rule applies only inside what OpenReceive renders, so the sheet
is safe next to any CSS framework (Tailwind, Mantine, your own reset) in any
import order. No `transpilePackages` entry is needed; the packages ship plain
ESM.

`<Checkout>` is complete as rendered: it already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to satisfy those rules — they only become your job if you replace the
drop-in ([Checkout UX](https://openreceive.org/guides/checkout-ux.md)).

Match the host page's theme: by default the checkout follows the payer's
stored choice, then the system scheme. If this page is always one theme, lock
it — `<Checkout theme="dark" … />` (`theme` attribute on the custom element) —
so a white card never lands on a dark page. The checkout is styled by CSS
variables under `data-theme`; [Frontend checkout](https://openreceive.org/guides/frontend-checkout.md) has
the knobs.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
(`examples/buttons/server/nextjs-fullstack`).
It has products, visitors, and orders, with the three hooks as the only bridge,
its shop routes as three-line App Router wrappers, and `/checkout/[reference]`
as the resumable page. Map that shape onto the models in THIS app.

### 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and swap-provider configuration,
and probes the wallet relay to confirm the code is receive-only. Add
`--db <file-or-url>` to confirm the migration ran, and
`--url http://localhost:3000` to confirm the routes are mounted; every failing
line states its own fix.
→ [openreceive doctor](https://openreceive.org/guides/api-reference.md#openreceive-doctor)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.
