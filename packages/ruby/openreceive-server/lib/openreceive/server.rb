# frozen_string_literal: true

# OpenReceive::Server — storage-agnostic receive checkout service,
# config loader, and framework-agnostic HTTP (Rack) routes.
#
# This gem builds on the dependency-free core gem (`openreceive`) and reuses its exact-money,
# settlement, NWC normalization, error, and receive-client primitives.
#
# Receive-only invariant: nothing here ever exposes a spend method, and the NWC connection
# secret never leaves the server (never logged, never serialized to a wire payload).

require "openreceive"

module OpenReceive
  module Server
    # Generation of the openreceive_payments / openreceive_meta schema this gem
    # writes and reads. Mirrors the JS OPENRECEIVE_PAYMENTS_SCHEMA_VERSION; both
    # engines share one host database, so they must agree.
    PAYMENTS_SCHEMA_VERSION = 1
  end
end

require "openreceive/server/version"
require "openreceive/server/errors"
require "openreceive/server/client_ip"
require "openreceive/server/wallet_info"
require "openreceive/server/lsc_uri"
require "openreceive/server/swap"
require "openreceive/server/service"
require "openreceive/server/reconciliation"
require "openreceive/server/config"
require "openreceive/server/request_handler"
require "openreceive/server/rack_app"
