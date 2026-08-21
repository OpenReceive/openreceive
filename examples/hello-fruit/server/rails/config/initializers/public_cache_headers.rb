# frozen_string_literal: true

require Rails.root.join("lib/hello_fruit/public_cache_headers")

# Wrap ActionDispatch::Static so digested Propshaft files and the HTML shell do
# not share one Cache-Control. In development/test Propshaft::Server already
# sends immutable for digested URLs; this still covers production public/.
Rails.application.config.middleware.insert_before(
  ActionDispatch::Static,
  HelloFruit::PublicCacheHeaders
)
