This is the full file; follow it from Step 0.

# OpenReceive agent directions (TanStack Start)

```sh
# READ THIS FIRST: this file is 39 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/tanstack-start/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to edit .env or run a command to save one.
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.27.

Add OpenReceive to a TanStack Start application on Node — the app you are
already working in, with its own Postgres. OpenReceive ships no TanStack
Start package: the integration is one server route that hands each request to
`@openreceive/http`. You do not need a copy of the OpenReceive source: the
packages are on npm, and the TanStack Start recipe is appended to this file in
full as the quickstart, so you can do the whole integration without fetching
anything. Prefer the published packages and the handler they export — do not
reimplement wallet RPC, settlement, or pricing.

On Lovable, or any app on Cloudflare Workers with Supabase, stop here and
follow https://openreceive.org/agent-directions/lovable.md instead. These
directions are for a server you run on Node.

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
server route (`src/routes/openreceive.$.ts`, with GET and POST server
handlers, on Node) in the application you are editing, issues Lightning
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
   `process.env`. `vite dev` loads `.env` into it, but the built server does
   not: start it with `node --env-file=.env .output/server/index.mjs`. When
   the app is started with Docker Compose, give the service `env_file: .env`.
   Never give a code a `VITE_` prefix: that puts it in the browser bundle.
   Restart the server after writing the file.
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
- On Node, build the stack ONCE, on the first request, around the app's
  existing `pg` Pool, in a `.server.ts` module that the route loads with a
  dynamic `import()` (route files are also bundled for the browser). The
  recipe below builds a pool and a stack per request and closes both: that is
  for Cloudflare Workers, which tie a socket to its request. On Node it would
  open a new wallet connection for every request. So, in place of the recipe's
  `handleOpenReceive`:

  ```ts
  // src/lib/openreceive.server.ts — on Node: one stack for the process
  import { createStack, type Stack } from "@openreceive/http";
  import { getRequestIP } from "@tanstack/react-start/server";
  import { db } from "./db.server"; // the app's existing pg Pool

  let stack: Stack | undefined;

  export function handleOpenReceive(request: Request): Promise<Response> {
    stack ??= createStack({
      wallet: { nwc: process.env.NWC_URI ?? "" },
      storage: { db, onPaid }, // onPaid, amountFor, authorize: as in the recipe
      amountFor,
      authorize,
      rateLimiting: { ip: () => getRequestIP() }, // the socket address
    });
    return stack.handler(request, { native: request });
  }
  ```

  Keep the recipe's route file as it is. Skip its On Supabase (Lovable)
  section.
- `authorize` runs inside the request, so the app's own cookie and session
  helpers work there (`getCookie()` from `@tanstack/react-start/server`, or
  the helper its server functions use). `getRequestIP()` is the socket
  address. Behind your own reverse proxy, which sets `x-forwarded-for`, use
  `getRequestIP({ xForwardedFor: true })` instead; never read that header
  without such a proxy, because a client can send it.
- `<Checkout>` comes from `@openreceive/react`, with
  `@openreceive/react/styles.css`, on the order's own page: its resumable URL.
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
  the cookie or session helper its server functions use, given the incoming
  `request`, whatever it is.
  `resource.reference` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **A paid order's page says it is paid and shows no checkout.** Nothing is left
  to pay, and a checkout cannot start a new payment for a paid order. Mount the
  checkout only while the order is unpaid. When it settles on the page, update
  the page's status line from `onSettled` on `<Checkout>`: `onPaid` has already
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
  the dialect you declared: `?` on sqlite and mysql, `$1` on postgres.

### If the database is Supabase

Supabase is Postgres, so the tables above go there like any others. Three
things differ; https://openreceive.org/guides/supabase.md has each in full.

- Connect through its transaction pooler (port `6543`, user
  `postgres.<project-ref>`). Run migrations through the session pooler
  (port `5432` on the same host).
- Verify Supabase's certificate authority: delete `sslmode` from the URL and
  give `pg` `ssl: { ca }`, the text of the project's `prod-ca-2021.crt` (an
  environment variable such as `SUPABASE_CA_CERT`; it is not a secret). Never
  `rejectUnauthorized: false`.
- After the migration, close both tables to Supabase's Data API, or anyone
  with the project's anon key can read `swap_data`:

  ```sql
  alter table openreceive_payments enable row level security;
  alter table openreceive_meta enable row level security;
  revoke all on table openreceive_payments, openreceive_meta from anon, authenticated;
  ```

`npx openreceive scaffold payments --supabase` writes the HTTPS-API route,
which is for Cloudflare Workers only. A Node server uses the connection above.

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

Inlined verbatim so this file needs no network access. On Node, the one-stack module in the non-negotiables above replaces its per-request handleOpenReceive, and its On Supabase (Lovable) section does not apply.
The page it comes from is https://openreceive.org/guides/tanstack-start-recipe.

## TanStack Start recipe

OpenReceive ships no TanStack Start package. A TanStack Start server route
takes a Web-standard `Request` and returns a `Response`, and so does
`@openreceive/http`, so the integration is the route below. Your server code
creates each Lightning invoice, the payment goes straight to your wallet, and
payment attempts are stored in your app's Postgres database. There is no
OpenReceive account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This recipe was checked with `@tanstack/react-start` 1.168 and
`@openreceive/*` 0.4.19. The app was built with Lovable's Vite config for
Cloudflare Workers and run under workerd: a buyer's checkout showed a real
Lightning invoice, and a stranger was refused. The Supabase route below runs
in OpenReceive's CI as a Worker, against Supabase's own Postgres image and
API server: a buyer's invoice, a stranger refused, one live attempt under
concurrent requests, and a payment that `openreceive_on_paid` fulfills once.

```sh
npm install @openreceive/http @openreceive/react pg
```

### Where it runs

- **Node** (the `node-server` preset, or any Node host): any Postgres.
- **Cloudflare Workers** (the `cloudflare-module` preset, Lovable's default):
  with Node compatibility, and a Postgres whose certificate a public
  authority signed, such as Neon.
- **Cloudflare Workers with Supabase**, which is every Lovable app: a Worker
  cannot open a Postgres connection to Supabase, whose certificate comes from
  a private authority. Use [On Supabase](#on-supabase-lovable) below, which
  stores payments through Supabase's HTTPS API instead.

Workers ties every socket to the request that opened it, and forbids network
calls at import. So the route builds its database pool and its OpenReceive
stack inside each request, and closes both before it responds. Each request
then opens its own wallet connection; in our test a checkout request took one
to four seconds. The same code works on Node.

### The payment route

Keep the handler in a `.server.ts` module. Route files are also bundled for
the browser, so the route loads the module only when a request arrives:

```ts
// src/routes/openreceive.$.ts — every route under /openreceive/
import { createFileRoute } from "@tanstack/react-router";

async function openReceive({ request }: { request: Request }): Promise<Response> {
  const { handleOpenReceive } = await import("@/lib/openreceive.server");
  return handleOpenReceive(request);
}

export const Route = createFileRoute("/openreceive/$")({
  server: { handlers: { GET: openReceive, POST: openReceive } },
});
```

```ts
// src/lib/openreceive.server.ts
import { createStack } from "@openreceive/http";
import pg from "pg";
import { findOrder, currentVisitor } from "./orders.server"; // your own orders

export async function handleOpenReceive(request: Request): Promise<Response> {
  // Read process.env inside the handler: on Workers it is empty at import.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const stack = createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: pool,
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
      const order = await findOrder(pool, reference);
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(pool, resource.reference) : undefined;
      const visitor = currentVisitor(incoming);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Cloudflare sets cf-connecting-ip on every request, and a client cannot.
    // On Node behind your own proxy, read the header that proxy sets.
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
    await pool.end();
  }
}
```

`authorize` sees the incoming request with its cookies, so check it with
the session your app already has. The Next.js quickstart
explains each hook. They are the same here.

Create OpenReceive's two tables with your migrations, or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. See Payment storage.

### On Supabase (Lovable)

On Supabase the route keeps payments in your Supabase database through its
HTTPS API, with the project's secret key. There is no `pg` pool. Use
`@openreceive/*` 0.4.24 or newer:

```sh
npm install @openreceive/http @openreceive/react
```

1. Apply the migration from `npx openreceive scaffold payments --supabase`.
   It creates OpenReceive's tables, locked away from the browser's Supabase
   key, and the functions that write them.
2. Replace its placeholder `openreceive_on_paid` with the SQL that marks your
   order paid. It runs inside the transaction that records the payment, for
   the order's first payment only, so a failure there records nothing:

   ```sql
   create or replace function public.openreceive_on_paid(
     p_reference text, p_payment_hash text, p_paid_at bigint
   ) returns void language plpgsql as $$
   begin
     update public.orders set status = 'paid'
      where id = p_reference::uuid and status = 'pending';
   end
   $$;
   ```

3. Write the route's server module:

```ts
// src/lib/openreceive.server.ts
import { createStack } from "@openreceive/http";
import { findOrder, currentBuyer } from "./orders.server"; // your own orders

export async function handleOpenReceive(request: Request): Promise<Response> {
  // Read process.env inside the handler: on Workers it is empty at import.
  // Lovable sets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for server code.
  const stack = createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      supabase: {
        url: process.env.SUPABASE_URL ?? "",
        key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.status === "pending"
        ? { currency: order.currency, value: order.total, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : null;
      const buyer = currentBuyer(incoming);
      return Boolean(order && buyer && order.buyer_token === buyer);
    },
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
  }
}
```

There is no `onPaid`: `openreceive_on_paid` is the fulfillment. `findOrder`
reads the order with your server-side Supabase client; in a Lovable app that
is `supabaseAdmin` from `@/integrations/supabase/client.server`.

The checkout calls the payment routes from the browser with the page's
cookies, and nothing else. A Lovable app keeps its Supabase sign-in in the
browser, not in a cookie, so `authorize` cannot see who is signed in. Give
the buyer a cookie of their own instead: create orders in a server function
that sets an HttpOnly `buyer` cookie (a random value, kept across orders) and
stores the same value on the order as `buyer_token`. `currentBuyer` reads it
back from the request's `cookie` header.

Before it serves, the server checks the database, and the payment routes
answer 503 until the migration is applied and `openreceive_on_paid` is
yours; the log names the fix. More: Supabase over HTTPS.

### The checkout page

```tsx
// src/routes/checkout.$reference.tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/checkout/$reference")({
  component: OrderCheckout,
});

function OrderCheckout() {
  const { reference } = Route.useParams();
  return <Checkout reference={reference} prefix="/openreceive" />;
}
```

It renders on the server and starts the checkout in the browser. The payer
picks Bitcoin and gets the invoice.

### Settings

- `NWC_URI`: a receive-only code from your wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  Optional: `LSC_URI_PRIMARY` for swaps
  ([set one up](https://openreceive.org/set_up_swap_provider)).
- `DATABASE_URL`: your Postgres. On serverless hosts use the pooled URL. The
  storage is tested through a transaction pooler.
- On Supabase over HTTPS, instead of `DATABASE_URL`: `SUPABASE_URL` and the
  secret key in `SUPABASE_SERVICE_ROLE_KEY`. Lovable sets both itself.

Set them as server secrets, never with a `VITE_` prefix, which would put them
in the browser bundle.

No worker or cron job is needed. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request.
