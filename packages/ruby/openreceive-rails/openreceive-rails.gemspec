# frozen_string_literal: true

require_relative "lib/openreceive/rails/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-rails"
  spec.version = OpenReceive::Rails::VERSION
  spec.summary = "OpenReceive mountable Rails engine with host-owned payment scaffolding."
  spec.description =
    "A mountable Rails engine that ships OpenReceive's receive-only checkout routes into a " \
    "Rails app. Engine controllers inherit from the host's ApplicationController (keeping its " \
    "CSRF, authentication, and current_user), delegate to the openreceive-server Service, and " \
    "obey host-supplied authorization, amount-resolution, and " \
    "payment-attempt commit hooks. Its install generator creates a host-owned model and migration; " \
    "the runtime accepts no database configuration. Receive-only: it never exposes a spend path."
  spec.authors = ["OpenReceive"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.0"

  spec.files = Dir["lib/**/*.rb", "app/**/*.rb", "config/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "openreceive"
  spec.add_dependency "openreceive-server"
  spec.add_dependency "rails", ">= 7.1"

  spec.metadata = {
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "rubygems_mfa_required" => "true"
  }
end
