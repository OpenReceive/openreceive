This is the full file; follow it from Step 0.

# OpenReceive agent directions (Astro)

```sh
# READ THIS FIRST: this file is 35 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/astro/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to edit .env or run a command to save one.
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.26.

Add OpenReceive to an Astro site — the one you are already working in, on
`@astrojs/node`. OpenReceive ships no Astro package: the integration is one
endpoint, rendered on demand, that hands each request to `@openreceive/http`.
You do not need a copy of the OpenReceive source: the packages are on npm, and
the Astro recipe is appended to this file in full as the quickstart, so you
can do the whole integration without fetching anything. Prefer the published
packages and the handler they export — do not reimplement wallet RPC,
settlement, or pricing.

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
endpoint (`src/pages/openreceive/[...path].ts`, rendered on demand on
`@astrojs/node`) in the application you are editing, issues Lightning
invoices against a wallet the merchant already controls, and calls back into
your code when one settles. There is no OpenReceive account and no API key, and
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

Before anything else, check one file: the project's `.env`, if it exists.
`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1` names the codes
it sets without printing them. Check with that, here and after each write,
not by reading the file, and never print the values. A code that is already
set is not asked for again; if both are set, skip to step 5 (making the
server load the file), then the quickstart.

On a hosted builder (v0, Vercel, Replit, Lovable), the user may say instead
that both codes are already set as the project's environment variables or
secrets. Believe them: do not ask for the codes, do not write `.env`, and
do not read or print the variables. Skip step 5's file loading: the platform already puts them in `process.env`. Do not add them to a compose file or any other deploy config
either: they already reach the app, and a line such as `NWC_URI: ${NWC_URI}`
replaces them with an empty value.

Otherwise your next action is a question to the user. Do not install packages,
edit the app, write `.env.example`, or search anywhere else before asking
it. Do not read deploy config (compose files, Vercel or platform secrets), Docker containers, or process environments, and never run
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
   `NWC_URI=<paste>` into the project's `.env` with your file-editing
   tool, creating the file if needed. Never write it with a shell command
   (`echo`, `printf`, a heredoc, `python -c`): the command line shows the
   code. Make sure `.gitignore` covers `.env` (and `.dockerignore`, if
   the app has one). Never echo the value, commit it, or put it in client
   code. Reply only that it is saved, then ask the next question.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: send it as it is, and do not ask yes
   or no first. Otherwise ask whether payers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same `.env` with the file-editing
   tool, never a shell command. Swaps are now on, so build the refund route
   back (the swap non-negotiable below) as part of this integration. If they
   chose Bitcoin only, leave `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** OpenReceive reads
   `process.env`, and a `.env` file on disk is not in it. `astro dev` reads
   `.env` only for the variables in the app's `env.schema`, so start it with
   `node --env-file=.env node_modules/.bin/astro dev`, and start the built
   server with `node --env-file=.env ./dist/server/entry.mjs`. When the app is
   started with Docker Compose, give the service `env_file: .env`. Never
   declare a code with `context: "client"`, and never give it a `PUBLIC_`
   prefix: either sends it to the browser. Restart the server after writing
   the file.
   Under Compose, recreate the container with `docker compose up -d`:
   `docker compose restart` keeps its old environment.

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

## After the quickstart — hand over, then stop

The quickstart is done when
`npx openreceive doctor --db <file-or-url> --url <app url>` is clean and this
app serves the checkout page for one of its orders. Doctor names any failed
check and exits nonzero; fix it before going on.
Doctor reads `.env` itself. Never source it into a shell: the `&` in a
code splits the value and prints the pieces.

Give the user that checkout link. The browser check of that page
(payment-method icons, wallet logos, a pay tutorial) is theirs: name it in one
line of your closing message, and do not run it yourself.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark an order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay on that link from their own wallet, and `onPaid` marks the order paid.

Setup ends here. Your last message starts "Setup is finished" and has at most
five short lines (about 80 characters each): the link, the methods it offers,
and one line of what to look at. Send nothing after it. Do not list what
changed, copy out the quickstart's browser checklist, offer more work, or end
the message on a question.

- The link is to a real unpaid order. Keep that order; do not delete it.
- When this app's orders belong to a session or cookie, the user's browser
  cannot open the order you made. Then the link is the shop's own page:
  "Open <shop url> and click Buy: it opens the checkout." Do not explain order
  ownership or mention your test order.
- Name the methods it offers: Bitcoin, plus USDT, USDC, ETH and SOL when
  `LSC_URI_PRIMARY` is saved. Do not mention minimums, and never say a coin
  will not work or will not be offered.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the library — not a second order model,
  and not a Prisma/Drizzle relation to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this application. Never read or run anything from another
  project on this machine (its `node_modules`, tools or source), for any
  reason. A browser and Playwright are not part of setup.
