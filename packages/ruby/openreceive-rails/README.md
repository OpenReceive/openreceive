# openreceive-rails

A mountable **Rails engine** that ships [OpenReceive](https://openreceive.org)'s receive-only
checkout routes into a Rails app. Your app keeps 100% of its authentication: the engine controllers
inherit from your `ApplicationController`, so they get your CSRF protection, `authenticate_user!`,
and `current_user` for free. OpenReceive never inspects your session — it calls the `authorize` and
`resolve_order` hooks you configure and obeys them.

This gem builds on two gems you also depend on:

- [`openreceive`](../openreceive) — the dependency-free core (money math, settlement detection, NWC
  parsing, idempotency, capability-token hashing).
- [`openreceive-server`](../openreceive-server) — the `Service`, the ActiveRecord store, the config
  loader, the `Tokens::Manager`, the framework-neutral `RequestHandler`, and the `RackApp` adapter.

The engine **reuses** those — the controllers delegate to the server gem's `Service` and
`Tokens::Manager` through `OpenReceive::Server::RequestHandler`, the shared framework-neutral
request→response handler that the `RackApp` also delegates to, so the Rails controllers and the Rack
app stay byte-equal on the wire and cannot drift.

## Verification status (read this)

This build is **structure-complete and syntax-checked, but NOT integration-tested against a live
Rails app.** Mirroring how `openreceive-server`'s ActiveRecord store is documented:

- Every `.rb` file passes `ruby -c` (Syntax OK).
- The pure-Ruby units — `OpenReceive::Configuration` and the shared
  `OpenReceive::Server::RequestHandler` — are unit-tested **without Rails** (`test/rails_test.rb`).
- **NOT verified here (requires a live Rails app + database):** engine mounting, controller
  rendering / actual HTTP responses, the `openreceive:install` generator run, and migration
  execution. Rails is not installed in the build environment. Treat these as review-ready; exercise
  them in a real Rails app before production use.

## Install

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

The `openreceive:install` generator writes `config/initializers/openreceive.rb`, adds the `mount`
line to `config/routes.rb`, and copies the OpenReceive migrations into `db/migrate/` with fresh
timestamps.

## Migrate

```sh
bin/rails openreceive:install:migrations   # migrations-only slice of the install generator
bin/rails db:migrate
```

Migration 001 creates `openreceive_invoices` + the `openreceive_meta` KV table; migration 002 adds
the per-order capability-token column (`order_access_token_hash`). The migration superclass is
resolved to your Rails version at generate time (floor: **Rails 7.1**) as
`ActiveRecord::Migration[<version>]`. Each migration executes the canonical SQL statement-by-statement
and branches on the connection adapter (PostgreSQL / SQLite dialects). Rails records applied
migrations in its own `schema_migrations`; the engine ships no runner of its own.

## Configure

```ruby
# config/initializers/openreceive.rb
OpenReceive.configure do |config|
  # Engine controllers inherit from this — gives them CSRF + current_user.
  config.parent_controller = "ApplicationController"

  # Receive-only NWC connection (server-only; never sent to the browser or logged). Either a
  # connection string (built into an nwc-ruby client at first use) or a pre-built client:
  config.nwc = ENV.fetch("OPENRECEIVE_NWC")
  # config.nwc_client = Nwc::Client.new(connection_uri: ...)   # takes precedence over config.nwc
  config.namespace = "default"

  # Authorization. context = { action:, request:, resource:, token:, token_valid:, order_id? }.
  # `token_valid` is the handler-precomputed per-order token validity, so your policy never has to
  # touch the token manager — just read `context[:token_valid]` for Tier-2 gating.
  config.authorize = lambda do |context|
    case context[:action]
    when "checkout.create", "rate.list" then true          # Tier 1 (public)
    when "invoice.sweep" then context[:request].env["warden"]&.user&.admin?  # Tier 3 (privileged)
    else context[:token_valid]                                              # Tier 2 (owner token)
    end
  end

  # Amount authority — REQUIRED. NEVER trust a client price. Create body has no amount.
  config.resolve_order = ->(ctx) {
    order = Order.find_by(id: ctx[:order_id])
    return nil if order.nil? # → 404
    { usd: order.total_usd.to_s }
  }
end
```

### Configuration fields

| Field | Default | Purpose |
|-------|---------|---------|
| `parent_controller` | `"ActionController::Base"` | Superclass of the engine controllers (set `"ApplicationController"`). |
| `nwc` | `nil` | Receive-only NWC connection string **or** a duck-typed client. |
| `nwc_client` | `nil` | Explicit pre-built NWC client (takes precedence over `nwc`). |
| `namespace` | `"default"` | Store namespace (multi-tenant isolation). |
| `store` | ActiveRecord store | Invoice store; override with any store object. |
| `authorize` | `nil` → default policy | `->(context) { boolean }`. |
| `resolve_order` | **required** | Authoritative payment-terms hook (see below). |
| `rate_limit` | `nil` | `->(context) { allowed_boolean }`; `false` → 429. |
| `prefix` | `"/openreceive"` | Informational (Rails owns routing via `mount`). |
| `price_provider` | `nil` | Injected price feed (fiat + `/rates`). |
| `swap_providers` | `[]` | Scaffolded; swaps advertise as disabled. |
| `price_currencies` | `nil` | Currencies for `/rates`. |
| `logger` | `nil` | Optional logger (never receives the NWC secret). |

`resolve_order` is **required** (building the request handler without it raises). It accepts
**either** the single-context form `->(ctx) { ctx[:order_id] }` (ctx has `:order_id`,
`:client_amount`, `:metadata`, `:request`, `:action`) **or** the keyword form
`->(order_id:, client_amount:, metadata:, request:)` (identical to `RackApp`). Return one of
`{ amount: … }`, `{ sats: … }`, or `{ usd: … }`, or `nil` for 404. Client `amount` / `sats` /
`usd` on the create body are rejected with 400 — honor a payer-chosen amount inside the hook
(e.g. from `metadata`) if you need tip-jar / donation pricing.

### Ready-made policies (presets)

For the two common host shapes you can skip writing the `authorize` proc by hand and assign a
preset from `OpenReceive::Server::Presets` (the Ruby port of the `@openreceive/http` presets). Both
build on the precomputed `context[:token_valid]`, so neither touches the token manager:

```ruby
# Guest-checkout site (no accounts) / paywall: create is open, Tier-2 reads are gated on the order token (the
# httpOnly cookie set on create is enough), sweep is denied unless allow_sweep opts in.
config.authorize = OpenReceive::Server::Presets.guest_checkout
config.authorize = OpenReceive::Server::Presets.guest_checkout(allow_sweep: ->(ctx) { admin?(ctx) })

# Logged-in users: getUser resolves the request's user; a missing user is denied everything.
config.authorize = OpenReceive::Server::Presets.with_user(
  ->(request) { request.env["warden"]&.user },
  owns_order: ->(user, ctx) { user.owns_order?(ctx[:order_id]) }, # falls back to token_valid if omitted
  is_admin:   ->(user) { user.admin? }                            # gates invoice.sweep; denied if omitted
)
```

### Prefer a controller concern?

Instead of the `authorize` proc, include `OpenReceive::Authorization` in your own controller and
implement `openreceive_authorize(context)` there — it runs in controller context, so you have full
access to your auth helpers (`current_user`, Pundit/CanCanCan, `warden`, …):

```ruby
class ApplicationController < ActionController::Base
  include OpenReceive::Authorization

  def openreceive_authorize(context)
    case context[:action]
    when "checkout.create" then true
    when "invoice.sweep"   then current_user&.admin?
    else current_user&.owns_order?(context[:order_id])
    end
  end
end
```

The engine controllers gate every request through `openreceive_authorize`; its default delegates to
a superclass override (yours), then to `config.authorize`, then to the built-in fail-closed tier
policy.

## Mount + routes

```ruby
# config/routes.rb  (added for you by the generator)
mount OpenReceive::Engine => "/openreceive"
```

All under the mount prefix:

| Method | Path | Tier | Controller#action |
|--------|------|------|-------------------|
| POST | `/checkouts` | 1 | `checkouts#create` |
| GET  | `/checkouts/:checkout_id` | 2 | `checkouts#show` |
| POST | `/orders/:order_id` | 2 | `orders#perform` |
| GET  | `/orders/:order_id/swap-options` | 2 | `orders#swap_options` |
| GET  | `/rates` | 1 | `rates#index` |
| POST | `/admin/sweep` | 3 | `admin#sweep` |

## Security tiers & fail-closed policy

Default policy (when `config.authorize` is nil): **Tier 1** allow; **Tier 2** allow iff a valid
per-order capability token is presented (`Authorization: Bearer <token>`, `X-OpenReceive-Order-Token`,
or the order-token cookie below); **Tier 3** (`invoice.sweep`) **DENY** — fails closed. The
`order_access_token` is returned once, on the first checkout for an order.

**Order-token cookie.** On that first checkout the create response also sets an httpOnly cookie
(byte-identical to `@openreceive/http`):

```
Set-Cookie: openreceive_order_token=<token>; Path=/openreceive/orders/<order_id>; HttpOnly; SameSite=Lax; Max-Age=86400
```

`Secure` is appended when the request arrived over https (`rack.url_scheme == "https"` or
`X-Forwarded-Proto: https`). It is path-scoped to that order's route so a same-origin browser is
auto-authorized for its own order's Tier-2 reads with no client-side token handling. Token
extraction reads it back as the lowest-priority source — a header token always wins over the cookie.

When no `config.authorize` is set the app still boots, Tier 3 still returns 403, and the engine logs
a **loud error at boot** (`config.after_initialize`) so operators notice. We deliberately fail
closed at request time + log loudly rather than crash the host boot over a missing optional hook.

Error bodies are `{ "code", "message", "retryable"?, "request_id"? }` — identical to `RackApp`:
400 `INVALID_REQUEST`, 403 `UNAUTHORIZED`, 404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED`,
503 `WALLET_UNAVAILABLE`, 500 `INTERNAL` / `NOT_IMPLEMENTED` (scaffolded swaps + live price feeds).

## Non-Rails Ruby hosts

Not on Rails? Use `openreceive-server` directly — its `OpenReceive::Server::RackApp` implements the
same routes for Sinatra / Hanami / plain Rack, with the identical contract.

## Tests

```sh
ruby -Ipackages/ruby/openreceive/lib \
     -Ipackages/ruby/openreceive-server/lib \
     -Ipackages/ruby/openreceive-rails/lib \
     packages/ruby/openreceive-rails/test/rails_test.rb
```
