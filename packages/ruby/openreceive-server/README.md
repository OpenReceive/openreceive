# openreceive-server

Server building blocks for [OpenReceive](https://openreceive.org) in Ruby: the checkout/order
**Service** that mirrors the Node engine, a durable **ActiveRecord invoice store**, per-order
**capability tokens**, a **config loader**, and a framework-agnostic **Rack app** implementing the
shipped HTTP routes.

This gem builds on the dependency-free core gem [`openreceive`](../openreceive) and **reuses** its
primitives (`Money`, `Settlement`, `Nwc`, `Idempotency`, `InMemoryInvoiceKvStore`, the error
classes, and `NwcRubyReceiveClient`) rather than reimplementing them. For Rails hosts, the separate
`openreceive-rails` gem mounts this as an engine.

## Receive-only invariant

OpenReceive **receives** Lightning payments; it never spends. Nothing in this gem exposes a spend
method, and the NWC connection secret stays server-side — it is never logged and never placed in a
wire payload. The NWC transport is the `nwc-ruby` gem, injected into the core
`OpenReceive::NwcRubyReceiveClient` (which only ever reaches `make_invoice` + `list_transactions`).

## Injecting an `nwc-ruby` client

```ruby
require "openreceive/server"
require "nwc" # the nwc-ruby gem

nwc_uri = ENV.fetch("OPENRECEIVE_NWC")            # receive-only NWC connection string
raw = Nwc::Client.new(connection_uri: nwc_uri)    # the nwc-ruby client (duck-typed)

service = OpenReceive::Server::Service.new(
  nwc_client: raw,                                # wrapped in NwcRubyReceiveClient automatically
  store: OpenReceive::Server::InMemoryInvoiceStore.new,
  namespace: "acme-shop",
  price_provider: my_price_provider               # optional; required for fiat + /rates
)

checkout = service.get_or_create_checkout("order_id" => "order-123", "sats" => 2100)
order    = service.get_order(order_id: "order-123")
```

`nwc_client:` may be either a raw `nwc-ruby` client (it is wrapped in `NwcRubyReceiveClient`
for you) or an already-constructed `OpenReceive::NwcRubyReceiveClient`.

## What is implemented vs. scaffolded

**Fully implemented (Lightning / checkout path):**

- `get_or_create_checkout`, `get_checkout`, `get_order`, `order` (status action)
- Per-order idempotency (`invoice.create`, key `"<order>:super:<supersededId|none>:amt:<amountKey>"`)
- Checkout supersede + replay
- The bounded, cursor-gated pending-invoice transaction scan (`sweep_pending_invoices`),
  matching `spec/test-vectors/transaction-scan-pagination.json` (single incoming/unpaid page per
  durable gate claim, 60 s overlap, default limit 25, cursor in meta via `cas_meta`, cursor stable
  on wallet error/timeout). Settlement authority is this backend status refresh — never a
  notification.
- BTC/SATS amount resolution, and fiat resolution through an injected `price_provider`.
- Per-order capability tokens (`Tokens`) — `hash_token` is byte-for-byte the JS
  `hashOrderAccessToken` (`sha256:<64 hex>` of the raw token).

**Scaffolded — raise `NotImplementedError` with a clear message (the Node engine is the reference):**

- **Swaps.** `swap_options` returns `{ "enabled" => false, "options" => [] }`; `swap_quote`,
  `start_swap`, `refund_swap`, and the `swap_quote`/`start_swap`/`refund_swap` order actions raise.
- **Live price feeds.** `list_rates` / `quote_rates` require an injected `price_provider`; without
  one they raise. No live price fetching is implemented here.

## Stores

- `OpenReceive::Server::InMemoryInvoiceStore` — subclasses the core `InMemoryInvoiceKvStore` and
  adds `list_by_order_id`, `list_by_checkout_id`, `list_open`, `ensure_schema`, and
  `mark_superseded` (the reads/writes the service needs). Great for tests and single-process hosts.
- `OpenReceive::Server::ActiveRecordInvoiceStore` — same logical API against the normalized
  `openreceive_invoices` + `openreceive_meta` tables (migrations `001_*` / `002_*`). The file loads
  cleanly whether or not ActiveRecord is present (a stub raises a clear error if the gem is absent).
  **Not yet integration-tested against a live database** — review-ready, but exercise it before
  production use.

## HTTP (Rack) routes

`OpenReceive::Server::RackApp` implements the shipped contract
(`spec/openapi/openreceive-http.v1.yaml`) against the bare `call(env)` protocol — it does **not**
require the `rack` gem.

```ruby
tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "acme-shop")

app = OpenReceive::Server::RackApp.new(
  service: service,
  tokens: tokens,
  # The client amount is UNTRUSTED. get_order_amount returns the authoritative amount.
  get_order_amount: ->(order_id:, client_amount:, metadata:, request:) {
    { "sats" => MyCart.total_sats(order_id) }
  },
  authorize: ->(context) { my_policy.allow?(context) }, # optional; see tiers below
  prefix: "/openreceive"
)
```

Routes (mounted under `prefix`):

| Method | Path                                 | Tier | Action           |
|--------|--------------------------------------|------|------------------|
| POST   | `/checkouts`                         | 1    | `checkout.create`|
| POST   | `/orders/{order_id}`                 | 2    | `order.read` / `swap.*` |
| GET    | `/checkouts/{checkout_id}`           | 2    | `checkout.read`  |
| GET    | `/orders/{order_id}/swap-options`    | 2    | `swap.options`   |
| GET    | `/rates`                             | 1    | `rate.list`      |
| POST   | `/admin/sweep`                       | 3    | `invoice.sweep`  |

Default `authorize`: **Tier 1** allow; **Tier 2** allow iff a valid per-order capability token is
presented (`Authorization: Bearer <token>` or `X-OpenReceive-Order-Token`); **Tier 3 denies**
(fails closed — the host must supply an `authorize` hook that opts in). The `order_access_token` is
returned only on the first checkout for an order.

Error bodies are `{ "code", "message", "retryable"?, "request_id"? }` with `code` in the
`error.schema.json` enum. Status mapping: 400 `INVALID_REQUEST`, 403 `UNAUTHORIZED`,
404 `NOT_FOUND`, 409 `CONFLICT`, 429 `RATE_LIMITED`, 503 `WALLET_UNAVAILABLE`, 500 `INTERNAL`
(and `NOT_IMPLEMENTED` for the scaffolded paths).

## Config

```ruby
config = OpenReceive::Server::Config.load(path: "openreceive.yml", env: ENV)
```

Reads the same keys as the Node config (`OPENRECEIVE_NWC` / `_NAMESPACE` / `_STORE` /
`_PRICE_CURRENCIES`, plus nested `operation`, `swap`, `logging`). The NWC secret is stored but never
exposed by `#inspect` / `#to_s`.

## Tests

```
ruby -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib \
  packages/ruby/openreceive-server/test/server_test.rb
```
