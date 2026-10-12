# frozen_string_literal: true

require Rails.root.join("lib/button_shop/catalog_seed")

# A DATA migration: the prices went up so each button clears the swap
# providers' minimums. A database that 20260827000005 seeded keeps its old
# prices, and production does not run db:seed, so the same idempotent upsert
# from examples/buttons/shared/shop-catalog.json runs again here.
class RepriceShopProducts < ActiveRecord::Migration[8.1]
  class ShopProduct < ActiveRecord::Base
    self.table_name = "shop_products"
  end

  def up
    ButtonShop::CatalogSeed.apply!(ShopProduct)
  end

  def down
    # Rolling back keeps the new prices: the old ones are not stored anywhere.
  end
end
