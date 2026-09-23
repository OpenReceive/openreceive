# OpenReceive agent directions (Fastify)

These directions describe OpenReceive 0.4.11.

Add OpenReceive to a Fastify application — the app you are already working in.
You do not need a copy of the OpenReceive source: the packages are on npm, and
the quickstart is appended to this file in full, so you can do the whole
integration without fetching anything. Prefer the published packages and the
routes the plugin registers — do not reimplement wallet RPC, settlement, or
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

A payment library that runs inside YOUR server. It registers as a Fastify
plugin (`@openreceive/fastify`, prefix passed at `register()`) that serves its
HTTP routes inside the application you are editing, issues Lightning invoices
against a wallet the merchant already controls, and calls back into your code
when one settles. There is no OpenReceive account and no API key, and
OpenReceive never holds the funds — the sats land in the wallet the merchant
connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH or SOL instead, converted into that same
Lightning payment. Step 0 collects those credentials from the user; you write three hooks — `authorize`, `amountFor`,
`onPaid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — ask for the two codes, one question at a time

Before anything else, look at one file: the project's `.env`, if it exists.
Read it only far enough to see whether `NWC_URI` and `LSC_URI_PRIMARY` are
there and non-empty, and never print the values. A code that is already
set is not asked for again; if both are set, skip to step 5
(making the server load the file), then the quickstart.

Otherwise your next action is a question to the user. Do not install packages,
edit the app, write `.env.example`, or search anywhere else before asking
it. Do not read deploy config (compose files, platform secrets), Docker containers, or process environments, and never run
`printenv`. A new shop has neither code yet: hunting for one burns the turn and
can leak other secrets into the transcript.

Two server-only URIs are needed before the quickstart:

- `NWC_URI` — a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY` — a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

The user never edits an environment file. They paste each code into the chat;
you store it. Ask one question per message.

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

   Do not mention `.env`, exports, or "tell me when it's set".
2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the project's `.env`, creating the file if needed.
   Make sure `.gitignore` covers `.env` (and `.dockerignore`, if the app has
   one). Never echo the value, commit it, or put it in client code. Reply only
   that it is saved, then ask the next question.
