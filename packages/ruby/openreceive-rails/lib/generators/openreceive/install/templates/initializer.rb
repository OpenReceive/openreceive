# frozen_string_literal: true

OpenReceive.configure do |config|
  config.parent_controller = "ApplicationController"
  # Secrets load from NWC_URI, LSC_URI_PRIMARY, and LSC_URI_BACKUP.
  # Keep ordinary settings here in the Rails initializer.
  config.price_currencies = ["USD"]
  # Validate the host-owned order price for checkout.create / swap.create.
  config.authorize = ->(context) { OpenReceiveOrderPolicy.authorized?(context) }

  config.resolve_checkout = lambda do |action:, request:, order_id:, input:, pay_in_asset: nil|
    order = <%= order_model_name %>.find(order_id)
    requested_hash = input["payment_hash"] || input[:payment_hash]
    payment =
      if action == "swap.quote"
        nil
      else
        OpenReceivePayment.selected_for(
          order_id: order.id,
          action: action,
          payment_hash: requested_hash
        )
      end
    if requested_hash.present? && payment.nil?
      raise OpenReceive::Server::NotFoundError, "Payment attempt not found for this order."
    end
    if payment && action == "checkout.create" && payment.swap_data.present?
      raise OpenReceive::Server::ConflictError, "This order already has a live swap attempt."
    end
    if payment && action == "swap.create" && payment.swap_data.blank?
      raise OpenReceive::Server::ConflictError, "This order already has a live Lightning attempt."
    end
    if payment && action == "swap.create" && pay_in_asset.present?
      stored_asset =
        payment.swap_data&.dig("providerOrder", "pay_in_asset") ||
        payment.swap_data&.dig("provider_order", "pay_in_asset")
      if stored_asset.present? && stored_asset != pay_in_asset
        raise OpenReceive::Server::ConflictError,
              "This order already has a live swap attempt for another asset."
      end
    end

    {
      amount: { currency: "USD", value: order.total.to_s },
      payment_hash: payment&.payment_hash,
      checkout: payment&.checkout_data,
      swap_data: payment&.swap_data
    }.compact
  end

  # Atomically append one payment-attempt row. OpenReceivePayment locks the
  # existing order row so concurrent creates cannot expose two live invoices.
  config.on_checkout_created = lambda do |order_id:, payment_hash:, checkout:, swap_data: nil, **|
    order = <%= order_model_name %>.find(order_id)
    OpenReceivePayment.commit_attempt!(
      order: order,
      payment_hash: payment_hash,
      checkout: checkout,
      swap_data: swap_data
    )
  end

  config.on_paid = lambda do |event|
    OpenReceivePayment.mark_paid_once!(
      payment_hash: event.fetch("payment_hash"),
      paid_at: event.fetch("paid_at")
    ) do |order, payment, first_for_order|
      # Replace with the host's in-transaction order transition or outbox insert.
      FulfillOrder.call(order, payment: payment) if first_for_order
    end
  end
end

# Run `reconcile_payments` from the host's normal job system with the currently
# unsettled OpenReceivePayment hashes and created_at timestamps. Deliver each
# settled result through OpenReceive.config.on_paid.
