# frozen_string_literal: true

require_relative "lib/openreceive/rails/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-rails"
  spec.version = OpenReceive::Rails::VERSION
  spec.summary = "OpenReceive mountable Rails engine: routes, controllers, generators, migrations."
  spec.description =
    "A mountable Rails engine that ships OpenReceive's receive-only checkout routes into a " \
    "Rails app. Engine controllers inherit from the host's ApplicationController (keeping its " \
    "CSRF, authentication, and current_user), delegate to the openreceive-server Service and " \
    "per-order capability tokens, and obey host-supplied `authorize` / `get_order_amount` hooks. " \
    "Ships an `openreceive:install` generator that writes the initializer, mounts the engine, " \
    "and copies the canonical migrations. Receive-only: it never exposes a spend path."
  spec.authors = ["OpenReceive"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.0"

  # NOTE: `.tt` is included beyond the base {rb,rake} so the ERB migration templates under
  # lib/generators/**/templates ship in the gem (they cannot be named `.rb` — they contain ERB and
  # would fail `ruby -c`). Without this the install generator could not find its migration templates.
  spec.files = Dir["lib/**/*.{rb,rake,tt}", "app/**/*.rb", "config/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "openreceive"
  spec.add_dependency "openreceive-server"
  spec.add_dependency "rails", ">= 7.1"

  spec.metadata = {
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "rubygems_mfa_required" => "true"
  }
end
