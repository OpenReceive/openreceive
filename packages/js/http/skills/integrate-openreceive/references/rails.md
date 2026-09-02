# OpenReceive agent directions (Rails)

These directions describe OpenReceive 0.4.1.

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
payer send USDT, USDC, ETH or SOL instead, converted into that same
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
3. If `NWC_URI` is missing or empty, stop and tell the user exactly what to
   create:

   > OpenReceive cannot issue an invoice without a receive-only NWC code. Get
   > one at https://openreceive.org/get_a_nwc_code_to_receive_payments, then
   > put `NWC_URI=<the code>` in this app's server environment — for most apps
   > that is a `.env` file in the project root — and tell me when it's set.

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
     the integration is identical with or without it — the engine picks it up
     from the environment and swaps switch on. What a yes DOES change is the
     refund route back (the swap non-negotiable below): build it as part of
     this integration, not when the code arrives.
   - No → skip it. Bitcoin over Lightning works with `NWC_URI` alone, and you
     can add a swap provider later without changing application code.
5. Check the environment again and confirm `NWC_URI` is present.
   `LSC_URI_PRIMARY` may land later; swaps stay off until it does, and no code
   changes when it arrives.
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
  body field. The generator installs `OpenReceive::ALLOW_ALL_AUTHORIZE`, a
  placeholder that allows everything (the engine warns at boot while it is
  set) — replace it with this app's real ownership check, same as `on_paid`.
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
  the price from `config.amount_for` and both drop-ins render it above the
  amount. Without it the checkout is a QR and "$1.00" with no sign of what the
  dollar is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<openreceive-checkout>` / React's `<Checkout>` already render this panel and
  the `description` — these two rules cost you code only on a custom UI or your
  own receipt page, never a reason to replace the drop-in. (It returns no rows
  while the rail is `checkout_lock` — before the payer has chosen anything
  there is no transaction — so render the caret only when the rows are
  non-empty.)
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
  `createWizardRouteDisplays`. Lightning only. Host the icons with
  `asset-base-url`. The registry answers ~37 wallets: pass
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
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it. Read it before you turn swaps on
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

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-rails.

## Rails quickstart

Requires Ruby ≥ 3.2.

Add the Rails engine gem to your `Gemfile`:

```ruby
gem "openreceive-rails"
```

That is the whole install: `openreceive-rails` depends on `openreceive`,
`openreceive-server` and `nwc-ruby`, so the default wallet client — built from
`NWC_URI` — works with nothing else added. Hosts that bring their own NWC
client set `config.nwc_client` instead.

One native prerequisite: `nwc-ruby`'s `rbsecp256k1` builds libsecp256k1 from
source, so minimal images (`ruby:3.3-slim`, fresh Docker builds) need the
autotools or `bundle install` dies at `autoreconf: not found`. Before
bundling:

```sh
apt-get install -y autoconf automake libtool build-essential pkg-config
```

Full Ruby images and typical developer machines already have these.

Then run:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

`openreceive:install` emits one migration for both engine tables, the
initializer, and the engine mount. The migration adapts to the app's configured
database adapter — PostgreSQL, SQLite, and MySQL (`mysql2`/`trilogy`) are
supported.
→ [openreceive:install](https://openreceive.org/guides/api-reference.md#openreceiveinstall)

The generator emits three things:

- `db/migrate/*_create_openreceive_tables.rb` — one migration creating both
  engine tables (`openreceive_payments` and `openreceive_meta`);
- a simplified `config/initializers/openreceive.rb`;
- the `OpenReceive::Engine` route mount at `/openreceive`.

The `OpenReceivePayment` model is engine-owned — no model file is generated.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally unique.

#### Fulfill exactly once

Within OpenReceive's own settlement paths, `on_paid` runs at most once per
reference: a second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.

The one thing you own: **if anything other than OpenReceive can also fulfill
an order** — an admin action, a second payment processor, a replayed job —
those paths race each other, and `on_paid` must be idempotent. The generated
initializer spells this out and shows the guarded transition:

```ruby
config.on_paid = lambda do |settlement|
  claimed = Order
              .where(id: settlement.reference, state: "awaiting_payment")
              .update_all(state: "paid", paid_at: Time.at(settlement.paid_at).utc)
  next if claimed.zero? # someone else already fulfilled it

  # FulfillOrder — like Order — is your own application code: ship the goods,
  # enqueue the confirmation email. OpenReceive provides neither.
  FulfillOrder.call(Order.find(settlement.reference), payment_hash: settlement.payment_hash)
end
```

Delivery is at-least-once: `on_paid` runs inside the settlement transaction,
and a raise rolls it back for the next pass to retry. Keep it to database
writes on the order — an email or webhook sent from here would survive the
rollback and go out again. The `state: "paid"` transition above is the flag;
let your own job drain it after commit.

**`update_all` fires no Active Record callbacks.** That is the point — it is one
conditional `UPDATE`, so the claim is atomic and there is no model code between
the check and the write. It also means there is no `after_commit` to hang a
post-commit side effect on, which is fine for a background job draining the flag
and useless for a page that wants to know *now*. If you push settlement over
Action Cable, or your model owns the transition through callbacks, take a row
lock for the duration instead:

```ruby
config.on_paid = lambda do |settlement|
  order = Order.lock.find_by(id: settlement.reference)   # SELECT … FOR UPDATE
  next unless order && order.state == "awaiting_payment"
  order.update!(state: "paid", paid_at: Time.at(settlement.paid_at).utc)  # callbacks fire
end
```

Both shapes are idempotent, and both are correct. They differ only in whether
your model layer gets to run: `update_all` skips it and is the right default;
the row lock holds the row for the duration of the block and is what you want
when the transition has to go through your model. The generated fulfillment note
says the same thing — if your fulfillment is a read-modify-write that cannot be
expressed as one conditional `UPDATE`, take the lock.

Either way the rule above still holds: whatever the callback does must be
database writes on the order. `after_commit` on the settlement transaction runs
after OpenReceive's own commit, so an email enqueued there is as safe as one
enqueued from a job draining the flag — and an email sent *inline* from
`on_paid` is not, in either shape.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
(`examples/buttons/server/rails`).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

Supply the receive-only wallet connection as `ENV["NWC_URI"]`. Never put it in
browser code, logs, or assets. Your application refuses to start when the code
advertises spend methods such as `pay_invoice`; the explicit override is
`config.allow_spend_capable_wallet = true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` ([Security](https://openreceive.org/guides/security.md)).

OpenReceive reads `ENV`; Rails does not load a `.env` file on its own.
`dotenv-rails`, an exported shell environment, or your production secret
manager has to put the values there first.
→ [Environment variables](https://openreceive.org/guides/environment-variables.md).

### Configure the host hooks

The initializer needs three things: authorization, the trusted price, and
fulfillment. All three receive the `reference` — a string you choose, and the
fulfillment identity: your order id, one per thing you fulfill, created before
checkout, kept across retries, never reused. OpenReceive never looks inside
it, but `on_paid` runs once per reference, a new checkout under a reference
that already settled is refused with 409, and a fresh id per page load lets
one order be paid twice.

```ruby
OpenReceive.configure do |config|
  # `Order` throughout is YOUR model — it could be named anything. OpenReceive
  # never sees it or touches its table; these hooks are the only bridge
  # between the engine and your data.
  #
  # Your policy, called before every checkout/payment/swap request. `context`
  # is a Hash with three symbol keys:
  #   context[:action]   — which route: "checkout.prepare", "checkout.create",
  #                        "payment.check", "swap.quote", "swap.create",
  #                        "swap.read", or "swap.refund"
  #   context[:request]  — the ActionDispatch::Request; read your session,
  #                        cookies, or headers from it, as in a controller
  #   context[:resource] — { reference:, payment_hash: } copied from the
  #                        payer's JSON body. It names an order; it does not
  #                        prove this caller owns it. reference is always a
  #                        validated non-empty String (≤200 chars); payment_hash
  #                        is nil except on payment.check / swap.read / swap.refund.
  # Return true to allow, false for a 403. Here: only the signed-in customer
  # who placed the order may act on it.
  config.authorize = lambda do |context|
    order = Order.find_by(id: context[:resource][:reference])
    order && order.user_id == context[:request].session[:user_id]
  end

  # The price for a reference — here, your order id — from your own data;
  # nil when there is nothing to pay for (a 404). `value` is a decimal STRING
  # from the order row, never a float and never a request param. `description`
  # is what the payer is buying, in your own words.
  config.amount_for = lambda do |reference|
    order = Order.find_by(id: reference)
    order && { currency: "USD", value: order.total.to_s,
               description: "#{order.line_items.size} items" }
  end

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. The WHERE clause is the lock: a second fulfillment path of yours
  # (admin action, replayed job) updates zero rows and does nothing. Plain
  # ActiveRecord, because the engine WRAPS this block in the transaction.
  # (The JS engine instead hands onPaid a `query` handle, since nothing wraps
  # it there; that is the one shape difference between the two stacks.)
  config.on_paid = lambda do |settlement|
    claimed = Order
                .where(id: settlement.reference, state: "awaiting_payment")
                .update_all(state: "paid", paid_at: Time.at(settlement.paid_at).utc)
    next if claimed.zero?
  end
end
```

`OpenReceive.configure` sets the three host hooks; `on_paid` runs inside the
settlement transaction, only for the first settled attempt for a reference.
→ [OpenReceive.configure](https://openreceive.org/guides/api-reference.md#openreceiveconfigure)

The engine inherits your application's `protect_from_forgery`. Keep
`csrf_meta_tags` in the layout that renders the checkout; the checkout client
sends `X-CSRF-Token` from it automatically.

The generated initializer ships
`config.on_paid = OpenReceive::LOGGING_ON_PAID` — a placeholder that only logs
the settlement and fulfills nothing. Replace it with your real fulfillment (as
above); the engine warns every time your application boots while the
placeholder is still configured, because orders would otherwise be recorded as settled without ever
being fulfilled. The same applies to
`config.authorize = OpenReceive::ALLOW_ALL_AUTHORIZE`, the generated
allow-all placeholder: it treats possession of the reference as
authorization, which is safe only while references are unguessable, and the
engine warns at boot until you replace it with your own ownership check (as
above). Replace both, not just `on_paid`.

The amount always comes from your own order record; payer-supplied amounts are
rejected. Advanced hooks (`resolve_checkout`, `on_checkout_created`) remain as
overrides for custom-repository applications and are not part of the quickstart.

For public web shops, opt into the per-IP invoice cap with
`config.rate_limiting = true`; leave it off (the default) when many payers
share one IP. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md#rails)

In production the engine builds the wallet client — and runs its receive-only
preflight — eagerly when your application boots, so a missing `NWC_URI`, a
dead relay, or a spend-capable wallet stops the deploy instead of surfacing as
customer-facing 500s on the first checkout. Outside production (tests,
consoles) the client is built lazily so no live wallet is needed.

### Render the checkout

The engine serves JSON checkout routes only — rendering is your view. Any
OpenReceive frontend package works against the `/openreceive` mount; the
smallest is the custom element (its default `prefix` is already
`/openreceive`, and the package ships a self-contained `styles.css` a plain
stylesheet link can serve):

```erb
<%# app/views/orders/pay.html.erb %>
<openreceive-checkout reference="<%= @order.id %>"></openreceive-checkout>
```

```js
// In your JS bundle (importmap/esbuild/webpacker):
import { defineElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css"; // or link the compiled styles.css

// Registers the <openreceive-checkout> tag with the browser. Without this,
// the tag in the ERB above is unknown markup and renders as nothing; with it,
// the element wakes up wherever the tag appears. Call once per page — order
// relative to the markup does not matter.
defineElements();
```

Bundling with esbuild (jsbundling-rails)? Two things:

1. Build ESM and load it as a module. esbuild's default IIFE output evaluates
   a dependency's Node fallback in the browser and throws
   `ReferenceError: __filename is not defined`:

   ```sh
   esbuild app/javascript/application.js --bundle --format=esm --outdir=app/assets/builds
   ```

   ```erb
   <%= javascript_include_tag "application", type: "module" %>
   ```

2. Serve the provider images. The payment-method icons are compiled into
   `@openreceive/browser` and need nothing, but the wallet logos and pay
   tutorials are files shipped in `@openreceive/provider-data`, and only
   Vite-style bundlers resolve them from the import. Copy that package's
   `dist/assets` tree to `public/openreceive-assets/assets/` and set
   `asset-base-url="/openreceive-assets"` on the element
   ([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

The element creates the checkout for `reference`, then renders and polls
itself. React/Vue/Svelte/Angular apps use the matching wrapper package
instead — same props and defaults ([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)).
Build a custom checkout only if this app cannot use a drop-in; then
`@openreceive/browser/headless` is the API
([Headless checkout](https://openreceive.org/guides/headless-checkout.md)).

### Reconciliation

Settlement runs on the request path. You do not need a cron job. Disable or
tune it with `config.opportunistic_reconcile` (`false`, or
`{ min_interval_seconds: … }`).

Optionally, run one worker so settlement does not wait for the next page
load:

```sh
bin/rails openreceive:notifications
```

→ [rake openreceive:notifications](https://openreceive.org/guides/api-reference.md#rake-openreceivenotifications)

`OpenReceive.reconcile!` and `bin/rails openreceive:reconcile` are one-shot
primitives if you want to drive a pass yourself.
→ [OpenReceive.reconcile!](https://openreceive.org/guides/api-reference.md#openreceivereconcile)

### Swap secrets

The Ruby server recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](https://openreceive.org/guides/lightning-swap-connect.md) vectors: setting either one
auto-builds the matching provider, so an app that wants swaps only supplies the
connection strings ([Environment variables](https://openreceive.org/guides/environment-variables.md)).
`config.swap_providers` is the override knob — pass your own adapters to
replace the auto-built set, or an empty array to disable swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data`. The engine filters `swap_data` from Active Record
inspection and ordinary serialization. Do not explicitly serialize it, log it,
or return it from your own API; it may contain a provider credential.

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](https://openreceive.org/guides/swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.
