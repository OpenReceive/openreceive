# frozen_string_literal: true

# Seed Product rows from the shared Hello Fruit catalog — do not duplicate prices here.
catalog_path = Rails.root.join("../../shared/fruits.json")
catalog = JSON.parse(File.read(catalog_path))

catalog.fetch("fruits").each do |fruit|
  Product.find_or_initialize_by(id: fruit.fetch("id")).tap do |product|
    product.name = fruit.fetch("name")
    product.sticker_path = fruit.fetch("sticker")
    product.price_currency = fruit.dig("fiat", "currency")
    product.price_value = BigDecimal(fruit.dig("fiat", "value"))
    product.save!
  end
end

Rails.logger.info("[hello-fruit-rails] seeded #{Product.count} products from #{catalog_path}")
