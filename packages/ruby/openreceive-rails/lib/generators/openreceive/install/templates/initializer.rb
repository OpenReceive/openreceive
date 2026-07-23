# frozen_string_literal: true

OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  # nwc loads from the root openreceive.yml. Set config.nwc only for an explicit override.
  # Validate the host-owned order price for checkout.create / swap.create.
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

  config.resolve_checkout = lambda do |action:, request:, order_id:, input:, pay_in_asset: nil|
    order = Order.find(order_id)
    {
      amount: { currency: "USD", value: order.total.to_s },
      payment_hash: order.payment_hash,
      swap_data: order.swap_data
    }.compact
  end

  # Atomically store payment_hash (and server-only swap_data when present) on your order.
  # Raise if persistence fails: OpenReceive will withhold payer instructions.
  config.on_checkout_created = lambda do |order_id:, payment_hash:, swap_data: nil, **|
    order = Order.lock.find(order_id)
    raise "order already has a different payment hash" if order.payment_hash.present? && order.payment_hash != payment_hash
    order.update!(
      payment_hash: payment_hash,
      swap_data: swap_data
    )
  end
end
