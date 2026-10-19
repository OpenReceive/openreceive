This is the full file; follow it from Step 0.

# OpenReceive agent directions (NestJS)

```sh
# READ THIS FIRST: this file is 43 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/nestjs/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to edit .env or run a command to save one.
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.29.

Add OpenReceive to a NestJS application — the app you are already working in,
on Nest's default Express platform. You do not need a copy of the OpenReceive
source: the packages are on npm, and the quickstart is appended to this file in
full, so you can do the whole integration without fetching anything. Prefer the
published packages and the routes they mount — do not reimplement wallet RPC,
settlement, or pricing, and do not rewrite the routes as a Nest controller.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, a signed-cookie visitor, an in-memory catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's frontend framework, authentication and database. Pick
the UI package that matches the frontend that is already here
(`@openreceive/react`, `/vue`, `/svelte`, `/angular`, or `/elements` for
server-rendered views and plain HTML) — do not add React to a Vue app or to
Handlebars views. Reuse the app's existing session/auth in `authorize` and
its existing database handle (the TypeORM `DataSource`, the Prisma service) in
`storage.db`.

## What OpenReceive is

A payment library that runs inside YOUR server. It mounts HTTP routes in the
application you are editing, issues Lightning invoices against a wallet the
merchant already controls, and calls back into your code when one settles. There
is no OpenReceive account and no API key, and OpenReceive never holds the funds —
the sats land in the wallet the merchant connected.

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
   `NWC_URI=<paste>` into the project's `.env` with your file-editing tool,
   creating the file if needed. Never write it with a shell command (`echo`,
   `printf`, a heredoc, `python -c`): the command line shows the code. Make
   sure `.gitignore` covers `.env` (and `.dockerignore`, if the app has one).
   Never echo the value, commit it, or put it in client code. Reply only that
   it is saved, then ask the next question.
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
   `LSC_URI_PRIMARY=<paste>` to the same `.env` with the file-editing tool,
   never a shell command. Swaps are now on, so build the refund route back
   (the swap non-negotiable below) as part of this integration. If they chose
   Bitcoin only, leave `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** OpenReceive reads
   `process.env`, and a `.env` file on disk is not in it. If `AppModule`
   already imports `ConfigModule.forRoot()` from `@nestjs/config`, that loads
   it. Otherwise put `import "dotenv/config";` first in `src/main.ts`, as the
   quickstart does. When the app is started with Docker Compose, give the
   service `env_file: .env`. Restart the server after writing the file.
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

The quickstart is done when `npx openreceive doctor --db <file-or-url> --url <app url>`
is clean and this app serves the checkout page for one of its orders. Doctor
names any failed check and exits nonzero; fix it before going on.
Doctor reads `.env` itself. Never source it into a shell: the `&` in a
code splits the value and prints the pieces.

Give the user that checkout link. The browser check in the quickstart's step 6
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

- Mount OpenReceive with `app.use(openReceiveExpress(...))` in `src/main.ts`:
  after the app's own session, cookie-parser or Passport middleware, and
  before `app.listen()`. The adapter reads the JSON body itself, so it needs
  no `app.useBodyParser("json")`.
- Nest's guards, interceptors and pipes do not run for middleware. `authorize`
  makes the same ownership check the app's order page makes, by calling the
  service or helper its guard uses. Do not wrap OpenReceive in a controller to
  reach a guard.
- Get the hooks' services with `app.get()`: the order service, and
  `app.get(DataSource)` (TypeORM) or the Prisma service for `storage.db`. Do
  not open a second database connection.

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
- HTTP JSON is snake_case; TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

`npx openreceive scaffold payments --orm typeorm` (or `--orm prisma`) emits
`openreceive_payments` and `openreceive_meta` for THIS application's database.
Register the migration the way the app runs its other migrations. That is the whole
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
  `auth.currentUser(native)`, `native.session`, a cookie, whatever it is.
  Pass `native` (the Express request) to this app's own cookie and session
  helpers, never `request`: that one is a Web Request, a helper that reads
  `req.headers.cookie` or `req.session` finds nothing on it, and every payer
  gets a 403.
  `resource.reference` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **A paid order's page says it is paid and shows no checkout.** Nothing is left
  to pay, and a checkout cannot start a new payment for a paid order. Mount the
  checkout only while the order is unpaid. When it settles on the page, update
  the page's status line from `onSettled` on `<Checkout>`, or the
  `openreceive-settled` event on `<openreceive-checkout>`: `onPaid` has already
  marked the order paid. Keep that checkout mounted, because it is the payer's
  receipt.