- Restart only this app's server, on the port it already uses: stop the
  process you started, or the one listening on that port, by its pid (or
  restart its Compose service). Never `pkill` or `killall` by name: that
  stops other people's servers too. Start it the way this project already
  does (its README, Procfile, compose file or package script), on its own
  port, not a port you pick.
- Run commands where the app runs. When a compose file builds it, run its
  package manager, generators, migrations and doctor inside that service
  (`docker compose exec` or `run`), and rebuild the image after adding a
  package. This machine's language version and database path are not the
  app's.
- To check that the running app sees the codes, run doctor: it reports each
  one as present or missing and never prints a value. Never print the
  environment (`printenv`, `env`, `docker compose config`), even filtered to
  names.
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
  server serves (`/checkout/:reference` — `syncUrl` on `<Checkout>`, `sync-url`
  or `resumable` on `<openreceive-checkout>`), your own order-summary route to
  restore the order from, and the ATTEMPT.
  `/checkouts/prepare` returns no attempts, so a checkout rebuilt from the
  reference alone opens on the method grid. Re-picking the same coin
  (`POST /swaps`) re-serves the committed attempt — but only while it is live,
  and the shadow invoice behind a swap lasts about half an hour, after which the
  same click mints a NEW deposit address and the refund is off-screen. Keep the
  `payment_hash` and reopen the attempt with `POST /swaps/status`, which has no
  such window. On the drop-ins: `resumePaymentHash`, fed from `onState`, on
  `<Checkout>`; the `resume-payment-hash` attribute, fed from the
  `openreceive-state` event (`event.detail.state.payment_hash`), on
  `<openreceive-checkout>`.
  That visit can come hours later, and `authorize` must still know the payer:
  a session that expired in between answers 403 and strands the deposit. On a
  guest shop, tie the order to a long-lived signed cookie, or put a secret
  per-order token in its URL that your page trades for that cookie.
  https://openreceive.org/guides/swap-refunds.md
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
- The handler lives in a module only server code imports, and the stack is
  built on the first request, never at import, so the build never connects to
  the wallet. The endpoint and the checkout page set
  `export const prerender = false` and run on `@astrojs/node`, never an edge
  adapter. The rest of the site may stay static.
- Pass the endpoint's `APIContext` as `native`, so `authorize` reads the
  session the app already has, and give `rateLimiting` `ip: ({ native }) =>
  native.clientAddress`. Behind your own reverse proxy, list your domain in
  `security.allowedDomains`, so Astro reads the payer's address from
  `x-forwarded-for`.
- The checkout is `<openreceive-checkout>` from `@openreceive/elements`, with
  its `styles.css`, on the order's own page: its resumable URL. If the site
  already renders a framework island (React, Vue, Svelte), use that
  framework's package there instead. Astro's origin check refuses cross-site
  form posts; the checkout posts JSON, which it lets through, so leave
  `security.checkOrigin` on.
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
  `context.cookies`, `context.locals.user`, whatever it is. `native` is the
  endpoint's `APIContext`.
  `resource.reference` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **A paid order's page says it is paid and shows no checkout.** Nothing is left
  to pay, and a checkout cannot start a new payment for a paid order. Mount the
  checkout only while the order is unpaid. When it settles on the page, update
  the page's status line from the `openreceive-settled` event on
  `<openreceive-checkout>`: `onPaid` has already
  marked the order paid. Keep that checkout mounted, because it is the payer's
  receipt.
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
- https://openreceive.org/guides/supabase.md — when the database is Supabase: its pooler, its certificate, and locking the tables away from its Data API
- https://openreceive.org/guides/serverless.md — when the app runs serverless (Netlify, AWS Lambda, Cloud Run, Google AI Studio): pooled database URLs, timeouts, and why it needs no cron or worker
- https://openreceive.org/guides/node-orms.md — recipes for Prisma, Drizzle, Knex, TypeORM, Sequelize
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's props, attributes and slots
- https://openreceive.org/guides/mobile-apps.md — when a mobile app takes the payment: the checkout page it opens, and what the App Store and Google Play allow
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
- https://openreceive.org/guides/quickstart-next.md — each hook explained step by step, on Next.js; they are the same here
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/astro-recipe.

## Astro recipe

OpenReceive ships no Astro package. An Astro endpoint takes a Web-standard
`Request` and returns a `Response`, and so does `@openreceive/http`, so the
integration is the route below. Your server code creates each Lightning
invoice, the payment goes straight to your wallet, and payment attempts are
stored in your app's database. There is no OpenReceive account and no
background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `astro` 7.3, `@astrojs/node` 11.1 (standalone)
and `@openreceive/*` 0.4.25. The built app ran on Node in Docker, with
Postgres and a test wallet on a public NWC relay. In Chromium, the buyer's
checkout page showed the Lightning invoice. A stranger got 403 from the
payment routes and 404 from the page, and a request that named its own amount
got 400. When the wallet marked the invoice paid, the page showed it paid and
`onPaid` marked the order paid.

