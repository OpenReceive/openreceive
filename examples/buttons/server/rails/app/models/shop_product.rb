# frozen_string_literal: true

# The six OR buttons, as rows. THIS IS THE PRICE AUTHORITY: `config.amount_for`
# reads it through ShopOrder, and nothing a payer sends can reach it. The cart
# that arrives on POST /shop/orders carries a SKU and a quantity and nothing
# else — a price never comes off the wire.
#
# A button is virtual: the payer downloads the image after settlement. So the
# artwork filename lives on the ROW rather than being derived from the SKU,
# because a derivation is what stops a product ever having a download that
# differs from its thumbnail, or two products sharing one photo. The convention
# stays as the DEFAULT (`default_image_name` below) so the seed data stays
# short.
#
# This table is read fresh on every order creation. Do NOT memoize it at class
# or module level: reading it live is the entire point of moving prices out of
# code and into a table an operator can edit.
class ShopProduct < ApplicationRecord
  # A cart is a few buttons, not a wholesale order.
  MAX_PER_SKU = 10

  SKU_PATTERN = /\A[a-z]+(?:-[a-z]+)*\z/

  # nullify, not destroy: an item row must stay readable after its product is
  # gone. The FK is for joins; the snapshots on the item are what renders.
  has_many :shop_order_items, foreign_key: :product_id, dependent: :nullify,
           inverse_of: :product

  scope :active, -> { where(active: true) }
  scope :ordered, -> { order(:position, :price_cents) }

  validates :sku, presence: true, uniqueness: true, format: { with: SKU_PATTERN }
  validates :name, presence: true
  validates :price_cents, numericality: { only_integer: true, greater_than: 0 }
  validates :image_name, presence: true

  before_validation :default_image_name

  # Look a SKU up in the LIVE, active catalog.
  #
  # `active: false` hides a product from the catalog and from order creation. It
  # must NOT break an existing order's receipt, its download, or its row in the
  # public feed — that is what the snapshots on shop_order_items are for, and it
  # has a test.
  def self.active_by_sku(sku)
    return nil unless sku.is_a?(String) && sku.match?(SKU_PATTERN)

    active.find_by(sku: sku)
  end

  # A decimal string, never a float. Money is integer cents everywhere and the
  # division happens once, here, at the edge.
  def price_dollars
    format("%.2f", price_cents / 100.0)
  end

  private

  # The convention as a default, not as a derivation. Leave image_name blank in
  # a seed and this fills it in; set it and it is respected, which is what lets
  # a later higher-resolution download be added without renaming anything.
  def default_image_name
    return if image_name.present? || sku.blank?

    self.image_name = "openreceive-#{sku}-button.webp"
  end
end
