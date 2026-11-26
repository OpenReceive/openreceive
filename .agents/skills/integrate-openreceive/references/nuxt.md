This is the full file; follow it from Step 0.

# OpenReceive agent directions (Nuxt)

```sh
# READ THIS FIRST: this file is 39 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/nuxt/full.md
# If your tool cuts long output, save it and read it in parts: curl -fsSL -o /tmp/openreceive-directions.md https://openreceive.org/agent-directions/nuxt/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user pastes codes here. If you will not take one in chat, ask once for it in .env (Step 0).
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.6.0.

Add OpenReceive to a Nuxt application — the app you are already working in,
on Nitro's `node-server` preset. The integration is the `@openreceive/nuxt`
module: it mounts the payment routes and registers the checkout component,
and you write the three hooks in `server/openreceive.ts`. You do not need a
copy of the OpenReceive source: the packages are on npm, and the Nuxt
quickstart is appended to this file in full, so you can do the whole
integration without fetching anything. Prefer the published packages and the
module — do not write the payment route by hand, and do not reimplement
wallet RPC, settlement, or pricing.

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
server route (registered by `@openreceive/nuxt`, on Nitro's
`node-server` preset) in the application you are editing, issues Lightning
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
set is not asked for again; if both are set, make sure `.gitignore` covers
`.env` (and `.dockerignore`, made if a Dockerfile copies the app), then skip to step 5
(making the server load the file), then the quickstart.

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

Ask the user to paste each code into the chat, and store it yourself. Ask one
question per message. If you will not take a code pasted in chat, end that same
message with this in place of "Paste the code here": "Add `NWC_URI=<your code>`
to `.env` in this project, then reply saved." (`LSC_URI_PRIMARY` for the swap
code.) Name the real path and a placeholder, never a value. On "saved", check
by name and go on. Ask once per code: if it is still unset, do not ask again;
say which line in which file is missing, and stop.

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

   Do not mention `.env`, exports, or "tell me when it's set", except as the
   fallback above says.
2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the project's `.env` with your file-editing
   tool, creating the file if needed. Never write it with a shell command
   (`echo`, `printf`, a heredoc, `python -c`): the command line shows the
   code. Make sure `.gitignore` covers `.env` (and `.dockerignore`, made if a Dockerfile copies the app). Never echo the value, commit it, or put it in client
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
   `LSC_URI_PRIMARY=<paste>` to the same `.env` with the file-editing tool,
   never a shell command. Swaps are now on, so build the refund route back (the
   swap non-negotiable below) as part of this integration. A guest shop also
   needs a secret to sign the payer's long-lived cookie: if `.env` sets no
   `SESSION_SECRET` (check by name), add one with
   `printf '\nSESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env`, which
   makes it in the shell and never shows it. An app that already signs its
   cookies keeps its own secret. If they chose Bitcoin only, leave
   `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** OpenReceive reads
   `process.env`. `nuxt dev` loads `.env` into it, but the built server does
   not: start it with `node --env-file=.env .output/server/index.mjs`. When
   the app is started with Docker Compose, give the service `env_file: .env`.
   Never copy a code into `runtimeConfig.public` or a `NUXT_PUBLIC_` variable:
   both go to the browser. Restart the server after writing the file.
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
- When an `LSC_URI_*` code is saved, one line sends the user to
  https://openreceive.org/guides/rate-limiting#if-you-take-coin-payments:
  limits per payer on coin payments are their app's to add from it. Do not
  build them.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the library — not a second order model,
  and not a Prisma/Drizzle relation to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- After a production build, run `npx openreceive doctor --scan-build .output/public`. Never grep a build for a code.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this application. Never read or run anything from another
  project on this machine (its `node_modules`, tools or source), for any
  reason. A browser and Playwright are not part of setup.
- The project's own rules (its `AGENTS.md`, contributing guide) win over these
  directions. If one forbids a step here, such as running migrations, ask the
  owner and wait for the answer, even if doctor cannot pass yet. Do not move
  the step somewhere the rule does not name, such as app startup.
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
  payer-supplied amounts. A donation is no exception: its amount is saved
  by your own route first (Donations, below).
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
  late becomes `refund_required`, and the payer claims it on a later visit,
  often hours later, after fetching an address from another wallet. The
  quickstart below has the code: the checkout on the order's own page with
  `resumable`, and the swap's `payment_hash` saved on your order row (never
  browser storage) and handed back as `resumePaymentHash`
  (`resume-payment-hash` on the element). Re-picking the coin is no substitute:
  after about half an hour it mints a NEW deposit address. `authorize` must
  still know the payer on that visit: on a guest shop, a long-lived cookie
  signed with the app's own secret (Step 0), never a wallet or swap code.
  https://openreceive.org/guides/swap-refunds.md
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amountFor` and both drop-ins render it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record, collapsed behind a caret, on the live
  checkout AND on your own receipt page: a payment hash and a deposit txid are
  their only evidence that they paid you. The drop-ins already render it and
  the `description`, so this costs code only on a custom UI or a receipt page,
  never a reason to replace the drop-in. Build it with
  `createTransactionDetails(...)`, or `renderTransactionDetailsHtml` with no
  bundler (the standalone file has no `createTransactionDetails`, and one bad
  import stops the whole page), and render the caret only when it returns rows.
