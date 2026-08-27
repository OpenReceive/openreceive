# frozen_string_literal: true

require Rails.root.join("lib/button_shop/catalog_seed")

# A DATA migration: the six buttons, from
# examples/buttons/shared/shop-catalog.json — the one file every stack's
# seed reads.
#
# The migration-local model is deliberate. A data migration that reaches for
# app/models/ShopProduct breaks the day that model grows a validation these rows
# predate, or is renamed, or is deleted. Migrations are a record of what the
# schema WAS.
class SeedShopProducts < ActiveRecord::Migration[8.1]
  class ShopProduct < ActiveRecord::Base
    self.table_name = "shop_products"
  end

  def up
    ButtonShop::CatalogSeed.apply!(ShopProduct)
  end

  def down
    ShopProduct.where(sku: ButtonShop::CatalogSeed.entries.map { |e| e.fetch("sku") }).delete_all
  end
end
