# Rails quickstart

Requires Ruby ≥ 3.2 (what every OpenReceive gemspec declares; CI covers 3.2 and 3.4).

Add the Rails engine gem to your `Gemfile`:

```ruby
gem "openreceive-rails"
```

Then run:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

`openreceive:install` emits one migration for both engine tables, the
initializer, and the engine mount. The migration adapts to the app's configured
database adapter — PostgreSQL, SQLite, and MySQL (`mysql2`/`trilogy`) are
supported. There is nothing to match against your schema: `order_id` is stored
as an opaque string with no foreign key, whatever your orders table's primary
key looks like. `--order-model` only names the model the generated initializer
calls (`load_order`, `amount_for_order`, the `on_paid` example).
→ [openreceive:install](api-reference.md#openreceiveinstall)

The generator emits three things:

- `db/migrate/*_create_openreceive_tables.rb` — one migration creating both
  engine tables: `openreceive_payments` (including `status` and
  `status_reason`) and the `openreceive_meta` reconcile gate;
- a simplified `config/initializers/openreceive.rb`;
- the `OpenReceive::Engine` route mount at `/openreceive`.

The `OpenReceivePayment` model is engine-owned — no model file is generated.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine; the generator does not alter `orders`. Review the
migration before running it: `order_id` is indexed but not unique (an order may
have many historical attempts), `payment_hash` is globally unique.

### Your order table stays yours

The engine never reads, writes, locks, or references it. Commit and settlement
serialize on an OpenReceive-owned per-order lock
(`OpenReceivePayment.with_order_lock` — a Postgres advisory lock, a MySQL named
lock, or SQLite's single writer), so there is no model to register and no
foreign key to keep in step with your migrations.

The flip side is one thing you own: **if anything other than OpenReceive can
also fulfill an order** — an admin action, a second payment processor, a
replayed job — those paths race each other, and `on_paid` must be idempotent.
The generated initializer spells this out and shows the guarded transition:

```ruby
config.on_paid = lambda do |settlement|
  claimed = Order
              .where(id: settlement.order_id, state: "awaiting_payment")
              .update_all(state: "paid", paid_at: Time.at(settlement.paid_at).utc)
  next if claimed.zero? # someone else already fulfilled it

  FulfillOrder.call(Order.find(settlement.order_id), payment_hash: settlement.payment_hash)
end
```

Delivery is at-least-once: `on_paid` runs inside the settlement transaction,
and a raise rolls it back for the next pass to retry. Keep it to database
writes on the order — an email or webhook sent from here would survive the
rollback and go out again. The `state: "paid"` transition above is the flag;
let your own job drain it after commit.

Within OpenReceive's own settlement paths, `on_paid` already runs at most once
per order: a second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.

If you want referential integrity anyway, add the foreign key yourself in your
own migration — the generated one shows the statement, `ON DELETE RESTRICT` so
deleting an order cannot erase the record of money that was paid.

A complete runnable example app is the Rails Hello Fruit demo, `npm run demo rails`
([`examples/hello-fruit/server/rails`](../../examples/hello-fruit/server/rails)).

Supply the receive-only wallet connection as `ENV["NWC_URI"]`. Never put it in
browser code, logs, or assets. Boot fails closed when the code advertises spend
methods such as `pay_invoice`; the explicit override is
`config.allow_spend_capable_wallet = true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` ([Security](security.md)).

## Configure the order bridge

The initializer needs four things: authorization, order loading, the trusted
price, and fulfillment.

```ruby
OpenReceive.configure do |config|
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }
  config.load_order = ->(order_id) { Order.find_by(id: order_id) }
  config.amount_for_order = ->(order) { { currency: "USD", value: order.total.to_s } }

  # Runs inside the settlement transaction, only for the order's first settled
  # attempt. Update the order or insert an outbox row here.
  config.on_paid = lambda do |settlement|
    # settlement exposes order_id, payment_hash, paid_at, and details.
    Order.find(settlement.order_id).update!(status: "paid")
  end
end
```

`OpenReceive.configure` sets the four-part order bridge; `on_paid` runs
inside the settlement transaction, only for the order's first settled attempt.
→ [OpenReceive.configure](api-reference.md#openreceiveconfigure)

The generated initializer ships
`config.on_paid = OpenReceive::LOGGING_ON_PAID` — a placeholder that only logs
the settlement and fulfills nothing. Replace it with your real fulfillment (as
above); the engine warns at every boot while the placeholder is still
configured, because orders would otherwise be recorded as settled without ever
being fulfilled.

The amount always comes from your own order record; payer-supplied amounts are
rejected. Advanced hooks (`resolve_checkout`, `on_checkout_created`) remain as
overrides for custom-repository applications and are not part of the quickstart.

For public web shops, opt into the per-IP invoice cap with
`config.rate_limiting = true`; leave it off (the default) when many payers
share one IP. → [Rate limiting](rate-limiting.md#rails)

In production the engine builds the wallet client — and runs its receive-only
preflight — eagerly at boot, so a missing `NWC_URI`, a dead relay, or a
spend-capable wallet stops the deploy instead of surfacing as customer-facing
500s on the first checkout. Outside production (tests, consoles) boot stays
lazy so no live wallet is needed.

## Render the checkout

The engine serves JSON checkout routes only — rendering is your view. Any
OpenReceive frontend package works against the `/openreceive` mount; the
smallest is the custom element (its default `prefix` is already
`/openreceive`, and the package ships a self-contained `styles.css` a plain
stylesheet link can serve):

```erb
<%# app/views/orders/pay.html.erb %>
<openreceive-checkout order-id="<%= @order.id %>"></openreceive-checkout>
```

```js
// In your JS bundle (importmap/esbuild/webpacker):
import { defineElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css"; // or link the compiled styles.css
defineElements();
```

The element creates the checkout for `order-id`, then renders and polls
itself. React/Vue/Svelte/Angular apps use the matching wrapper package
instead — same props and defaults ([Frontend checkout](frontend-checkout.md)).
The Rails Hello Fruit demo renders a fully custom UI over
`@openreceive/browser/headless` ([Headless checkout](headless-checkout.md)).

## Reconciliation

Settlement runs on the request path by default: every mounted engine route
runs one opportunistic reconcile pass when attempts are pending, serialized by
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
connection strings. `config.swap_providers` is the override knob — pass your own
adapters to replace the auto-built set, or an empty array to disable swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data`. The engine filters `swap_data` from Active Record
inspection and ordinary serialization. Do not explicitly serialize it, log it,
or return it from your own API; it may contain a provider credential.