- **Pass this app's `db` handle.** Do not add a Prisma/Drizzle relation from
  Order to `openreceive_payments`, and do not implement `PaymentRepository`
  unless no supported handle can reach this database. `reference` is not unique
  (many attempts per order). Fulfillment is a guarded transition on YOUR order
  row inside `onPaid` — `UPDATE … WHERE state = 'awaiting_payment'` (or this
  app's equivalent) through the `query` the library hands you, on that same
  settlement transaction, not a repository or a second connection from your
  ORM. `reference` arrives as a string: convert it when the app's ids are
  numbers. Database writes
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
- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-nestjs.

## NestJS quickstart

NestJS on its default Express platform. Requires Node ≥ 22 and NestJS ≥ 10.

OpenReceive mounts in `main.ts` as Express middleware, with
`@openreceive/express`, the adapter the [Express quickstart](https://openreceive.org/guides/quickstart-node.md)
uses. There is no Nest module to import. Two things differ from a plain
Express app, and this page is about them:

- The hooks reach the app's own services through `app.get()`: the order
  service, and the TypeORM `DataSource` or the Prisma service.
- Guards, interceptors and pipes run for controllers, not for middleware. So
  `authorize` makes the same check your guard makes.

Nest adds its JSON body parser only when the app starts listening, after
anything `main.ts` mounts. From 0.4.27 the adapter reads the body itself, so
the mount needs nothing for it. With 0.4.26 or older, add
`app.useBodyParser("json")` right before the mount, or every checkout answers
500.

### 1. Install

```sh
npm install @openreceive/express @openreceive/http @openreceive/react
```

`@openreceive/express` mounts the routes. `@openreceive/http` supplies the
database handle in step 4 (`typeOrmDb`, `prismaDb`). Swap `@openreceive/react`
for the UI package your frontend uses: `@openreceive/vue`,
`@openreceive/svelte`, `@openreceive/angular`, or `@openreceive/elements` for
server-rendered views. The `openreceive` package is only the CLI, and
`npx openreceive …` below needs no install.

This page is for Nest's default Express platform. OpenReceive has not been
tested on `@nestjs/platform-fastify`.

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
`paymentsSchemaSql(dialect)` from `@openreceive/http`. Your adapter already
pulls that package in, but this import is yours, so install it too:
`npm install @openreceive/http`.

With TypeORM, the scaffold writes
`src/migrations/20260101000000-create-openreceive-tables.ts`. Register it the
way the app registers its other migrations: a `migrations` glob such as
`dist/migrations/*.js` already picks it up. It runs at start with
`migrationsRun: true`, or with `npx typeorm migration:run -d <data source>`.
With Prisma, scaffold with `--orm prisma` and run `npx prisma migrate dev`.

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
its own. If `AppModule` already imports `ConfigModule.forRoot()` from
`@nestjs/config`, that loads `.env` into `process.env` before `main.ts` mounts
OpenReceive. Otherwise put `import "dotenv/config";` first in `main.ts`
(`npm install dotenv`). [Environment variables](https://openreceive.org/guides/environment-variables.md)
covers production secrets.

### 4. Wire OpenReceive in main.ts

One factory call takes your hooks and a database handle. Mount it in
`main.ts`, after the app's own session, cookie or Passport middleware and
before `app.listen()`. There is no background reconciler: settlement runs
during normal requests, through the durable reconcile gate.

```ts
import "dotenv/config"; // drop this line if ConfigModule.forRoot() loads .env
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { openReceiveExpress } from "@openreceive/express";
import { typeOrmDb } from "@openreceive/http";
import type { Request } from "express";
import { DataSource } from "typeorm";
import { AppModule } from "./app.module";
import { AuthService } from "./auth/auth.service"; // your existing services
import { OrdersService } from "./orders/orders.service";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // The app's own app.use(session(...)), cookie-parser or passport.session()
  // stay above the mount, so the session is on the request when authorize runs.
  const orders = app.get(OrdersService);
  const auth = app.get(AuthService);
  app.use(
    openReceiveExpress({
      wallet: { nwc: process.env.NWC_URI! }, // receive-only NWC code; your app refuses to start otherwise
      storage: {
        // The app's TypeORM DataSource. Prisma: prismaDb(app.get(PrismaService), "postgres").
        db: typeOrmDb(app.get(DataSource), "postgres"),
        onPaid: async ({ reference, paidAt, query }) => {
          // Settlement transaction; runs only for the first settled attempt for
          // a reference. The WHERE clause is the lock: a second fulfillment
          // path of yours (admin action, replayed job) updates zero rows. Use
          // `query` here, not a repository: it runs in this same transaction.
          // `$1` on postgres, `?` on sqlite and mysql.
          await query(
            "UPDATE orders SET status = 'paid', paid_at = $1 WHERE id = $2 AND status = 'awaiting_payment'",
            [paidAt, reference],
          );
        },
      },
      // The price for a reference (your order id, as a string) from your own
      // data. `value` is a decimal STRING from the order row, never a float and
      // never a request param. `description` is what the payer is buying.
      amountFor: async (reference) => {
        const order = await orders.findOne(reference);
        return order
          ? {
              currency: "USD",
              value: order.total.toString(),
              description: `${order.lines.length} items`,
            }
          : null;
      },
      // Nest's guards do not run here: make the check your guard makes.
      // `native` is the Express request your session, cookie-parser or
      // Passport middleware already filled in. `request` is a Web Request
      // without any of that, so a helper given it finds no session and every
      // payer gets a 403. `resource.reference` is a claim from the payer's
      // browser, not proof.
      authorize: async ({ action, native, resource }) =>
        orders.viewerMay(await auth.currentUser(native as Request), resource.reference, action),
      // Recommended for public web shops: caps invoice creation at 60 per
      // client IP per hour. Leave it off for point-of-sale deployments, where
      // many payers share the terminal's IP.
      rateLimiting: true,
    }),
  );
  // Behind a reverse proxy, rate limiting needs the real client IP. Delete the
  // line only if the app faces the network directly (see the rate-limiting guide).
  app.set("trust proxy", 1);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

The first request checks the wallet. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered.
→ [openReceiveExpress](https://openreceive.org/guides/api-reference.md#openreceiveexpress) ·
[authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context)

Where `authorize` finds the user:

- **A session** (express-session, or Passport with `passport.session()`):
  `native.session` and `native.user` are there, because their middleware runs
  before the mount.
- **A JWT in a cookie**: verify it the way your guard does, for example with
  `app.get(JwtService).verifyAsync(token)` on the cookie's value.
  `@nestjs/passport`'s `AuthGuard` never runs here, so `native.user` is empty.
- **A bearer token only in browser storage**: the drop-in checkout sends the
  browser's cookies with its requests, not an `Authorization` header. Set an
  httpOnly cookie when the order is created, and check that cookie against
  the order in `authorize`.

`app.setGlobalPrefix()` does not move middleware. The routes stay under
`/openreceive`, the `prefix` the checkout below uses.

An optional worker, `startNotificationWorker({ service, host })`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [startNotificationWorker](https://openreceive.org/guides/api-reference.md#startnotificationworker)

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
Its rules have low specificity, so your page's styles can override checkout
styles. Scoping does not prevent that.

Server-rendered views (Handlebars, EJS, Pug) use the `<openreceive-checkout>`
element from `@openreceive/elements` instead. Serve its standalone script and
stylesheet straight from the package, so there is nothing to build:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

app.useStaticAssets(
  path.dirname(
    fileURLToPath(import.meta.resolve("@openreceive/elements/standalone/openreceive-checkout.js")),
  ),
  { prefix: "/checkout-assets/" },
);
```

In a CommonJS build, the default before Nest 12, use
`path.dirname(require.resolve("@openreceive/elements/standalone/openreceive-checkout.js"))`.
Then, on the order's page:

```html
<link rel="stylesheet" href="/checkout-assets/openreceive-checkout.css">
<script type="module" src="/checkout-assets/openreceive-checkout.js"></script>
<openreceive-checkout reference="{{order.id}}" prefix="/openreceive"></openreceive-checkout>
```

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

The NestJS starter is a runnable one-product shop with all of the above:
TypeORM, sessions, Handlebars views and the element
(`examples/nestjs-starter`). Map its hooks
onto the models in THIS app; do not copy its order model over yours.

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
