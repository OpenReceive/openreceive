# Rails Quickstart

The `openreceive-rails` gem is a mountable Rails engine that ships OpenReceive's routes into
your app. Your app keeps 100% of authentication: the engine controllers inherit from your
`ApplicationController`, so they automatically get your CSRF protection, `authenticate_user!`,
and `current_user`. OpenReceive never inspects your session — it calls the `authorize` and
`resolve_amount` hooks you configure and obeys them.

The engine builds on two gems you also depend on: `openreceive` (the dependency-free core:
money math, settlement detection, NWC parsing, idempotency, capability-token hashing) and
`openreceive-server` (the Service, the ActiveRecord store, the config loader, and the NWC
transport via the [`nwc-ruby`](https://github.com/MegalithicBTC/nwc-ruby) gem).

## 1. Install

```ruby
# Gemfile
gem "openreceive"
gem "openreceive-server"
gem "openreceive-rails"
gem "nwc-ruby"
```

```sh
bundle install
bin/rails generate openreceive:install
```

The `openreceive:install` generator writes `config/initializers/openreceive.rb`, adds the
`mount` line to `config/routes.rb`, and copies the OpenReceive migrations into `db/migrate/`
with fresh timestamps.

## 2. Migrate

```sh
bin/rails openreceive:install:migrations   # copies the canonical SQL with fresh timestamps
bin/rails db:migrate
```

Migration 001 creates `openreceive_invoices` + the meta table; migration 002 adds the
per-order capability-token column. The migration superclass is resolved to your Rails version
at generate time (floor: Rails 7.1). Rails records applied migrations in its own
`schema_migrations`; the engine does not ship its own runner.

## 3. Configure the hooks

```ruby
# config/initializers/openreceive.rb
OpenReceive.configure do |config|
  # Engine controllers inherit from this — gives you CSRF + current_user for free.
  config.parent_controller = "ApplicationController"

  # Receive-only NWC connection (server-only; never sent to the browser or logged).
  config.nwc = ENV.fetch("OPENRECEIVE_NWC")
  config.namespace = "default"

  # Tier 2 reads: allow the owner. Tier 3 (sweep) FAILS CLOSED unless this allows it.
  config.authorize = lambda do |ctx|
    case ctx[:action]
    when "checkout.create" then true               # anonymous checkout on a site with no accounts
    when "invoice.sweep"   then ctx[:request].env["warden"]&.user&.admin? # privileged
    else order_owner?(ctx)                          # Tier 2: token or your own login
    end
  end

  # Amount authority: never trust the client price. Return the authoritative amount.
  config.resolve_amount = lambda do |ctx|
    { usd: Order.find(ctx[:order_id]).total_usd.to_s }
  end
end
```

You mount the engine (the generator does this for you):

```ruby
# config/routes.rb
mount OpenReceive::Engine => "/openreceive"
```

### Prefer a controller concern?

Instead of the `authorize` proc you can include `OpenReceive::Authorization` in your own
controller and implement `openreceive_authorize(context)` there, giving you full access to your
app's auth helpers (`current_user`, Pundit/CanCanCan policies, etc.).

## 4. The routes you now have

All under the mount prefix (`/openreceive`):

- `POST /openreceive/checkouts` — create a checkout (Tier 1). Returns `order_access_token` on
  the first checkout for an order.
- `POST /openreceive/orders/:order_id` — order status or a swap action (Tier 2).
- `GET /openreceive/checkouts/:checkout_id` — read a checkout (Tier 2).
- `GET /openreceive/orders/:order_id/swap-options` — list swap pay-in options (Tier 2).
- `GET /openreceive/rates` — public rate quotes (Tier 1).
- `POST /openreceive/admin/sweep` — reconcile pending invoices (Tier 3, fails closed).

The wire contract, tiers, and capability-token details are in `docs/guides/routes.md`. It is
identical to the Node adapters and held byte-equal by the HTTP golden vectors.

## Non-Rails Ruby hosts

If you are not on Rails, use `openreceive-server` directly. It exposes the same Service and a
Rack app (`OpenReceive::Server::RackApp`) that implements the same routes, so Sinatra/Hanami/
plain Rack hosts get the identical contract.

```ruby
service = OpenReceive::Server::Service.new(nwc_client:, store:, namespace: "default")
app = OpenReceive::Server::RackApp.new(service:, authorize:, resolve_amount:, prefix: "/openreceive")
run app
```
