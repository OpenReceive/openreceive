# frozen_string_literal: true

# Per-order stream keyed by the order id (the same unguessable id the
# /checkout/:order_id resume URL uses). Envelope format matches the frontend
# bridge: { "message" => ..., "data" => ... }.
class OrderChannel < ApplicationCable::Channel
  def subscribed
    order = Order.find_by(id: params[:order_id])
    return reject if order.nil?

    stream_for order.id
  end
end
