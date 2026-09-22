# Rails quickstart

Requires Ruby ≥ 3.2 and Rails ≥ 8.0.

Add the Rails engine gem to your `Gemfile`:

```ruby
gem "openreceive-rails"
```

That is the whole install. `openreceive-rails` depends on `openreceive`,
`openreceive-server` and `nwc-ruby`, so the default wallet client works with
nothing else added. It is built from `NWC_URI`. If your app brings its own NWC
client, set `config.nwc_client` instead.

There is one native prerequisite. `nwc-ruby` uses `rbsecp256k1`, which builds
libsecp256k1 from source. Minimal images (`ruby:3.3-slim`, fresh Docker builds)
need the autotools for that, or `bundle install` fails with
`autoreconf: not found`. Install them before bundling:

```sh
apt-get install -y autoconf automake libtool build-essential pkg-config
```

Full Ruby images and typical developer machines already have these.

Then run:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

The migration adapts to your app's database adapter. PostgreSQL, SQLite, and
MySQL (`mysql2`/`trilogy`) are supported.
→ [openreceive:install](api-reference.md#openreceiveinstall)

The `openreceive:install` generator emits three things:

- `db/migrate/*_create_openreceive_tables.rb`: one migration that creates both
  engine tables (`openreceive_payments` and `openreceive_meta`).
- A simplified `config/initializers/openreceive.rb`.
- The `OpenReceive::Engine` route mount at `/openreceive`.

The engine owns the `OpenReceivePayment` model, so no model file is generated.
The engine also owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique, because
one reference may have many historical attempts. `payment_hash` is globally
unique.

### Fulfill exactly once

<!-- shared:begin fulfill-once -->
Within OpenReceive's own settlement paths, `on_paid` runs at most once per
reference. If a second invoice for the same reference is paid, OpenReceive
records that payment with `status_reason = "duplicate_settlement"` and does
not fulfill again.
<!-- shared:end fulfill-once -->

One case is yours to handle. **If anything other than OpenReceive can also
fulfill an order**, such as an admin action, a second payment processor, or a
replayed job, those paths race each other. Then `on_paid` must be idempotent.
The generated initializer explains this and shows the guarded transition:

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

Delivery is at-least-once. `on_paid` runs inside the settlement transaction. If
it raises, the transaction rolls back and the next pass retries. So keep
`on_paid` to database writes on the order. An email or webhook sent from here
would survive the rollback and go out again. The `state: "paid"` transition
above is the flag. Let your own job drain it after commit.

**`update_all` fires no Active Record callbacks.** That is intended. It runs one
conditional `UPDATE`, so the claim is atomic and no model code runs between the
check and the write. It also means there is no `after_commit` to attach a
post-commit side effect to. That is fine for a background job that drains the
flag. It does not help a page that needs to know right away. If you push
settlement over Action Cable, or your model owns the transition through
callbacks, take a row lock for the duration instead:

```ruby
config.on_paid = lambda do |settlement|
  order = Order.lock.find_by(id: settlement.reference)   # SELECT … FOR UPDATE
  next unless order && order.state == "awaiting_payment"
  order.update!(state: "paid", paid_at: Time.at(settlement.paid_at).utc)  # callbacks fire
end
```

**Unlocking a download works the same way.** If the payer bought a file, do not
unlock it in the browser. Gate the download route on the paid order row, and
serve the file only if that row exists:
`Order.find_by(id: params[:id], user: current_user, state: "paid")`, or a 404
otherwise. The `state: "paid"` written above is the unlock. The client never
decides that an order was fulfilled. It re-reads the row. Buy a Button's
`ShopController#download` does this in twenty lines.

Both shapes are idempotent and correct. They differ only in whether your model
layer runs:

- `update_all` skips the model layer. It is the right default.
- The row lock holds the row for the duration of the block. Use it when the
  transition has to go through your model.

The generated fulfillment note says the same thing. If your fulfillment is a
read-modify-write that one conditional `UPDATE` cannot express, take the lock.

Either way, the rule above still holds: the callback must only make database
writes on the order. `after_commit` on the settlement transaction runs after
OpenReceive's own commit. So an email enqueued there is as safe as one enqueued
from a job that drains the flag. An email sent *inline* from `on_paid` is not
safe, in either shape.

Buy a Button
([`examples/buttons/server/rails`](../../examples/buttons/server/rails))
is a runnable illustration of this boundary. It is not a template to copy
models from. It has products, visitors, and orders, and the three hooks are the
only bridge. Map that shape onto the models in THIS app.

Supply the receive-only wallet connection as `ENV["NWC_URI"]`. Never put it in
browser code, logs, or assets. Your application refuses to start when the code
advertises spend methods such as `pay_invoice`. To override that explicitly,
set `config.allow_spend_capable_wallet = true` or
`OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` ([Security](security.md)).

OpenReceive reads `ENV`. Rails does not load a `.env` file on its own, so
something has to put the values there first: `dotenv-rails`, an exported shell
environment, or your production secret manager.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

The initializer needs three things: authorization, the trusted price, and
fulfillment. All three receive the `reference`. This is a string you choose,
and it is the fulfillment identity. Use your order id:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

OpenReceive never looks inside it. But `on_paid` commits fulfillment once per
reference, and a new checkout under a reference that already settled is
refused with 409. A fresh id per page load would let one order be paid twice.

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

`OpenReceive.configure` sets the three host hooks. `on_paid` runs inside the
settlement transaction, only for the first settled attempt for a reference.
→ [OpenReceive.configure](api-reference.md#openreceiveconfigure)

The engine's controllers inherit from `config.parent_controller`. The generated
initializer sets it to `"ApplicationController"`. That is how the engine picks
up your application's `protect_from_forgery`. Keep `csrf_meta_tags` in the
layout that renders the checkout. The checkout client sends `X-CSRF-Token` from
it automatically.

The same inheritance also brings every global `before_action` that your
`ApplicationController` declares. A filter that redirects signed-out users to a
login page will redirect the engine's JSON routes too. A guest checkout then
never gets an invoice. The engine reads nothing from the parent except forgery
protection. `config.authorize` receives the request, and your policy reads its
own session from it. So if your `ApplicationController` has such filters, do one
of these:

- Point `config.parent_controller` at a slimmer controller that still calls
  `protect_from_forgery`.
- Skip the filter for the engine only:

```ruby
# config/initializers/openreceive.rb (after OpenReceive.configure)
Rails.application.config.to_prepare do
  OpenReceive::ApplicationController.skip_before_action :require_login
end
```

Keep the filters your authorize policy depends on, such as a tenant resolver
or `Current` attributes. They run before `config.authorize`.

The generated initializer ships two placeholders. Replace both, not just
`on_paid`:

- `config.on_paid = OpenReceive::LOGGING_ON_PAID` only logs the settlement and
  fulfills nothing. Replace it with your real fulfillment (as above). Until you
  do, orders would be recorded as settled without ever being fulfilled, so the
  engine warns every time your application boots.
- `config.authorize = OpenReceive::ALLOW_ALL_AUTHORIZE` allows everything. It
  treats possession of the reference as authorization, which is safe only while
  references are unguessable. The engine warns at boot until you replace it
  with your own ownership check (as above).

The amount always comes from your own order record. Payer-supplied amounts are
rejected. The advanced hooks `resolve_checkout` and `on_checkout_created` remain
as overrides for apps with a custom repository. They are not part of the
quickstart.

For public web shops, turn on the per-IP invoice cap with
`config.rate_limiting = true`. Leave it off (the default) when many payers
share one IP. → [Rate limiting](rate-limiting.md#rails)

<!-- shared:begin eager-preflight -->
In production, the engine builds the wallet client when your app boots. It
also runs the receive-only preflight right away: it reaches the wallet and
checks that the code cannot spend. A missing `NWC_URI`, a dead relay, or a
spend-capable wallet then stops the deploy. Otherwise those problems would
show up as 500 errors for customers on the first checkout. Outside production
(tests, consoles), the engine builds the client lazily, on first use, so no
live wallet is needed.
<!-- shared:end eager-preflight -->

## Render the checkout

Serve the compiled `styles.css` without Tailwind processing. Either import it
from JavaScript (with a CSS-capable bundler) or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your Tailwind entry. Its
rules have zero specificity, so your own styles can override checkout styles.
Scoping does not prevent that.

The engine serves JSON checkout routes only. Your view does the rendering. Any
OpenReceive frontend package works against the `/openreceive` mount. The
smallest is the custom element. Its default `prefix` is already
`/openreceive`. The package ships a self-contained `styles.css` that a plain
stylesheet link can serve, scoped to what OpenReceive renders.

```erb
<%# app/views/orders/pay.html.erb %>
<openreceive-checkout reference="<%= @order.id %>"></openreceive-checkout>
```

```js
// In your JS bundle (esbuild/webpacker with CSS support):
import { defineElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css"; // or link the compiled styles.css

// Registers the <openreceive-checkout> tag with the browser. Without this,
// the tag in the ERB above is unknown markup and renders as nothing; with it,
// the element wakes up wherever the tag appears. Call once per page — order
// relative to the markup does not matter.
defineElements();
```

If you bundle with esbuild (jsbundling-rails), build ESM and load it as a
module. esbuild's default IIFE output runs a dependency's Node fallback in the
browser, which throws `ReferenceError: __filename is not defined`:

```sh
esbuild app/javascript/application.js --bundle --format=esm --outdir=app/assets/builds
```

```erb
<%= javascript_include_tag "application", type: "module" %>
```

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can load tutorial screenshots only when a tutorial is first opened.
Single-file builds, including the standalone checkout, include them upfront. If
your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, check the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

The element creates the checkout for `reference`, then renders and polls
itself. React, Vue, Svelte, and Angular apps use the matching wrapper package
instead, with the same props and defaults
([Frontend checkout](frontend-checkout.md)). Build a custom checkout only if
this app cannot use a drop-in. In that case `@openreceive/browser/headless` is
the API ([Headless checkout](headless-checkout.md)).

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

To run a pass yourself, use the one-shot `OpenReceive.reconcile!` or
`bin/rails openreceive:reconcile`.
→ [OpenReceive.reconcile!](api-reference.md#openreceivereconcile)

## Swap secrets

The Ruby server recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`, using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors. Setting
either one auto-builds the matching provider. So an app that wants swaps only
supplies the connection strings
([Environment variables](environment-variables.md)). To override this, use
`config.swap_providers`. Pass your own adapters to replace the auto-built set,
or an empty array to disable swaps.

One `openreceive_payments` row holds at most one provider order, in its
server-only `swap_data`. The engine hides `swap_data` from Active Record
inspection and ordinary serialization. Do not serialize it explicitly, log it,
or return it from your own API. It may contain a provider credential.

<!-- shared:begin swap-refund-commitment -->
**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late. The provider then marks it `refund_required`, and only
your UI can claim it. The payer claims it on a second visit, after leaving your
page to get an address in another wallet. That needs three things:

- a per-order URL your app serves,
- a route that restores the order behind it,
- something that restores the ATTEMPT, since `/checkouts/prepare` returns none.

[Swap refunds](swap-refunds.md) covers all of it. Read it before you set
`LSC_URI_PRIMARY`.
<!-- shared:end swap-refund-commitment -->
