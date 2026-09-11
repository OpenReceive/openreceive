# frozen_string_literal: true

# Load only the version constant, never the full library: the gemspec is
# evaluated by `gem build` with no load path set up.
require_relative "lib/openreceive/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive"
  spec.version = OpenReceive::VERSION
  spec.summary = "Bitcoin Lightning payment primitives for Ruby. Your app, your wallet."
  spec.description = <<~TEXT
    Build Bitcoin Lightning payments into your Ruby application with OpenReceive.
    Work with exact money amounts, normalize wallet responses, and apply consistent
    settlement rules while keeping control of your wallet and application.

    This lightweight core provides money conversion, exchange rates, Nostr Wallet
    Connect (NWC) adapters, and swap-address validation without a database dependency.
    For a complete Rails integration, install openreceive-rails. For a custom Ruby
    or Rack integration, use openreceive-server.

    OpenReceive integrations support optional swaps from USDT, USDC, SOL, and ETH
    through a configured provider, settling as BTC over Lightning into your wallet.
    Available assets and networks depend on the provider.
  TEXT
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"
  spec.homepage = "https://openreceive.org"
  # bigdecimal is a bundled gem from Ruby 3.4; declare it explicitly.
  spec.add_dependency "bigdecimal"
  # skills/ is the agent-skills copy kept in sync by `npm run generate:skills`.
  spec.files = Dir["lib/**/*.rb", "skills/**/*.md", "README.md", "CHANGELOG.md", "LICENSE"]
  spec.require_paths = ["lib"]
  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive/README.md",
    "rubygems_mfa_required" => "true"
  }
end
