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
  engine tables (`openreceive_payments` and `openreceive_meta`);
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
([`examples/buttons/server/rails`](../../examples/buttons/server/rails)).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

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
Build a custom checkout only if this app cannot use a drop-in; then
`@openreceive/browser/headless` is the API
([Headless checkout](headless-checkout.md)).

## Reconciliation

Settlement runs on the request path. You do not need a cron job. Disable or
tune it with `config.opportunistic_reconcile` (`false`, or
`{ min_interval_seconds: … }`).

Optionally, run one worker so settlement does not wait for the next page
load:

```sh
bin/rails openreceive:notifications
```

→ [rake openreceive:notifications](api-reference.md#rake-openreceivenotifications)

`OpenReceive.reconcile!` and `bin/rails openreceive:reconcile` are one-shot
primitives if you want to drive a pass yourself.
→ [OpenReceive.reconcile!](api-reference.md#openreceivereconcile)

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

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.
