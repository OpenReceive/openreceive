# Rails Quickstart

The `openreceive-rails` gem is a mountable Rails engine. Your app keeps 100% of
authentication: engine controllers inherit from your `ApplicationController`, so
they get your CSRF protection, `authenticate_user!`, and `current_user`.
OpenReceive never inspects your session — it calls the `authorize` and
`get_checkout_amount` hooks you configure and obeys them.

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

The `openreceive:install` generator writes `config/initializers/openreceive.rb`,
adds the `mount` line to `config/routes.rb`, and copies the OpenReceive
migrations into `db/migrate/` with fresh timestamps.

## 2. Migrate

```sh
bin/rails openreceive:install:migrations   # copies the canonical SQL with fresh timestamps
bin/rails db:migrate
```

Migration 001 creates OpenReceive invoice storage; migration 002 adds the
per-order access column used by the engine. The migration superclass is resolved
to your Rails version at generate time (floor: Rails 7.1).

## 3. Price the order

`get_checkout_amount` runs on **create checkout** only — not on order status
reads. It is required: the create body never carries a client price.

```ruby
get_checkout_amount = lambda do |ctx|
  order = Order.find_by(id: ctx[:order_id])
  return nil if order.nil? # → 404
  { amount: { currency: "USD", value: order.total_usd.to_s } }
end
```

## 4. Configure and mount

Wire pricing (and auth) into the engine, then mount it:

```ruby
# config/initializers/openreceive.rb
OpenReceive.configure do |config|
  # Engine controllers inherit from this — gives you CSRF + current_user for free.
  config.parent_controller = "ApplicationController"

  # Receive-only NWC connection (server-only; never sent to the browser or logged).
  config.nwc = ENV.fetch("OPENRECEIVE_NWC")
  config.namespace = "default"

  # Prefer a preset — see docs/guides/authorization.md
  config.authorize = OpenReceive::Server::Presets.guest_checkout
  # or with_user for logged-in apps; optional allow_sweep for admins

  # Amount authority — REQUIRED (see §3).
  config.get_checkout_amount = get_checkout_amount
end
```

```ruby
# config/routes.rb — the generator adds this for you
mount OpenReceive::Engine => "/openreceive"
```

### Prefer a controller concern?

Instead of the `authorize` proc you can include `OpenReceive::Authorization` in
your own controller and implement `openreceive_authorize(context)` there, giving
you full access to your app's auth helpers (`current_user`, Pundit/CanCanCan
policies, etc.).

## 5. Render checkout

Your app creates and persists the order (OpenReceive never mints orders), then
pass its id into the checkout UI — same pattern as the
[Node Quickstart](quickstart-node.md). Auth presets and amount authority are in
[Authorization](authorization.md).

## Non-Rails Ruby hosts

If you are not on Rails, use `openreceive-server` directly. It exposes the same
Service and a Rack app (`OpenReceive::Server::RackApp`) that mounts the same
payment surface, so Sinatra/Hanami/plain Rack hosts get the identical contract.

```ruby
service = OpenReceive::Server::Service.new(nwc_client:, store:, namespace: "default")
app = OpenReceive::Server::RackApp.new(service:, authorize:, get_checkout_amount:, prefix: "/openreceive")
run app
```
