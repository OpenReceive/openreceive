# frozen_string_literal: true

# A visitor, remembered by a signed cookie holding `id`. No email, no name, no
# password, no IP, no OAuth. A user with no credentials is the feature: the row
# exists so an order can outlive a browser session, and so the public feed has
# something anonymous to attribute a purchase to.
#
# TWO UUIDS, ON PURPOSE. `id` is the ownership token that travels in the signed
# cookie and is never rendered anywhere; `public_ref` is the handle the feed
# shows.
#
# Not because publishing `id` would be exploitable — the cookie is signed, so
# knowing its plaintext buys nothing. Because a published `id` stops being safe
# the moment ANYTHING else accepts a bare uuid: a debug parameter, an admin
# lookup, a well-meaning "simplification" to an unsigned cookie. One column
# removes the whole category, and this demo exists to be copied from.
class ShopUser < ApplicationRecord
  has_many :shop_orders, dependent: :destroy, inverse_of: :shop_user

  # How long a row may go untouched before `touch_seen!` writes again.
  SEEN_THROTTLE = 5.minutes

  # Throttled: a page load is a dozen requests and remembering "last seen" must
  # not be a write storm. `update_column` on purpose — no validations, no
  # callbacks, no updated_at churn for a timestamp nothing reads transactionally.
  def touch_seen!
    return if last_seen_at && last_seen_at > SEEN_THROTTLE.ago

    update_column(:last_seen_at, Time.current)
  end
end
