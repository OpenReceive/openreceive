# Rails Quickstart

The `openreceive-rails` gem is a mountable Rails engine. Your app keeps 100% of
authentication: engine controllers inherit from your `ApplicationController`, so
they get your CSRF protection, `authenticate_user!`, and `current_user`.
OpenReceive never inspects your session — it calls the `authorize` and
`prepare_checkout` hooks you configure and obeys them.

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

## 3. Price the order (`prepare_checkout`)

`prepare_checkout` runs on **POST `/prepare`** only. It validates the cart (or
looks up your order), returns the authoritative amount, and OpenReceive persists
it. Create-checkout never trusts a client price.

```ruby
prepare_checkout = lambda do |ctx|
  body = ctx[:body] || {}
  cart = Cart.validate(body)
  {
    amount: { currency: "USD", value: cart.total_usd.to_s },
    order_id: cart.order_id,
    summary: cart.as_json
  }
end
```

Return `nil` → 404.

## 4. Configure and mount

```ruby
# config/initializers/openreceive.rb
OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.nwc = ENV.fetch("OPENRECEIVE_NWC")
  config.namespace = "default"
  config.authorize = OpenReceive::Server::Presets.guest_checkout
  config.prepare_checkout = prepare_checkout
end
```

```ruby
# config/routes.rb — the generator adds this for you
mount OpenReceive::Engine => "/openreceive"
```

## 5. Render checkout

Prepare from the browser (`POST /openreceive/prepare`), then:

```tsx
<Checkout orderId={orderId} resume onSettled={reloadOrder} />
```

See [Frontend Checkout](frontend-checkout.md) and [Authorization](authorization.md).
