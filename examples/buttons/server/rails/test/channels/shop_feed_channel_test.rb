# frozen_string_literal: true

require "test_helper"

# The public order feed, pushed. No identity required — that is most of the
# point of a feed every visitor can watch.
class ShopFeedChannelTest < ActionCable::Channel::TestCase
  include ButtonShopTestSetup

  test "a visitor with no cookie at all may subscribe" do
    stub_shop_connection(nil)
    subscribe

    assert subscription.confirmed?
    assert_has_stream ShopFeedChannel::STREAM
  end

  test "a visitor with a cookie subscribes to the same one stream" do
    stub_shop_connection(SecureRandom.uuid)
    subscribe

    assert subscription.confirmed?
    assert_has_stream ShopFeedChannel::STREAM
  end

  # The envelope says "something changed" and nothing else. The feed's payload
  # whitelist lives in ShopController#feed_payload, and a second serializer
  # here would be the obvious way to leak `download_path` or the order id into
  # a public broadcast.
  test "the envelope carries no order data" do
    assert_broadcast_on(ShopFeedChannel::STREAM, "message" => "orders-changed") do
      ShopFeedChannel.broadcast_orders_changed
    end
  end
end
