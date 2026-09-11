# openreceive-server

**Accept Bitcoin Lightning payments in Ruby and Rack. Your app, your wallet.**

[OpenReceive](https://openreceive.org) brings Lightning checkout to your existing
Ruby application. Receive payments directly into a wallet you control, while
keeping your orders, prices, and fulfillment in your own code.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

- Create invoices and check payments through a receive-only Nostr Wallet
  Connect (NWC) client.
- Use the payment service directly or mount the framework-agnostic Rack handler.
- Reconcile pending payments with shared settlement rules and exact money math.
- Keep your existing persistence stack, with no separate OpenReceive service
  or database to deploy.

**Building with Rails?** Start with
[`openreceive-rails`](https://github.com/OpenReceive/openreceive/blob/master/packages/ruby/openreceive-rails/README.md): it adds payment storage,
reconciliation, and an install generator on top of this gem.

## Install

Requires Ruby 3.2 or later. Add to your Gemfile and run `bundle install`:

```ruby
gem "openreceive-server"
```

For a custom integration, provide your NWC client, payment repository, and
application hooks. The service itself has no persistence dependency.

## Connect your application

Configure a receive-only NWC client. The host
authorizes requests, resolves order amounts, commits payment hashes before responding, and
consumes at-least-once verified payment events by hash. The service refuses to start when the
NWC connection advertises spend methods (`pay_invoice`, `multi_pay_invoice`,
`pay_keysend`, `multi_pay_keysend`) unless
`allow_spend_capable_wallet` or `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC` overrides it; the
shared reconciliation decision table lives in `OpenReceive::Server::Reconciliation`.

## Minimal Rack example

```ruby
# config.ru — run with: rackup
require "openreceive/server"

service = OpenReceive::Server::Service.new(nwc_client: MyNwcClient.new)

run OpenReceive::Server::RackApp.new(
  service: service,
  # context is a Hash: context[:action] is the route name ("checkout.create",
  # "payment.check", …), context[:request] is the Rack env, and
  # context[:resource] is { reference:, payment_hash: } copied from the
  # payer's body — it names an order, it does not prove ownership. reference
  # is always a validated non-empty String (≤200 chars); payment_hash is nil
  # except on payment.check / swap.read / swap.refund.
  # Return true to allow, false for a 403.
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

## Links

- API reference: [Ruby and Rails APIs](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/api-reference.md)
- Rails quickstart: [Use the engine with built-in persistence](https://github.com/OpenReceive/openreceive/blob/master/docs/guides/quickstart-rails.md)
- Source and issues: <https://github.com/openreceive/openreceive>
- Changelog: [CHANGELOG.md](CHANGELOG.md)

MIT license.
