# frozen_string_literal: true

# Host fulfillment stub. Runs inside the OpenReceive settlement transaction,
# only for the order's first settled attempt.
#
# The state transition is the lock. OpenReceive serializes its own settlement
# paths, but it cannot see fulfillment triggered anywhere else - an admin
# action, a second processor, a replayed job - so the write that flips
# pending_payment -> paid is guarded, and only the transaction that wins it
# goes on to ship. Every OpenReceive integration should look like this; see
# the note in db/migrate/*_create_openreceive_tables.rb.
module FulfillOrder
  module_function

  def call(order_id, payment_hash:)
    claimed = Order.where(id: order_id, status: "pending_payment").update_all(status: "paid")
    if claimed.zero?
      Rails.logger.info(
        "[hello-fruit-rails] order=#{order_id} was already fulfilled; nothing to do"
      )
      return false
    end

    order = Order.find(order_id)
    Rails.logger.info(
      "[hello-fruit-rails] fulfilled order=#{order.id} payment_hash=#{payment_hash}"
    )
    # This runs inside the settlement transaction; broadcast only after commit
    # so a browser poll triggered by the push can never read the old status.
    ActiveRecord.after_all_transactions_commit { order.broadcast_order_update }
    true
  end
end
