# frozen_string_literal: true

# Pure-Ruby unit tests for openreceive-rails that DO NOT require Rails. They exercise the two
# framework-neutral units the engine is built on: the Configuration (defaults + wiring) and the
# shared OpenReceive::Server::RequestHandler (tiers, fail-closed Tier 3, token gating,
# resolve_order forms) that the controllers delegate to.
#
# Run:
#   ruby -Ipackages/ruby/openreceive/lib \
#        -Ipackages/ruby/openreceive-server/lib \
#        -Ipackages/ruby/openreceive-rails/lib \
#        packages/ruby/openreceive-rails/test/rails_test.rb
#
# NOT covered here (requires a live Rails app + database): engine mounting, controller rendering,
# generator/migration execution. See README "Verification status".

require "json"
require "minitest/autorun"
require "openreceive/rails"

class OpenReceiveRailsTest < Minitest::Test
  # Receive-only wallet double (wrapped by the Service in NwcRubyReceiveClient). Guards on a string
  # key first so the keyword-call attempt is discarded and only the string-keyed retry is observed
  # — matching the core FakeNwcRubyClient contract.
  class FakeWallet
    def make_invoice(params)
      amount = params.fetch("amount")
      @issued = (@issued || 0) + 1
      { "invoice" => "lnbc-fake-#{@issued}", "payment_hash" => format("%064x", @issued), "amount" => amount }
    end

    def list_transactions(params)
      params.fetch("type")
      { "transactions" => [] }
    end
  end

  def setup
    OpenReceive.reset_config!
  end

  def teardown
    OpenReceive.reset_config!
  end

  # --- Rails-guarding ---------------------------------------------------------------------------

  def test_engine_is_not_defined_without_rails
    refute defined?(::Rails::Engine), "Rails is not expected to be installed in this test env"
    refute defined?(OpenReceive::Engine), "Engine must only be defined when Rails is present"
  end

  # --- Configuration defaults -------------------------------------------------------------------

  def test_configuration_defaults
    config = OpenReceive::Configuration.new
    assert_equal "ActionController::Base", config.parent_controller
    assert_equal "default", config.namespace
    assert_equal "/openreceive", config.prefix
    assert_nil config.authorize
    assert_nil config.resolve_order
    assert_equal [], config.swap_providers
    refute config.authorize_configured?
  end

  def test_configure_sets_authorize_configured
    OpenReceive.configure { |c| c.authorize = ->(_ctx) { true } }
    assert OpenReceive.config.authorize_configured?
  end

  # --- Fail-closed Tier 3 (no authorize configured) ---------------------------------------------

  def test_admin_sweep_fails_closed_when_authorize_unset
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    handler = OpenReceive::Server::RequestHandler.new(service: Object.new, tokens: tokens, resolve_order: ->(**) { {} })

    status, _headers, body = handler.admin_sweep(request: nil, token: nil, request_id: nil)
    assert_equal 403, status
    assert_equal "UNAUTHORIZED", body.fetch("code")
  end

  def test_default_authorize_decision_denies_tier3
    store = OpenReceive::Server::InMemoryInvoiceStore.new
    tokens = OpenReceive::Server::Tokens::Manager.new(store: store, namespace: "default")
    handler = OpenReceive::Server::RequestHandler.new(service: Object.new, tokens: tokens, resolve_order: ->(**) { {} })

    refute handler.default_authorize_decision(action: "invoice.sweep", resource: {}, token: nil)
    assert handler.default_authorize_decision(action: "checkout.create", resource: {}, token: nil)
  end

  # --- Full wiring through Configuration (no Rails) ----------------------------------------------

  def configured_handler
    OpenReceive.configure do |c|
      c.nwc_client = FakeWallet.new
      c.store = OpenReceive::Server::InMemoryInvoiceStore.new
      c.namespace = "default"
      c.resolve_order = ->(order_id:, client_amount:, metadata:, request:) { { "sats" => 1000 } }
    end
    OpenReceive.config.request_handler
  end

  def test_create_checkout_mints_token_from_resolve_order
    handler = configured_handler
    status, headers, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "order-1"),
      request: nil, token: nil, request_id: nil
    )

    assert_equal 201, status
    assert_equal "application/json", headers["Content-Type"]
    checkout = body.fetch("checkout")
    assert_equal "order-1", checkout.fetch("order_id")
    # resolve_order is the sole price authority (1000 sats → 1_000_000 msats).
    assert_equal 1_000_000, checkout.fetch("amount_msats")
    assert body.fetch("order_access_token")
  end

  def test_create_checkout_rejects_client_amount
    handler = configured_handler
    status, _, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "order-1", "sats" => 50),
      request: nil, token: nil, request_id: nil
    )
    assert_equal 400, status
    assert_equal "INVALID_REQUEST", body.fetch("code")
  end

  def test_order_read_requires_capability_token
    handler = configured_handler
    _, _, created = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "order-2"),
      request: nil, token: nil, request_id: nil
    )
    token = created.fetch("order_access_token")

    denied_status, _, denied = handler.order_action(
      order_id: "order-2", raw_body: JSON.generate("action" => "status"),
      request: nil, token: nil, request_id: nil
    )
    assert_equal 403, denied_status
    assert_equal "UNAUTHORIZED", denied.fetch("code")

    ok_status, _, ok = handler.order_action(
      order_id: "order-2", raw_body: JSON.generate("action" => "status"),
      request: nil, token: token, request_id: nil
    )
    assert_equal 200, ok_status
    assert_equal "order-2", ok.fetch("order_id")
    assert_equal false, ok.fetch("swaps_enabled")
  end

  def test_request_id_is_echoed_in_error_body
    handler = configured_handler
    status, headers, body = handler.admin_sweep(request: nil, token: nil, request_id: "req-123")
    assert_equal 403, status
    assert_equal "req-123", headers["X-Request-Id"]
    assert_equal "req-123", body.fetch("request_id")
  end

  # --- resolve_order accepts both the keyword form and the single-context (quickstart) form -----

  def test_resolve_order_single_context_form
    OpenReceive.configure do |c|
      c.nwc_client = FakeWallet.new
      c.store = OpenReceive::Server::InMemoryInvoiceStore.new
      # Quickstart form: a single ctx hash carrying :order_id.
      c.resolve_order = ->(ctx) { { usd: nil } && { "sats" => (ctx[:order_id] == "vip" ? 2000 : 1000) } }
    end
    status, _, body = OpenReceive.config.request_handler.create_checkout(
      raw_body: JSON.generate("order_id" => "vip"),
      request: nil, token: nil, request_id: nil
    )
    assert_equal 201, status
    # 2000 sats -> 2_000_000 msats, proving ctx[:order_id] reached the single-arg lambda.
    assert_equal 2_000_000, body.fetch("checkout").fetch("amount_msats")
  end

  # --- Presets are usable via configuration.authorize -------------------------------------------

  def test_preset_guest_checkout_usable_via_configuration
    OpenReceive.configure do |c|
      c.nwc_client = FakeWallet.new
      c.store = OpenReceive::Server::InMemoryInvoiceStore.new
      c.resolve_order = ->(order_id:, client_amount:, metadata:, request:) { { "sats" => 1000 } }
      c.authorize = OpenReceive::Server::Presets.guest_checkout
    end
    handler = OpenReceive.config.request_handler

    _, _, created = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "cs"), request: nil, token: nil, request_id: nil
    )
    token = created.fetch("order_access_token")

    denied, = handler.order_action(
      order_id: "cs", raw_body: JSON.generate("action" => "status"), request: nil, token: nil, request_id: nil
    )
    assert_equal 403, denied

    ok, _, ok_body = handler.order_action(
      order_id: "cs", raw_body: JSON.generate("action" => "status"), request: nil, token: token, request_id: nil
    )
    assert_equal 200, ok
    assert_equal "cs", ok_body.fetch("order_id")
  end

  # --- token_valid reaches a configured authorize context ---------------------------------------

  def test_token_valid_present_in_authorize_context
    seen = {}
    OpenReceive.configure do |c|
      c.nwc_client = FakeWallet.new
      c.store = OpenReceive::Server::InMemoryInvoiceStore.new
      c.resolve_order = ->(order_id:, client_amount:, metadata:, request:) { { "sats" => 1000 } }
      c.authorize = ->(ctx) { seen[ctx[:action]] = ctx[:token_valid]; true }
    end
    handler = OpenReceive.config.request_handler

    _, _, created = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "tv"), request: nil, token: nil, request_id: nil
    )
    token = created.fetch("order_access_token")
    # No order token presented on create → token_valid false.
    assert_equal false, seen["checkout.create"]

    handler.order_action(
      order_id: "tv", raw_body: JSON.generate("action" => "status"), request: nil, token: token, request_id: nil
    )
    assert_equal true, seen["order.read"]
  end
end