3. **Second message — swaps.** If the user already asked for stablecoins or
   altcoins, skip the yes/no and go straight to the walkthrough. Otherwise ask
   whether payers should also be able to pay with USDT, USDC, ETH or SOL. The
   walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same `.env`, without echoing it. Swaps
   are now on, so build the refund route back (the swap non-negotiable below) as
   part of this integration. If they chose Bitcoin only, leave
   `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** OpenReceive reads
   `process.env`, and a `.env` file on disk is not in it. Put
   `import "dotenv/config";` at the top of the server entry, as the quickstart
   does. When the app is started with Docker Compose, give the service
   `env_file: .env`. Restart the server after writing the file.

Do not invent placeholder URIs. Start the quickstart only once `NWC_URI` is
saved and `LSC_URI_PRIMARY` is saved or explicitly declined. The first boot
runs the receive-only preflight: if it reports spend methods such as
`pay_invoice`, remove `NWC_URI` from `.env` and ask for a receive-only code
again. Never set the spend-capable override to get past it.

### Upgrading an existing install

This is not the opening move of a new integration. When OpenReceive is ALREADY
installed here, `npx openreceive doctor` reports every credential as set/unset
(never the value) and probes the wallet. Check the installed
`@openreceive/node` and `@openreceive/browser` against the release named at the
top of this file: the headless display models below do not exist in older
versions, and the first tile click throws with nothing saying why. Upgrade
first.

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
- `onPaid` must be idempotent. Its database fulfillment commits once per `reference` — your order id, one
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
- Pass the mount prefix AT `register()` — `fastify.register(openReceiveFastify,
  { …, prefix: "/openreceive" })` — so Fastify scopes the plugin's catch-all to
  it. Do not add a body parser: Fastify parses JSON itself. Behind a reverse
  proxy construct the instance with `Fastify({ trustProxy: true })`, or
  `rateLimiting` counts the proxy as the one payer.
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

- Check Bitcoin → Switch payment method → Bitcoin: the grid must hide the
  Lightning invoice, then restore the same bolt11 without another mint.
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
- `swap.deposit_amount` is the only amount a payer is told to send. Never put
  a fiat valuation of it (`swap.fee.pay_in_fiat`) next to a stablecoin amount:
  "$50.03" under "50.05 USDC" reads as a typo, and the payer asks which one to
  send. The one fiat figure on a USDT/USDC deposit panel is the cart total
  (`payout_fiat`); express "you send" and the fee in the token. Use
  `createSwapFeeBreakdown(fee, swap)` — with the swap, not the fee alone — and
  it applies this for you; SOL and ETH keep a fiat breakdown.
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

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-fastify.

## Fastify quickstart

Fastify + React. Requires Node ≥ 22.

### 1. Install

```sh
npm install @openreceive/fastify @openreceive/react
```

Install the adapter for your server and the UI package for your frontend. The
wallet client, HTTP handler, and contracts come along as dependencies. The
`openreceive` package is only the CLI, and `npx openreceive …` below needs no
install. On a different stack, swap the two packages; the rest of this guide
stays the same.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `@openreceive/fastify`, `@openreceive/express`, `@openreceive/next`                                                           |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Express: [quickstart-node.md](https://openreceive.org/guides/quickstart-node.md) · Next.js:
[quickstart-next.md](https://openreceive.org/guides/quickstart-next.md). This page is the Fastify one.

On a fresh project, also install what this guide assumes you already have: the
framework, a static-file plugin for the checkout page, and an env loader
(`npm install fastify @fastify/static dotenv`). Install your ORM before step 2
too (`npm install prisma @prisma/client` on the Prisma path).
`openreceive scaffold` emits files for the ORM you name, but it never installs
that ORM.

Some editor sandboxes run npm with `ignore-scripts`. That setting skips
Prisma's engine download and esbuild's binary postinstall. If a typecheck or
build fails only in such an environment, the environment is the cause, not
your code.

### 2. Migrate the payment tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

`openreceive scaffold payments` writes one schema or migration file for your
ORM, plus a wiring guide. It never touches a database.
→ [openreceive scaffold payments](https://openreceive.org/guides/api-reference.md#openreceive-scaffold-payments)

Then run the generated migration the way you normally do (for example
`npx prisma migrate dev`). OpenReceive runs the tables' logic at runtime, so
there is nothing else to generate. Details:
[Payment storage](https://openreceive.org/guides/storage.md), [Node ORM recipes](https://openreceive.org/guides/node-orms.md).

No ORM? You can pass a bare driver handle (`pg`, `node:sqlite`,
`better-sqlite3`) as the `db` in step 4. The scaffold has no flavor for it.
Instead of scaffolding, run the same DDL once yourself, using
`paymentsSchemaSql(dialect)` from `@openreceive/http`.

### 3. Add wallet credentials

Create a server-only `.env`:

```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](https://openreceive.org/guides/security.md)).

OpenReceive reads `process.env`, so creating a `.env` file is not enough on
its own. [Environment variables](https://openreceive.org/guides/environment-variables.md) explains how that
file or your production secrets get into the process: `dotenv` on
Express/Fastify, auto-load on Next.js, and secret managers in production.

### 4. Wire OpenReceive

One plugin takes your hooks and a database handle. The plugin builds the
wallet client and the host. There is no background reconciler, meaning no job that checks pending
payments on a timer. Settlement runs during normal requests instead, through
the durable reconcile gate.

Two things are specific to Fastify:

- You pass the mount prefix **at `register()`**, so Fastify scopes the
  plugin's routes to it.
- You add no body parser, because Fastify parses JSON itself.

```ts
import "dotenv/config"; // loads .env into process.env; nothing else does
import Fastify from "fastify";
import { openReceiveFastify } from "@openreceive/fastify";
import { db, orders, sessions } from "./app.ts"; // your existing database handle and models

// Behind a reverse proxy or load balancer, rate limiting needs the real client
// IP — without this every payer shares the proxy's IP and one abuser can lock
// checkout for everyone. The Fastify spelling of Express's "trust proxy";
// drop it only if the app faces the network directly (see the rate-limiting
// guide).
const app = Fastify({ trustProxy: true });

await app.register(openReceiveFastify, {
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
  // `native` is the untouched Fastify request, so a session decorated by
  // @fastify/session (or whatever this app uses) is readable here too.
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
  // The mount. Pass it HERE, at register(), never only inside the options:
  // Fastify scopes the plugin's catch-all route to it, and the OpenReceive
  // routes live directly under it.
  prefix: "/openreceive",
});
```

Register the plugin after whichever plugin gives you sessions or auth
decorations, because `authorize` sees the same request object. The plugin
handles shutdown for you. It registers an `onClose` hook that closes the
wallet client together with the app, so you have no `ready`/`close` pair to
manage. A deploy health check awaits `fastify.ready()` instead.

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
`authorize` runs on every request.
→ [openReceiveFastify](https://openreceive.org/guides/api-reference.md#openreceivefastify) ·
[authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context)

`rateLimiting: true` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [startNotificationWorker](https://openreceive.org/guides/api-reference.md#startnotificationworker)

You can also compose the pieces yourself (`createOpenReceive` + `createHost`)
when you need a shared wallet client or a custom repository.
→ [createOpenReceive](https://openreceive.org/guides/api-reference.md#createopenreceive) ·
[createHost](https://openreceive.org/guides/api-reference.md#createhost)

Your app also needs an ordinary route that creates the order. It validates the
cart, computes the price with exact decimal math, and returns the order id.
The page passes that id as the `reference`. OpenReceive never takes a price
from payer input.

The `reference` is a string you choose, and it identifies what gets fulfilled.
Use your order id. Make it:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

OpenReceive never looks inside the `reference`, but it relies on it:

- `onPaid` commits fulfillment once per reference.
- A new checkout under a reference that already settled is refused with 409.
- A fresh id on every page load would let one order be paid twice.

Naming boundary: TypeScript APIs use camelCase fields (`paymentHash`,
`amountMsats`). Everything on the wire is snake_case (`payment_hash`,
`amount_msats`). The wire means the mounted HTTP routes and the browser
snapshots.

### 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout reference={order.id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself.

`@openreceive/react` and `@openreceive/elements` each ship a compiled
`styles.css`. Each sheet is self-contained, so a plain
`<link rel="stylesheet">` works with no build step. Each is also scoped: every
rule applies only inside what OpenReceive renders.

Serve the compiled `styles.css` without Tailwind processing. Import it from
JavaScript if your bundler handles CSS, or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your app's Tailwind entry.
Its rules have zero specificity, so your page's styles can override checkout
styles. Scoping does not prevent that.

`<Checkout>` is complete as rendered. It already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to show them. The display rules for them become your job only if you
replace the drop-in component ([Checkout UX](https://openreceive.org/guides/checkout-ux.md)).

Match the host page's theme. By default the checkout follows the payer's
stored choice, then the system color scheme. If this page always uses one
theme, lock it with `<Checkout theme="dark" … />`. On the custom element, set
the `theme` attribute. Locking the theme keeps a white card off a dark page.
CSS variables under `data-theme` style the checkout.
[Frontend checkout](https://openreceive.org/guides/frontend-checkout.md) lists the settings you can change.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos, and the pay tutorials. There is no image file to copy
or serve, and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can wait to load tutorial screenshots until a tutorial first opens.
Single-file builds, including the standalone checkout, include them from the
start. If your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

That is the whole loop. Your server owns the price and the order. The payer
gets an invoice. `onPaid` runs inside the settlement transaction. If that
transaction rolls back, the callback may run again. For delivery to outside
systems, use an outbox in your app: record the message in the transaction and
send it after commit.

Buy a Button is a runnable illustration of this boundary
(`examples/buttons/server/fastify`).
It is not a template to copy models from. It has products, visitors, and
orders, and the three hooks are the only bridge to OpenReceive. Its host is
the smallest correct Fastify integration of the packaged checkout. Map that
shape onto the models in THIS app.

### 6. Verify

```sh
npx openreceive doctor
```

`openreceive doctor` checks Node, `NWC_URI`, and the swap-provider
configuration. It also probes the wallet relay to confirm the code is
receive-only. Add `--db <file-or-url>` to confirm the migration ran. Add
`--url http://localhost:3000` to confirm the routes are mounted. Every failing
line states its own fix.
→ [openreceive doctor](https://openreceive.org/guides/api-reference.md#openreceive-doctor)

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render. Open a wallet's pay tutorial to check its screenshots.
If an image is missing, look in the console for CSP violations and in the
Network panel for failed JavaScript chunks. To fix it, allow `data:` in
`img-src` and deploy the complete build output. Do not add image routes or
copy package source images. Do not use registry `icon_path` or tutorial
`path` keys as browser URLs.
