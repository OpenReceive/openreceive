# frozen_string_literal: true

require Rails.root.join("lib/button_shop/catalog_seed")

# The same six rows the data migration wrote, applied idempotently so a
# developer who has just run `bin/rails db:reset` has a catalog without
# remembering a second command. Production does not run db:seed on deploy,
# which is why the data migration exists as well.
count = ButtonShop::CatalogSeed.apply!(ShopProduct)

Rails.logger.info(
  "[buttons-rails] seeded #{count} products from #{ButtonShop::CatalogSeed.path}"
)
