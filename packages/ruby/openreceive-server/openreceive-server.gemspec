# frozen_string_literal: true

require_relative "lib/openreceive/server/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-server"
  spec.version = OpenReceive::Server::VERSION
  spec.summary = "Accept Bitcoin Lightning payments in Ruby and Rack. Your app, your wallet."
  spec.description = <<~TEXT
    Accept Bitcoin Lightning payments directly into a wallet you control, from your
    Ruby or Rack application. OpenReceive provides invoice creation, payment checks,
    and settlement reconciliation through a receive-only Nostr Wallet Connect
    (NWC) client. Optional swaps let customers pay with USDT, USDC, SOL, and ETH
    through a configured provider; you receive BTC over Lightning in your wallet.
    Available assets and networks depend on the provider.

    Bring your own wallet client, authorization, and payment persistence. The service
    and Rack handler fit into your existing application, with no separate OpenReceive
    service or database to deploy. Your app keeps control of orders, prices, and
    fulfillment; wallet credentials stay on the server. Rails developers can use
    openreceive-rails for built-in payment storage and reconciliation.
  TEXT
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  # skills/ is the agent-skills copy kept in sync by `npm run generate:skills`.
  spec.files = Dir["lib/**/*.rb", "skills/**/*.md", "README.md", "CHANGELOG.md", "LICENSE"]
  spec.require_paths = ["lib"]

  # nwc-ruby is deliberately NOT a hard dependency OF THIS GEM: a Rack host
  # injects its own NWC client, and this gem never reaches for one. The Rails
  # engine is the exception and declares it as a runtime dependency, because
  # building nwc-ruby from NWC_URI is the default path every reader takes.
  # The gems release in lockstep, so the sibling dependency pins the exact version.
  spec.add_dependency "openreceive", "= #{OpenReceive::Server::VERSION}"

  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive-server/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive-server/README.md",
    "rubygems_mfa_required" => "true"
  }
end
