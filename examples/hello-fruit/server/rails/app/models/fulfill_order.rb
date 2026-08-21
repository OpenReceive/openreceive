# frozen_string_literal: true

# Host fulfillment stub. Runs inside the OpenReceive settlement transaction,
# only for the order's first settled attempt.
module FulfillOrder
  module_function

  def call(order, payment_hash:)
    order.mark_paid!
    Rails.logger.info(
      "[hello-fruit-rails] fulfilled order=#{order.id} payment_hash=#{payment_hash}"
    )
    # This runs inside the settlement transaction; broadcast only after commit
    # so a browser poll triggered by the push can never read the old status.
    ActiveRecord.after_all_transactions_commit { order.broadcast_order_update }
  end
end
