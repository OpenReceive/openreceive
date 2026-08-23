# openreceive-server

Storage-free Ruby service and Rack handler. Configure a receive-only NWC client. The host
authorizes requests, resolves order amounts, commits payment hashes before responding, and
consumes at-least-once verified payment events by hash. The service refuses to start when the
NWC connection advertises spend methods (`pay_invoice`/`multi_pay_invoice`) unless
`allow_spend_capable_wallet` or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC` overrides it; the
shared reconciliation decision table lives in `OpenReceive::Server::Reconciliation`.

## Minimal Rack example

```ruby
# config.ru — run with: rackup
require "openreceive/server"

service = OpenReceive::Server::Service.new(nwc_client: MyNwcClient.new)

run OpenReceive::Server::RackApp.new(
  service: service,
  authorize: ->(context) { my_policy_allows?(context) },
  resolve_checkout: lambda do |action:, request:, reference:, input:, pay_in_asset: nil|
    order = MyOrders.find(reference) or raise OpenReceive::Server::NotFoundError, "Unknown reference."
    { "amount" => { "currency" => "USD", "value" => order.total } }
    # Return payment_hash/checkout/swap_data for committed attempts on
    # non-create actions; see the Rails engine for a full repository.
  end,
  on_checkout_created: ->(reference:, payment_hash:, checkout:, swap_data: nil, client_ip: nil) {
    MyPayments.commit!(reference:, payment_hash:, checkout:, swap_data:, client_ip:)
  },
  on_paid: ->(event) { MyPayments.settle_once!(event) }
)
```

Rack hosts own attempt persistence and replay-safe settlement (the Rails
engine ships both; see `openreceive-rails`). Rack hosts that want opportunistic
settlement run their own gated pass from middleware: feed the pending attempts
they store to `service.reconcile_payments({ attempts:, max_pages:, deadline: })`
and apply the per-hash results through `on_paid` — `RackApp` deliberately has
no built-in hook, and the durable-gate convenience (`OpenReceive.maybe_reconcile!`)
ships only with the Rails engine.
