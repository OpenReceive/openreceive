# frozen_string_literal: true

# The public order feed, pushed.
#
# One stream for everybody, because the response it stands for is one public,
# identical-for-everyone payload. No identity is required to subscribe.
#
# THE ENVELOPE CARRIES NO ORDER DATA — only "something changed". That is not
# laziness: the feed's whitelist lives in exactly one place
# (ShopController#feed_payload), and a second serializer here would be the
# obvious way to leak `download_path` or the order id into a public broadcast.
# Subscribers re-read GET /shop/recent_orders, which is already cached for ten
# seconds, so a burst of settlements collapses into one query per visitor.
class ShopFeedChannel < ApplicationCable::Channel
  STREAM = "shop_feed"

  def subscribed
    stream_from STREAM
  end

  def self.broadcast_orders_changed
    ActionCable.server.broadcast(STREAM, { "message" => "orders-changed" })
  end
end