```sh
npx astro add node
npm install @openreceive/http @openreceive/elements pg
```

### Where it runs

On Node, with `@astrojs/node`. The payment route and the checkout page render
on demand (`prerender = false`); the rest of the site can stay static. The
wallet connection and your database driver need Node, so the route cannot run
on an edge runtime. The Vercel and Netlify adapters deploy Node functions:
read Bitcoin checkout on serverless hosts first.
For Cloudflare Workers, the [TanStack Start recipe](https://openreceive.org/guides/tanstack-start-recipe.md#where-it-runs)
explains what a Worker needs. This recipe was not run on those hosts.

### Secrets

Declare them in `astro.config.mjs`. A `secret` is read when the server runs,
never written into the build:

```js
// astro.config.mjs
import { defineConfig, envField } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  adapter: node({ mode: "standalone" }),
  env: {
    schema: {
      NWC_URI: envField.string({ context: "server", access: "secret" }),
      DATABASE_URL: envField.string({ context: "server", access: "secret" }),
    },
  },
});
```

### The payment route

```ts
// src/lib/openreceive.ts
import { createStack, type Stack } from "@openreceive/http";
import type { APIContext } from "astro";
import { NWC_URI } from "astro:env/server";
import { db } from "./db"; // your existing pg Pool
import { findOrder } from "./orders"; // your own orders

let stack: Stack | undefined;

// Built on the first request, not at import, so the build never connects
// to the wallet.
function openReceive(): Stack {
  stack ??= createStack({
    wallet: { nwc: NWC_URI },
    storage: {
      db,
      // Runs once, inside the transaction that records the payment.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ native, resource }) => {
      const context = native as APIContext;
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      return Boolean(order && order.visitor === context.cookies.get("visitor")?.value);
    },
    // The client address the adapter reports.
    rateLimiting: {
      ip: ({ native }) => (native as APIContext).clientAddress,
    },
  });
  return stack;
}

export function handleOpenReceive(context: APIContext): Promise<Response> {
  return openReceive().handler(context.request, { native: context });
}
```

```ts
// src/pages/openreceive/[...path].ts — every route under /openreceive/
import type { APIRoute } from "astro";
import { handleOpenReceive } from "../../lib/openreceive";

export const prerender = false;

export const GET: APIRoute = (context) => handleOpenReceive(context);
export const POST: APIRoute = (context) => handleOpenReceive(context);
```

`native` is the endpoint's `APIContext`, so `authorize` can check the
session your app already has: its cookies, or the user your middleware puts
in `context.locals`. The Next.js quickstart
explains each hook. They are the same here.

One stack serves the whole server process. Astro's origin check refuses
cross-site form posts. The checkout sends JSON, which it lets through.
`clientAddress` is the socket address. Behind your own reverse proxy, list
your domain in `security.allowedDomains`: Astro then takes the payer's
address from `x-forwarded-for` (Rate limiting).

### Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in Node ORM recipes. With Drizzle, pass
the `pg` Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See Payment storage.

### The checkout page

The page needs no UI framework: it uses the `<openreceive-checkout>` element.
With React, Vue or Svelte in your Astro app, the `@openreceive/react`, `vue`
or `svelte` component works as a `client:load` island instead.

```astro
---
// src/pages/checkout/[reference].astro
import "@openreceive/elements/styles.css";
import { findOrder } from "../../lib/orders";

export const prerender = false;

const order = await findOrder(Astro.params.reference ?? "");
if (!order || order.visitor !== Astro.cookies.get("visitor")?.value) {
  return new Response(null, { status: 404 });
}
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Checkout</title>
  </head>
  <body>
    <openreceive-checkout reference={order.id} prefix="/openreceive"></openreceive-checkout>
    <script>
      import { defineElements } from "@openreceive/elements";
      defineElements();
    </script>
  </body>
</html>
```

The element starts the checkout in the browser. The payer picks Bitcoin and
gets the invoice. Keep it at the order's own URL: a payer with a swap deposit
in flight comes back to it (Swap refunds).

### Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL.
- Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)), and
  `LSC_URI_BACKUP`. OpenReceive reads these, and `LOG_LEVEL`, straight from
  `process.env`, not through `astro:env`.

In production, set them all in the server's environment. In development,
`astro dev` reads `.env` for the variables in your schema but keeps the file
out of `process.env`. To try swaps locally, start it with
`node --env-file=.env node_modules/.bin/astro dev`. Never declare them with
`context: "client"`, which would send them to the browser.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
