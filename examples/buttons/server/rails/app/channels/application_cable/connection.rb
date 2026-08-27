# frozen_string_literal: true

module ApplicationCable
  # The websocket upgrade is an ordinary request, so it carries the same signed
  # cookie every other request does — and `cookies.signed` here verifies it
  # against the same key generator ShopIdentity uses.
  #
  # There is deliberately no `identified_by` and no
  # `reject_unauthorized_connection`. A visitor with no cookie at all must still
  # be able to watch the PUBLIC order feed, which is most of the point of it.
  # Authorization is per channel: ShopFeedChannel needs none, ShopOrderChannel
  # requires that the order belong to this browser — the same rule
  # `config.authorize` and `ShopController#authorized_order` apply.
  class Connection < ActionCable::Connection::Base
    # Read once per connection. A tampered or absent value reads as nil, which
    # is a visitor who may watch the feed and nobody's orders.
    def shop_user_id
      return @shop_user_id if defined?(@shop_user_id)

      @shop_user_id = cookies.signed[ShopIdentity::COOKIE].presence
    end
  end
end
