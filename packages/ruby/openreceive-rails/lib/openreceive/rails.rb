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
#   openreceive-server  — storage-agnostic Service, the shared
#                         framework-neutral RequestHandler, and the RackApp adapter over it
#   openreceive-rails   — this gem: Configuration, the Engine, controllers (thin adapters that
#                         delegate to Server::RequestHandler), the engine-owned OpenReceivePayment
#                         model, and reconciliation (OpenReceive.reconcile!, ReconcileJob, rake task).

require "openreceive"
require "openreceive/server"

require "openreceive/rails/version"
require "openreceive/configuration"
require "openreceive/reconcile"

# The Engine and everything that subclasses a Rails class load only when a usable
# Rails install is available. Guard so this file still loads for syntax/structure
# checks without Bundler (CI unit tests, `ruby -c`). A half-installed global Rails
# gem that raises during boot is treated the same as "Rails not present".
begin
  require "rails"
  require "rails/engine"
  require "openreceive/engine" if defined?(::Rails::Engine)
rescue LoadError, NameError, NoMethodError
  # Rails is missing or incomplete. Configuration + Server::RequestHandler remain
  # usable; the Engine is simply not defined.
end
