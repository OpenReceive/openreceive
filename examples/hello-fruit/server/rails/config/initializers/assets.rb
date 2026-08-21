# frozen_string_literal: true

# JS/CSS ship through Shakapacker's manifest in public/packs; Propshaft only
# serves anything left under app/assets (demo images).
Rails.application.config.assets.version = "1.0"
Rails.application.config.assets.excluded_paths << Rails.root.join("app/assets/stylesheets")
