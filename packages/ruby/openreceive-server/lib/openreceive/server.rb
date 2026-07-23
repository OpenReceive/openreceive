# frozen_string_literal: true

# OpenReceive::Server — storage-free receive checkout service, sealed tokens,
# config loader, and framework-agnostic HTTP (Rack) routes.
#
# This gem builds on the dependency-free core gem (`openreceive`) and reuses its exact-money,
# settlement, NWC normalization, error, and receive-client primitives.
#
# Receive-only invariant: nothing here ever exposes a spend method, and the NWC connection
# secret never leaves the server (never logged, never serialized to a wire payload).

require "openreceive"

require "openreceive/server/version"
require "openreceive/server/errors"
require "openreceive/server/tokens"
require "openreceive/server/service"
require "openreceive/server/config"
require "openreceive/server/request_handler"
require "openreceive/server/rack_app"
