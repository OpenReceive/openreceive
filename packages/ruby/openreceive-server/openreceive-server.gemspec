# frozen_string_literal: true

require_relative "lib/openreceive/server/version"

Gem::Specification.new do |spec|
  spec.name = "openreceive-server"
  spec.version = OpenReceive::Server::VERSION
  spec.summary = "Storage-free OpenReceive receive-only service and HTTP routes for Ruby."
  spec.description =
    "Server building blocks for OpenReceive: a storage-free Service that mirrors the Node " \
    "engine, stateless authenticated tokens, and a framework-agnostic Rack app implementing " \
    "the shipped HTTP routes while the host owns order and payment persistence. " \
    "Receive-only: it never exposes a spend path and the NWC secret never leaves the server."
  spec.authors = ["OpenReceive"]
  spec.homepage = "https://openreceive.org"
  spec.license = "MIT"

  spec.required_ruby_version = ">= 3.0"

  spec.files = Dir["lib/**/*.rb", "README.md"]
  spec.require_paths = ["lib"]

  spec.add_dependency "nwc-ruby"
  spec.add_dependency "openreceive"
end
