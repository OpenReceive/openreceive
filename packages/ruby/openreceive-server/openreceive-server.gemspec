# frozen_string_literal: true

require_relative "lib/openreceive/server/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-server"
  spec.version = OpenReceive::Server::VERSION
  spec.summary = "Storage-free OpenReceive receive-only service and HTTP routes for Ruby."
  spec.description =
    "Server building blocks for OpenReceive: a storage-free Service that mirrors the Node " \
    "engine and a framework-agnostic Rack app implementing " \
    "the shipped HTTP routes while the host owns order and payment persistence. " \
    "Receive-only: it never exposes a spend path and the NWC secret never leaves the server."
  spec.authors = ["OpenReceive"]
  spec.email = ["info@openreceive.org"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir["lib/**/*.rb", "README.md", "CHANGELOG.md", "LICENSE"]
  spec.require_paths = ["lib"]

  # nwc-ruby is deliberately NOT a hard dependency: only the Rails engine's
  # optional default client uses it; Rack hosts inject their own NWC client.
  # The gems release in lockstep, so the sibling dependency pins the exact version.
  spec.add_dependency "openreceive", "= #{OpenReceive::Server::VERSION}"

  spec.metadata = {
    "homepage_uri" => "https://openreceive.org",
    "source_code_uri" => "https://github.com/openreceive/openreceive",
    "changelog_uri" => "https://github.com/openreceive/openreceive/blob/master/packages/ruby/openreceive-server/CHANGELOG.md",
    "bug_tracker_uri" => "https://github.com/openreceive/openreceive/issues",
    "documentation_uri" => "https://rubydoc.info/gems/openreceive-server",
    "rubygems_mfa_required" => "true"
  }
end
