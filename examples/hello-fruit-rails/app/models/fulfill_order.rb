# frozen_string_literal: true

# Host fulfillment stub. Runs inside the OpenReceive settlement transaction,
# only for the order's first settled attempt.
module FulfillOrder
  module_function

  def call(order, payment_hash:)
    order.mark_paid!
    Rails.logger.info(
      "[hello-fruit-rails-quickstart] fulfilled order=#{order.id} payment_hash=#{payment_hash}"
    )
  end
end