- `@openreceive/nuxt` goes in `modules` in `nuxt.config.ts`, and the hooks
  in `server/openreceive.ts`, as the default export of `defineOpenReceive`
  from `@openreceive/nuxt/server`. Do not add a payment route of your own
  under `server/routes/` or `server/api/`: the module mounts them, and the
  app runs on Node — never an edge preset. The module builds the stack on
  the first request, so the build and prerendering never connect to the
  wallet.
- `native` in `authorize` is the request's `H3Event`, so `authorize` reads
  the session the app already has (`getCookie(native, …)`, the user its
  session module reads from the event). `rateLimiting` counts the socket
  address; add `trustProxyIpHeader: true` only behind your own reverse proxy,
  which sets `x-forwarded-for`.
- The checkout is `<OpenReceiveCheckout>`, registered by the module with its
  stylesheet: no import, on the order's own page, its resumable URL. Do not
  pass it a `prefix`: it follows the module's.
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
- **Donations and pay-what-you-want are fine.** The amount is the payer's
  choice, so it enters through YOUR route, never OpenReceive's: the donate form
  posts it to your own handler, which checks it and saves it on a new donation
  row, made like an order. That row's id is the `reference`, and `amountFor`
  reads the amount from the row, as it does for an order. Check it in that
  handler: a floor and a cap ($1 and $10,000 unless the owner gave others) and
  at most two decimal places. Refuse an amount outside them with a message;
  never round it. Small amounts may be Lightning-only for some coins: the
  checkout says which coins an amount is too small for.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  `getCookie(event, …)`, the user its session module reads from the event,
  whatever it is. `native` is the request's `H3Event`.
  `resource.reference` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **A paid order's page says it is paid and shows no checkout.** Nothing is left
  to pay, and a checkout cannot start a new payment for a paid order. Mount the
  checkout only while the order is unpaid. When it settles on the page, update
  the page's status line from `@settled` on `<Checkout>`: `onPaid` has already
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
- `resolveWizardSelection` decides whether to ask "which network?". A tile
  only selects: show the amount with `session.quoteSwap`, and call
  `startSwap` from Continue. Key `selectedAssetByGroup` by group (`USDT`),
  valued by `pay_in_asset` (`USDT_TRON`).
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
- No "Open wallet" or "Pay in wallet" button, and no `lightning:` link. Cash
  App cancels an invoice opened from a link and pays the same invoice scanned
  or pasted. Show the QR code and a Copy invoice button.
