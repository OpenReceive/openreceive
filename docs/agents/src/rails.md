# OpenReceive agent directions (Rails)

Add OpenReceive to a Rails application — the app you are already working in. You
do not need a copy of the OpenReceive source: the gem is on RubyGems, the
frontend packages are on npm, and the quickstart is appended to this file in
full, so you can do the whole integration without fetching anything. Prefer the
published gem and the mounted engine routes — do not reimplement wallet RPC,
settlement, or pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, `ShopUser`, a signed-cookie visitor) over tables that
already exist. Find this application's order, product, and user models — whatever
they are actually named — and map the three hooks onto those.

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
Lightning payment. You supply those credentials and three hooks — `config.authorize`,
`config.amount_for`, `config.on_paid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing the gem or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, Rails
   credentials, the deploy config, whatever this app already uses. If the app
   runs in a container the value is in none of those: ask the running process
   (`docker exec <container> printenv NWC_URI`), because finding the NAME in a
   compose file or `.kamal/secrets` proves nothing about the value. Never print
   or echo the value itself; only report whether it is set. Check for
   `LSC_URI_PRIMARY` in the same pass.

   If OpenReceive is already installed here, `bin/rails openreceive:doctor`
   answers this whole step in one command — every credential as set/unset, the
   engine mount, the three hooks, and the wallet preflight. It never prints a
   value.
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
   `openreceive-rails` and `@openreceive/browser` against the release named at
   the top of this file. The headless display models below do not exist in
   older versions, and the first tile click throws with nothing saying why.
   Upgrade first — and if this app runs in containers, rebuild the images: the
   gems are baked into the image, so an in-place `bundle update` is undone by
   the next `compose up`.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the engine — not a second order model,
  and not an association to `OpenReceivePayment`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- The host owns the price. `config.amount_for` reads it from your own data;
  reject payer-supplied amounts.
- `config.authorize` runs on every request, and the `resource` it receives is a
  CLAIM the payer made, not proof. Read the framework session; never trust a
  body field.
- `config.on_paid` must be idempotent. It runs once per `reference` — your order
  id, one per thing you fulfill, created before checkout, kept across retries,
  never reused. A fresh id per page load lets one order be paid twice.
- Receive-only NWC is required; a spend-capable code fails closed at boot unless
  explicitly overridden.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs, and only from the
  `refund_required` provider state. Do not build, promise, or imply a Lightning
  refund path.
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `config.amount_for` and both drop-ins render it above the
  amount. Without it the checkout is a QR and "$1.00" with no sign of what the
  dollar is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  (It returns no rows while the rail is `checkout_lock` — before the payer has
  chosen anything there is no transaction — so render the caret only when the
  rows are non-empty.)
- HTTP JSON is snake_case; the browser packages' TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

The install migration adds `openreceive_payments` and `openreceive_meta` to THIS
application's database. That is the whole persistence OpenReceive needs. It does
not replace your orders, users, or products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<openreceive-checkout>`. A
  fresh id per page load lets one order be paid twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `config.amount_for` reads only that order — never a payer-supplied amount,
  never a live catalog lookup that could re-price a cart already placed. Return
  `{ currency:, value: }` as a decimal STRING, plus a `description` of what they
  are buying.
- **Users own the order; OpenReceive never sees them.** `config.authorize` uses
  the same ownership check this app already uses on the order show / pay page —
  `session[:user_id]`, Devise's `current_user`, a signed cookie, whatever it is.
  `context[:resource][:reference]` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The engine refuses a new checkout under a reference that already
  settled (409).
- **Do not associate `OpenReceivePayment`.** No `has_many`, no `belongs_to`, no
  foreign key either direction. `reference` is not unique (many attempts per
  order). Fulfillment is a guarded transition on YOUR order row inside
  `config.on_paid` — `UPDATE … WHERE state = awaiting_payment` (or this app's
  equivalent). Database writes only in the hook; emails, jobs, and broadcasts
  after commit.

## If you build your own checkout UI

The engine serves JSON only, so the view is yours — but the drop-ins
(`<openreceive-checkout>`, React's `<Checkout>`) already obey all of this. This
list is the short form of https://openreceive.org/guides/checkout-ux.md, for a UI
built on `@openreceive/browser/headless`. Read that before writing components.

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
  as suggestions, and host the icons yourself via the `asset-base-url` attribute
  or they break outside Vite. The registry answers ~37 wallets: pass
  `providerPreviewLimit` and build "show all" from `display.providerCount`,
  or they push the QR off the screen.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `config.authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the engine tables and the attempt state machine
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
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the mounted engine's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact
