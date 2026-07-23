# frozen_string_literal: true

OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  config.nwc = ENV.fetch("OPENRECEIVE_NWC", nil)
  raw_token_keys = ENV["OPENRECEIVE_TOKEN_KEYS"]
  config.token_keys = raw_token_keys.to_s.empty? ? [] : OpenReceive::Server::Tokens.parse_keyring(raw_token_keys)

  # Validate the host-owned order price for checkout.create / swap.create.
  config.authorize = lambda do |context|
    context[:token_valid] == true || %w[checkout.create swap.quote swap.create].include?(context[:action])
  end

  config.resolve_checkout_amount = lambda do |action:, request:, order_id:, input:, pay_in_asset: nil|
    order = Order.find(order_id)
    {
      amount: { currency: "USD", value: order.total.to_s },
      payment_hash: order.payment_hash,
      swap_recovery_token: order.openreceive_swap_recovery_token
    }.compact
  end

  # Atomically store payment_hash (and swap_recovery_token when present) on your order.
  # Raise if persistence fails: OpenReceive will withhold payer instructions.
  config.on_checkout_created = lambda do |order_id:, payment_hash:, swap_recovery_token: nil, **|
    order = Order.lock.find(order_id)
    raise "order already has a different payment hash" if order.payment_hash.present? && order.payment_hash != payment_hash
    order.update!(
      payment_hash: payment_hash,
      openreceive_swap_recovery_token: swap_recovery_token
    )
  end
end
