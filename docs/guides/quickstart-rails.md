# Rails quickstart

Add `payment_hash` (unique, nullable), `paid_at` (nullable), and optionally
`swap_data` (JSON/text, server-only) to your existing order model. These are host migrations, not
OpenReceive migrations.

Put the receive-only `nwc` value in the root `openreceive.yml`, then configure the host hooks:

```ruby
OpenReceive.configure do |config|
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }
  config.resolve_checkout = lambda do |order_id:, **|
    order = Order.find(order_id)
    {
      amount: { currency: order.currency, value: order.total.to_s },
      payment_hash: order.payment_hash,
      swap_data: order.swap_data
    }.compact
  end
  config.on_checkout_created = lambda do |order_id:, payment_hash:, swap_data: nil, **|
    Order.find(order_id).commit_payment_attempt!(payment_hash, swap_data)
  end
end
```

Reconciliation calls the host by verified payment hash. Set `paid_at` only if it is null and
make fulfillment replay-safe.
Returning an existing live `payment_hash` is what makes create retries reuse the same wallet
checkout. `commit_payment_attempt!` must use a row lock or compare-and-set.
