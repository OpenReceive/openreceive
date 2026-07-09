# frozen_string_literal: true

# OpenReceive::Server — receive-only checkout service, durable store, capability tokens,
# config loader, and framework-agnostic HTTP (Rack) routes.
#
# This gem builds on the dependency-free core gem (`openreceive`). It REUSES the core
# primitives (Money, Settlement, Nwc, Idempotency, InMemoryInvoiceKvStore, the error
# classes, and NwcRubyReceiveClient) rather than reimplementing them.
#
# Receive-only invariant: nothing here ever exposes a spend method, and the NWC connection
# secret never leaves the server (never logged, never serialized to a wire payload).

require "openreceive"

require "openreceive/server/version"
require "openreceive/server/errors"
require "openreceive/server/models"
require "openreceive/server/tokens"
require "openreceive/server/in_memory_store"
require "openreceive/server/service"
require "openreceive/server/config"
require "openreceive/server/request_handler"
require "openreceive/server/presets"
require "openreceive/server/rack_app"
require "openreceive/server/active_record_store"
