# frozen_string_literal: true

require_relative "lib/openreceive/rails/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-rails"
  spec.version = OpenReceive::Rails::VERSION
  spec.summary = "Accept Bitcoin Lightning payments in Rails. Your app, your wallet."
  spec.description = <<~TEXT
    Add Bitcoin Lightning checkout to your Rails app and receive payments directly
    into a wallet you control. Mount the engine, connect a receive-only Nostr Wallet
    Connect (NWC) wallet, and wire up three hooks for authorization, order amounts,
    and fulfillment.

    Optional swaps let customers pay with USDT, USDC, SOL, and ETH through a
    configured provider; you receive BTC over Lightning in your wallet. Available
    assets and networks depend on the provider.

    OpenReceive handles invoices, payment attempts, and settlement reconciliation
    using your existing application database. Keep your orders,
    users, prices, and fulfillment in your app, with no separate OpenReceive database,
    Redis, or payment service to deploy. Includes an install generator, PostgreSQL,
    SQLite, and MySQL support, plus an optional wallet-notifications worker.
  TEXT
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  # skills/ is the agent-skills copy kept in sync by `npm run generate:skills`.
  spec.files = Dir[
    "lib/**/*.rb", "lib/**/*.rake", "app/**/*.rb", "config/**/*.rb",
    "skills/**/*.md", "README.md", "CHANGELOG.md", "LICENSE"
  ]
  spec.require_paths = ["lib"]

  # The gems release in lockstep, so sibling dependencies pin the exact version.
  spec.add_dependency "openreceive", "= #{OpenReceive::Rails::VERSION}"
  spec.add_dependency "openreceive-server", "= #{OpenReceive::Rails::VERSION}"
  spec.add_dependency "rails", ">= 8.0"
  # The engine's DEFAULT wallet client is nwc-ruby, built from NWC_URI. That is
  # what the quickstart installs and what every reader gets who does not set
  # config.nwc_client, so it is a hard dependency HERE even though it is
  # deliberately not one of openreceive-server (framework-agnostic Rack, host
  # injects its own client). config.nwc_client remains the supported override.
  spec.add_dependency "nwc-ruby", "~> 0.2", ">= 0.2.4"

  # Test-only: the engine-owned model tests run against in-memory SQLite.
  spec.add_development_dependency "sqlite3", ">= 2.1"

  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive-rails/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-rails.md",
    "rubygems_mfa_required" => "true"
  }
end
