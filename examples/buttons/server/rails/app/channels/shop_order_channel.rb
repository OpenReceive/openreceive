# frozen_string_literal: true

# One payer's own order, pushed: "your order is paid, re-read it".
#
# Possession of an order id is a claim, not proof — the id travels in every
# request body the payer's browser sends — so subscribing is authorized against
# the signed cookie, exactly as ShopController#authorized_order and
# `config.authorize` are. A stranger's subscription is REJECTED.
#
# Like the feed channel, the envelope carries no order data. The browser never
# learns from a message that it was fulfilled; it re-reads
# GET /shop/orders/:id, whose `download_path` appears only for a row that says
# `paid` — and that row is written inside OpenReceive's settlement transaction
# and nowhere else.
class ShopOrderChannel < ApplicationCable::Channel
  def subscribed
    order = ShopOrder.find_by_reference(params[:reference])
    return reject if order.nil?
    return reject unless connection.shop_user_id.present? &&
                         order.shop_user_id.to_s == connection.shop_user_id.to_s

    stream_for order.id
  end

  def self.broadcast_paid(reference)
    broadcast_to(reference, { "message" => "order-paid" })
  end
end
