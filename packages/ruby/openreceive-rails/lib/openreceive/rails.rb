# frozen_string_literal: true

# OpenReceive Rails engine — mounts the receive-only checkout routes into a Rails app.
#
# This file is the require tree. It is deliberately loadable WITHOUT Rails installed so the gem
# can be syntax/structure-checked in isolation (CI without a Rails app, `ruby -c`, unit tests of
# the pure-Ruby Configuration + the shared Server::RequestHandler). The Rails-dependent pieces (the
# Engine, the controllers under app/, the generators) are only wired up when `::Rails::Engine` is
# present.
#
# Layering:
#   openreceive         — dependency-free core (money, settlement, NWC normalization)
#   openreceive-server  — storage-free Service, token keyring, the shared
#                         framework-neutral RequestHandler, and the RackApp adapter over it
#   openreceive-rails   — this gem: Configuration, the Engine, controllers (thin adapters that
#                         delegate to Server::RequestHandler), and an initializer generator.

require "openreceive"
require "openreceive/server"

require "openreceive/rails/version"
require "openreceive/configuration"

# The Engine and everything that subclasses a Rails class load only when Rails is available.
# Guard the require so this file loads for syntax/structure checks with no Rails present.
begin
  require "rails/engine"
rescue LoadError
  # Rails is not installed. Configuration + Server::RequestHandler remain usable (e.g. for a
  # plain-Rack host or for unit tests); the Engine is simply not defined.
end

require "openreceive/engine" if defined?(::Rails::Engine)
