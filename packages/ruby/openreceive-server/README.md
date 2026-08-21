# openreceive-server

Storage-free Ruby service and Rack handler. Configure a receive-only NWC client. The host
authorizes requests, resolves order amounts, commits payment hashes before responding, and
consumes at-least-once verified payment events by hash. Service boot fails closed when the
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
  resolve_checkout: lambda do |action:, request:, order_id:, input:, pay_in_asset: nil|
    order = MyOrders.find(order_id) or raise OpenReceive::Server::NotFoundError, "Order not found."
    { "amount" => { "currency" => "USD", "value" => order.total } }
    # Return payment_hash/checkout/swap_data for committed attempts on
    # non-create actions; see the Rails engine for a full repository.
  end,
  on_checkout_created: ->(order_id:, payment_hash:, checkout:, swap_data: nil, client_ip: nil) {
    MyPayments.commit!(order_id:, payment_hash:, checkout:, swap_data:, client_ip:)
  },
  on_paid: ->(event) { MyPayments.settle_once!(event) }
)
```

Rack hosts own attempt persistence and replay-safe settlement (the Rails
engine ships both; see `openreceive-rails`). Rack hosts that want opportunistic
settlement call `OpenReceive.maybe_reconcile!` (or their own gated pass) from
their middleware — `RackApp` deliberately has no built-in hook.
