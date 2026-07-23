# Rails quickstart

Add `payment_hash` (unique, nullable), `paid_at` (nullable), and optionally
`openreceive_swap_recovery_token` to your existing order model. These are host migrations, not
OpenReceive migrations.

Configure the engine with receive-only NWC, a token keyring, and host hooks:

```ruby
OpenReceive.configure do |config|
  config.nwc = ENV.fetch("OPENRECEIVE_NWC")
  config.token_keys = OpenReceive::Server::Tokens.parse_keyring(
    ENV.fetch("OPENRECEIVE_TOKEN_KEYS")
  )
  config.authorize = ->(context) { context[:token_valid] || context[:action] == "checkout.create" }
  config.resolve_checkout_amount = lambda do |order_id:, **|
    order = Order.find(order_id)
    {
      amount: { currency: order.currency, value: order.total.to_s },
      payment_hash: order.payment_hash,
      swap_recovery_token: order.openreceive_swap_recovery_token
    }.compact
  end
  config.on_checkout_created = lambda do |order_id:, payment_hash:, swap_recovery_token: nil, **|
    Order.find(order_id).commit_payment_attempt!(payment_hash, swap_recovery_token)
  end
end
```

Reconciliation calls the host by verified payment hash. Set `paid_at` only if it is null and
make fulfillment replay-safe.
Returning an existing live `payment_hash` is what makes create retries reuse the same wallet
checkout. `commit_payment_attempt!` must use a row lock or compare-and-set.
