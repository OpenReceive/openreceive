# Rails quickstart

Requires Ruby ≥ 3.2.

Add the Rails engine gem to your `Gemfile`:

```ruby
gem "openreceive-rails"
```

That is the whole install: `openreceive-rails` depends on `openreceive`,
`openreceive-server` and `nwc-ruby`, so the default wallet client — built from
`NWC_URI` — works with nothing else added. Hosts that bring their own NWC
client set `config.nwc_client` instead.

Then run:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

`openreceive:install` emits one migration for both engine tables, the
initializer, and the engine mount. The migration adapts to the app's configured
database adapter — PostgreSQL, SQLite, and MySQL (`mysql2`/`trilogy`) are
supported.
→ [openreceive:install](api-reference.md#openreceiveinstall)

The generator emits three things:

- `db/migrate/*_create_openreceive_tables.rb` — one migration creating both
  engine tables: `openreceive_payments` (including `status` and
  `status_reason`) and the `openreceive_meta` reconcile gate;
- a simplified `config/initializers/openreceive.rb`;
- the `OpenReceive::Engine` route mount at `/openreceive`.

The `OpenReceivePayment` model is engine-owned — no model file is generated.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally unique.

### Fulfill exactly once

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

A complete runnable example app is the Rails Hello Fruit demo, `npm run demo rails`
([`examples/hello-fruit/server/rails`](../../examples/hello-fruit/server/rails)).

Supply the receive-only wallet connection as `ENV["NWC_URI"]`. Never put it in
browser code, logs, or assets. Your application refuses to start when the code
advertises spend methods such as `pay_invoice`; the explicit override is
`config.allow_spend_capable_wallet = true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` ([Security](security.md)).

OpenReceive reads `ENV`; Rails does not load a `.env` file on its own.
`dotenv-rails`, an exported shell environment, or your production secret
manager has to put the values there first.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

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
  #                        prove this caller owns it.
  # Return true to allow, false for a 403. Here: only the signed-in customer
  # who placed the order may act on it.
  config.authorize = lambda do |context|
    order = Order.find_by(id: context[:resource][:reference])
    order && order.user_id == context[:request].session[:user_id]
  end

  # The price for a reference — here, your order id — from your own data;
  # nil when there is nothing to pay for (a 404).
  config.amount_for = lambda do |reference|
    order = Order.find_by(id: reference)
    order && { currency: "USD", value: order.total.to_s }
  end

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. Update the order or insert an outbox row here — plain
  # ActiveRecord, because the engine WRAPS this block in the transaction.
  # (The JS engine instead hands onPaid a `query` handle, since nothing wraps
  # it there; that is the one shape difference between the two stacks.)
  config.on_paid = lambda do |settlement|
    # settlement exposes reference, payment_hash, paid_at, and details.
    Order.find(settlement.reference).update!(status: "paid")
  end
end
```

`OpenReceive.configure` sets the three host hooks; `on_paid` runs inside the
settlement transaction, only for the first settled attempt for a reference.
→ [OpenReceive.configure](api-reference.md#openreceiveconfigure)

The engine inherits your application's `protect_from_forgery`. Keep
`csrf_meta_tags` in the layout that renders the checkout; the checkout client
sends `X-CSRF-Token` from it automatically.

The generated initializer ships
`config.on_paid = OpenReceive::LOGGING_ON_PAID` — a placeholder that only logs
the settlement and fulfills nothing. Replace it with your real fulfillment (as
above); the engine warns every time your application boots while the
placeholder is still configured, because orders would otherwise be recorded as settled without ever
being fulfilled.

The amount always comes from your own order record; payer-supplied amounts are
rejected. Advanced hooks (`resolve_checkout`, `on_checkout_created`) remain as
overrides for custom-repository applications and are not part of the quickstart.

For public web shops, opt into the per-IP invoice cap with
`config.rate_limiting = true`; leave it off (the default) when many payers
share one IP. → [Rate limiting](rate-limiting.md#rails)

In production the engine builds the wallet client — and runs its receive-only
preflight — eagerly when your application boots, so a missing `NWC_URI`, a
dead relay, or a spend-capable wallet stops the deploy instead of surfacing as
customer-facing 500s on the first checkout. Outside production (tests,
consoles) the client is built lazily so no live wallet is needed.

## Render the checkout

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

The element creates the checkout for `reference`, then renders and polls
itself. React/Vue/Svelte/Angular apps use the matching wrapper package
instead — same props and defaults ([Frontend checkout](frontend-checkout.md)).
The Rails Hello Fruit demo mounts the packaged `@openreceive/react` components
and drives them from mobx-keystone stores fed by
`@openreceive/browser/headless` ([Headless checkout](headless-checkout.md)) —
custom state, packaged UI.

## Reconciliation

Settlement runs on the request path by default: every mounted engine payment
route (not the unauthenticated `GET /rates`) runs one opportunistic reconcile
pass when attempts are pending, serialized by
the durable `openreceive_meta` gate from the install migration. The
gate is shared by all Puma workers on the database, so rapid calls collapse to
one bounded wallet scan per interval — no scheduled job is needed. Disable or
tune with `config.opportunistic_reconcile` (`false`, or
`{ min_interval_seconds: … }`).

Optionally, run the one long-lived worker:

```sh
bin/rails openreceive:notifications
```

It listens for NWC-02 `payment_received` notifications — authenticated wallet
data — and also reconciles periodically
(`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default 15), its own
safety net for notifications missed while it was down. A settled payload
settles the matching pending attempt directly (same finality rule as scans;
never a preimage alone); anything less only wakes a reconcile pass.
→ [rake openreceive:notifications](api-reference.md#rake-openreceivenotifications) ·
[OpenReceive.listen_for_notifications!](api-reference.md#openreceivelisten_for_notifications)

`OpenReceive.reconcile!`, `OpenReceive::ReconcileJob`, and
`bin/rails openreceive:reconcile` remain one-shot primitives — nothing to
schedule. `reconcile!` now returns the per-hash check results of the pass.
→ [OpenReceive.reconcile!](api-reference.md#openreceivereconcile) ·
[OpenReceive::ReconcileJob](api-reference.md#openreceivereconcilejob)

Each pass reconciles only `pending` attempts — the oldest
`OpenReceive::Server::RECONCILE_BATCH_SIZE` (200) per pass — with one batched
wallet scan, so the window stays bounded and a backlog drains over successive
passes. Settled rows are never overwritten; closing an unpaid
attempt requires a successful wallet scan past expiry plus the 900-second
grace, never the local clock alone. Duplicate delivery is harmless.

## Swap secrets

The Ruby server recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors: setting either one
auto-builds the matching provider, so an app that wants swaps only supplies the
connection strings ([Environment variables](environment-variables.md)).
`config.swap_providers` is the override knob — pass your own adapters to
replace the auto-built set, or an empty array to disable swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data`. The engine filters `swap_data` from Active Record
inspection and ordinary serialization. Do not explicitly serialize it, log it,
or return it from your own API; it may contain a provider credential.
