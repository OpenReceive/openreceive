# frozen_string_literal: true

require_relative "lib/openreceive/rails/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-rails"
  spec.version = OpenReceive::Rails::VERSION
  spec.summary = "OpenReceive mountable Rails engine with engine-owned payment attempts in the host database."
  spec.description =
    "A mountable Rails engine that ships OpenReceive's receive-only checkout routes into a " \
    "Rails app. Engine controllers inherit from the host's ApplicationController (keeping its " \
    "authentication and current_user; JSON routes skip Rails form CSRF), delegate to the " \
    "openreceive-server Service, and " \
    "obey host-supplied authorization, amount-resolution, and settlement hooks. The engine owns " \
    "the OpenReceivePayment attempt model, its status state machine, settlement write-once, and " \
    "reconciliation (OpenReceive.reconcile!, OpenReceive::ReconcileJob, rake openreceive:reconcile); " \
    "its install generator emits only the migration, initializer, and route mount. " \
    "Receive-only: it never exposes a spend path, and boot fails closed on spend-capable NWC codes."
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir[
    "lib/**/*.rb", "lib/**/*.rake", "app/**/*.rb", "config/**/*.rb",
    "README.md", "CHANGELOG.md", "LICENSE"
  ]
  spec.require_paths = ["lib"]

  # The gems release in lockstep, so sibling dependencies pin the exact version.
  spec.add_dependency "openreceive", "= #{OpenReceive::Rails::VERSION}"
  spec.add_dependency "openreceive-server", "= #{OpenReceive::Rails::VERSION}"
  spec.add_dependency "rails", ">= 8.0"

  # Test-only: the engine-owned model tests run against in-memory SQLite.
  spec.add_development_dependency "sqlite3", ">= 2.1"

  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive-rails/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://rubydoc.info/gems/openreceive-rails",
    "rubygems_mfa_required" => "true"
  }
end
