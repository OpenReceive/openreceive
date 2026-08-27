# frozen_string_literal: true

# One SKU on one order, at the name and price it carried when the cart was
# placed.
#
# `product_id` is a nullable FK and sku / name / unit_price_cents are
# SNAPSHOTS beside it. The FK is for joins; the snapshot is what renders. Two
# things depend on that split:
#
#   - an item row must stay readable after its product is deactivated or
#     deleted, so a receipt, a download and a public feed row all survive a
#     catalog edit;
#   - history must not move when the catalog does. Renaming "Signal Red" must
#     not retroactively rewrite what somebody bought last week, and a price
#     change must not silently re-price an order that is already awaiting
#     payment.
class ShopOrderItem < ApplicationRecord
  belongs_to :shop_order, inverse_of: :items
  belongs_to :product, class_name: "ShopProduct", optional: true,
             inverse_of: :shop_order_items

  validates :sku, presence: true
  validates :name, presence: true
  validates :quantity, numericality: { only_integer: true, greater_than: 0 }
  validates :unit_price_cents, numericality: { only_integer: true, greater_than: 0 }

  def line_total_cents
    unit_price_cents * quantity
  end
end
