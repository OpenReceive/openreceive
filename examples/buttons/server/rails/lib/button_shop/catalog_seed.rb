# frozen_string_literal: true

require "json"

module ButtonShop
  # The six buttons, from the ONE catalog file every stack's data migration
  # reads: examples/buttons/shared/shop-catalog.json. There is no drift check
  # because there is nothing to drift from — that file is the source of truth.
  #
  # Idempotent by sku, so the data migration and `bin/rails db:seed` can both
  # run it and a developer resetting their database does not have to remember a
  # second command. Production does not run db:seed on deploy, which is why
  # both exist rather than one.
  module CatalogSeed
    module_function

    def path
      Rails.root.join("../../shared/shop-catalog.json").expand_path
    end

    def entries
      JSON.parse(File.read(path))
    end

    # `model` is passed in so the data migration can hand over its own
    # migration-local class: a migration that reaches for the app's ShopProduct
    # breaks the day that model gains a validation the old rows cannot satisfy.
    def apply!(model)
      entries.each do |entry|
        record = model.find_or_initialize_by(sku: entry.fetch("sku"))
        record.name = entry.fetch("name")
        record.price_cents = entry.fetch("price_cents")
        record.position = entry.fetch("position")
        record.image_name = entry.fetch("image_name")
        record.active = true
        record.save!
      end

      entries.length
    end
  end
end
