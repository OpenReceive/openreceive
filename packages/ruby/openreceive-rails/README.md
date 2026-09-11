# openreceive-rails

**Accept Bitcoin Lightning payments in Rails. Your app, your wallet.**

[OpenReceive](https://openreceive.org) adds Lightning checkout to your Rails app
and sends payments directly to a wallet you control. Mount the engine, connect
a receive-only Nostr Wallet Connect (NWC) wallet, and connect three hooks:
authorize a request, look up the order amount, and handle a settled payment.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

- **Fits your app:** keep your orders, users, prices, and fulfillment in Rails.
- **Uses your database:** payment attempts and reconciliation live alongside
  your application data, with PostgreSQL, SQLite, and MySQL support.
- **Handles the payment lifecycle:** invoice creation, payment checks, retry
  coordination, and settlement reconciliation are built in.
- **Keeps operations simple:** no separate OpenReceive database, Redis, or
  payment service to deploy. Wallet notifications can run in an optional worker.

## Get started

Requires Ruby 3.2 or later and Rails 8.0 or later. Add to your Gemfile:

```ruby
gem "openreceive-rails"
```

Run `bundle install`, then install the engine:

```sh
bin/rails generate openreceive:install
bin/rails db:migrate
```

The core, server, and default NWC client gems are included as dependencies.
Follow the [Rails quickstart](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/quickstart-rails.md) for native
build prerequisites, wallet configuration, the three hooks, and the checkout UI.
The generator creates the initializer, migration, and route mount; configure
the wallet and hooks before accepting payments.

## How it fits into Rails

The engine owns the
`OpenReceivePayment` attempt model (statuses `pending`, `settled`, `expired`,
`failed`, `attention`), its per-reference commit locking, settlement write-once, and
the reconciliation state machine. The install generator mounts the routes and
emits the initializer plus one migration creating both engine tables
(`openreceive_payments` and the `openreceive_meta` reconcile gate).

The generated migration supports PostgreSQL, SQLite, and MySQL, and seeds the
shared `schema_version`; on its first database touch the engine refuses to
operate a database whose stored schema version is newer than the gem.

The quickstart host contract is `config.authorize`, `config.amount_for` (the
trusted price for a reference, or `nil` for a 404), and `config.on_paid` (run
inside the settlement transaction, only for the first settled attempt for a reference). The generated
initializer starts with the `OpenReceive::LOGGING_ON_PAID` placeholder, which
only logs settlements — the engine warns every time your application boots
until it is replaced.
Hosts with a custom repository may instead configure `resolve_checkout` and
`on_checkout_created` together as the advanced escape hatch. In production the
engine builds the service (and its wallet preflight) eagerly when your
application boots, so a missing `NWC_URI` or a spend-capable wallet stops the
deploy instead of surfacing as checkout-time 500s.

Settlement runs on the request path by default: every engine route runs one
opportunistic reconcile pass, serialized across all Puma workers by that
durable `openreceive_meta` gate (`config.opportunistic_reconcile` disables or
tunes it). The optional
`bin/rails openreceive:notifications` worker listens for wallet notifications
and reconciles periodically; `OpenReceive::ReconcileJob` and
`bin/rails openreceive:reconcile` remain one-shot primitives. Closure of an
unpaid attempt requires a successful wallet scan at or after expiry plus the
shared grace window — a local clock alone never closes a row.

The engine inherits the host's `protect_from_forgery`: render `csrf_meta_tags`
and the checkout client sends `X-CSRF-Token` from it. Independently of that,
the shared handler refuses non-JSON bodies (415) and `Sec-Fetch-Site:
cross-site` requests (403) before `authorize` runs.

Because the engine cannot see fulfillment that happens outside it,
`config.on_paid` must be idempotent if any other path can also fulfill an
order — the generated initializer shows the guarded transition. The receive-only wallet URI loads from `ENV["NWC_URI"]`; your
application refuses to start when the connection advertises spend methods unless
`config.allow_spend_capable_wallet` or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC`
overrides it. Keep ordinary settings such as `config.price_currencies` in
`config/initializers/openreceive.rb`.

## Links

- Rails quickstart: [Connect your first checkout](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/quickstart-rails.md)
- API reference: [Configuration, hooks, and reconciliation](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/api-reference.md)
- Host testing: [Test your integration without a wallet](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/host-testing.md)
- Source and issues: <https://github.com/openreceive/openreceive>
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT license.