- Wallet suggestions: `getPaymentWizardRoutes()` +
  `createWizardRouteDisplays`. Lightning only. Logos are data URIs. Tutorial
  images come from `loadPayTutorialImages()` when a tutorial opens (show the
  caption until then), never from an image route or a registry path
  (https://openreceive.org/guides/headless-checkout.md). Pass
  `providerPreviewLimit` and build "show all" from `display.providerCount`,
  or ~37 wallets push the QR off the screen.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/supabase.md — when the database is Supabase: its pooler, its certificate, and locking the tables away from its Data API
- https://openreceive.org/guides/serverless.md — when the app runs serverless (Netlify, AWS Lambda, Cloud Run, Google AI Studio): pooled database URLs, timeouts, and when a scheduled pass helps
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
- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-nuxt.

## Nuxt quickstart

Nuxt 4 + Vue, with the `@openreceive/nuxt` module. Your server code creates
each Lightning invoice, the payment goes straight to your wallet, and payment
attempts are stored in your app's database. There is no OpenReceive account
and no background worker. Requires Node ≥ 22 and Nuxt 4 on Nitro's
`node-server` preset.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

The module registers what you would otherwise write by hand: one server route
for every payment path under `/openreceive/`, and `<OpenReceiveCheckout>`, the
`@openreceive/vue` checkout with its stylesheet. You write three hooks in
`server/openreceive.ts` and the checkout page.

`@openreceive/nuxt` is tested on Nuxt 4.7 (Nitro 2, h3 1.15) in a built app
run as `node .output/server/index.mjs`, on SQLite, with a test wallet on a
local relay. In Chromium, the buyer's checkout page started the checkout once,
under the module's prefix, both after a client-side navigation and on a
direct load. A stranger got 403 from the payment routes and 404 from the page,
and a request that named its own amount got 400. When the wallet marked the
invoice paid, `onPaid` marked the order paid.

### 1. Install

```sh
npm install @openreceive/nuxt pg
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
});
```

`pg` is for Postgres. With SQLite you need no driver package: `node:sqlite`
comes with Node 22.13 and newer. The wallet client, the HTTP handler and the
Vue checkout come along as dependencies of the module. The `openreceive`
package is only the CLI, and `npx openreceive …` below needs no install.

The module's options, all optional:

```ts
export default defineNuxtConfig({
  modules: ["@openreceive/nuxt"],
  openreceive: {
    prefix: "/openreceive", // where the payment routes are mounted
    config: "server/openreceive", // the file with your hooks
    css: true, // add @openreceive/vue/styles.css to every page
  },
});
```

`<OpenReceiveCheckout>` uses the same `prefix`, so the page and the routes
cannot disagree.

### Where it runs

On Node, with Nitro's default `node-server` preset. The wallet connection and
your database driver need Node, so the routes cannot run on an edge runtime.
The Vercel, Netlify and AWS Lambda presets deploy Node functions: read
[Bitcoin checkout on serverless hosts](https://openreceive.org/guides/serverless.md) first. For Cloudflare
Workers, the [TanStack Start recipe](https://openreceive.org/guides/tanstack-start-recipe.md#where-it-runs)
explains what a Worker needs. The module was not run on those hosts.

### 2. Your database

`db` is a `pg` Pool, `node:sqlite` or `better-sqlite3`, or one of the
adapters in [Node ORM recipes](https://openreceive.org/guides/node-orms.md). With Drizzle, pass the `pg`
Pool underneath it.

Create OpenReceive's two tables with your migrations
(`npx openreceive scaffold payments --orm <your orm>`), or run
`paymentsSchemaSql("postgres")` from `@openreceive/http` once. It is
idempotent. The module pulls that package in, but this import is yours, so
install it too: `npm install @openreceive/http`. See
[Payment storage](https://openreceive.org/guides/storage.md).

### 3. Credentials

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

Add `DATABASE_URL` for your Postgres; on serverless hosts use the pooled URL.

The routes read the codes from `process.env` when the first request arrives.
`nuxt dev` loads `.env` into `process.env`. The built server does not: start
it with `node --env-file=.env .output/server/index.mjs`, or set the variables
in the server's environment. Do not copy them into `runtimeConfig.public`, or
a `NUXT_PUBLIC_` variable, which go to the browser.

### 4. Your hooks

The module reads them from `server/openreceive.ts`. Nuxt auto-imports the h3
helpers and everything in `server/utils/` there, as in any server file:

```ts
// server/openreceive.ts
import { defineOpenReceive } from "@openreceive/nuxt/server";

export default defineOpenReceive({
  storage: {
    db, // your existing pg Pool, from server/utils/db.ts
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
    const order = await findOrder(reference); // your own orders
    return order?.state === "awaiting_payment"
      ? { currency: order.currency, value: order.amount, description: order.title }
      : null;
  },
  // Only the buyer may pay for their order.
  authorize: async ({ native, resource }) => {
    const order = resource.reference ? await findOrder(resource.reference) : undefined;
    return Boolean(order && order.visitor === getCookie(native, "visitor"));
  },
  // 60 new invoices an hour per client IP, counted in your database.
  rateLimiting: true,
});
```

`native` is the request's `H3Event`, so `authorize` can check the session your
app already has: its cookies, or the user your session module reads from the
event. The [Next.js quickstart](https://openreceive.org/guides/quickstart-next.md) explains each hook. They
are the same here.

The payment routes are built on the first request, not at import, so the build
and prerendering never connect to the wallet, and one set serves the whole
server process. `rateLimiting` counts the socket address. Behind your own
reverse proxy, add `trustProxyIpHeader: true` to read the first address in
`x-forwarded-for`, which is safe only when that proxy sets the header
([Rate limiting](https://openreceive.org/guides/rate-limiting.md)).

Until `server/openreceive.ts` exists, the module warns and mounts no route.

### 5. The checkout page

The page asks your own server route whether this visitor owns the order:

```ts
// server/api/checkout/[reference].get.ts
export default defineEventHandler(async (event) => {
  const order = await findOrder(getRouterParam(event, "reference") ?? "");
  if (!order || order.visitor !== getCookie(event, "visitor")) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return { reference: order.id, swapPaymentHash: order.swapPaymentHash ?? undefined };
});
```

```vue
<!-- app/pages/checkout/[reference].vue -->
<script setup lang="ts">
const route = useRoute();
// During server rendering, useFetch passes the visitor's cookies to your own routes.
const { data, error } = await useFetch(`/api/checkout/${route.params.reference}`);
if (error.value) {
  throw createError({ statusCode: 404, statusMessage: "Not found", fatal: true });
}
let saved = data.value?.swapPaymentHash; // the order row's swap_payment_hash

// With swaps on: keep a new swap's payment hash on the order row.
function onState(event: Event) {
  const { state } = (event as CustomEvent).detail;
  if (state.rail !== "swap" || !state.payment_hash || state.payment_hash === saved) return;
  saved = state.payment_hash;
  $fetch(`/api/orders/${data.value?.reference}/swap-hash`, {
    method: "POST",
    body: { payment_hash: saved },
  });
}
</script>

<template>
  <OpenReceiveCheckout v-if="data" :reference="data.reference" resumable
    :resume-payment-hash="data.swapPaymentHash" :on-state="onState" />
</template>
```

`<OpenReceiveCheckout>` needs no import and no stylesheet import: the module
registers both. It takes every prop of the `@openreceive/vue` checkout
([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)). The page renders on the server
and starts the checkout in the browser. The payer picks Bitcoin and gets the
invoice.

With swaps on, a swap deposit that arrives short or late is refunded on a later
visit to this page, sometimes hours later or from another browser. So the page
is `resumable`, and the `onState` prop keeps the swap's payment hash on the
order row. It receives the element's event, with the state at
`event.detail.state`.

`server/api/orders/[reference]/swap-hash.post.ts` is a route of your own. It
checks that the order belongs to this payer, as the page's API route does, and
that the hash is 64 hex characters, then saves it in a `swap_payment_hash`
column, empty until a swap starts. Not in browser storage: another browser has
none, and a payer who returns after the swap's half hour would land on the
payment methods with the refund off-screen ([Swap
refunds](https://openreceive.org/guides/swap-refunds.md)).

No worker or cron job is required. Each request to the payment routes also
checks the wallet for settled invoices, through a lock in your database. A
payer who closes the tab is settled on the next request from anyone.
On a quiet site that can be hours later. If fulfillment should not wait, see
[When the payer leaves the page](https://openreceive.org/guides/deploying.md#when-the-payer-leaves-the-page).

### 6. Verify

```sh
npx openreceive doctor --db "$DATABASE_URL" --url http://localhost:3000
```

`openreceive doctor` reads `.env`, checks `NWC_URI` and the swap-provider
configuration, and probes the wallet relay to confirm the code is
receive-only. `--db` confirms the payment tables exist, and `--url` that the
routes are mounted. Every failing line states its own fix. After a production
build, `npx openreceive doctor --scan-build .output/public` confirms no code
reached the browser files.

Then open an order's checkout page in a browser. Confirm the payment-method
icons and wallet logos render, and open a wallet's pay tutorial to check its
screenshots.
