# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "openreceive/rails"

class FakeReceiveClient
  attr_reader :make_invoice_calls, :list_transactions_calls
  attr_accessor :transactions, :raise_list_transactions

  def initialize
    @make_invoice_calls = []
    @list_transactions_calls = []
    @invoice_responses = []
    @transactions = []
    @raise_list_transactions = false
  end

  def queue_invoice(response)
    @invoice_responses << response
  end

  def make_invoice(request)
    @make_invoice_calls << request
    @invoice_responses.shift || {
      "invoice" => "lnbc-rails",
      "payment_hash" => "a" * 64,
      "amount_msats" => request.fetch("amount_msats"),
      "created_at" => 1000,
      "expires_at" => 1600
    }
  end

  def list_transactions(request)
    @list_transactions_calls << request
    raise OpenReceive::WalletUnavailableError.new("list_transactions failed") if @raise_list_transactions

    offset = Integer(request.fetch("offset", 0))
    limit = Integer(request.fetch("limit", 20))
    from = Integer(request.fetch("from", 0))
    until_time = Integer(request.fetch("until", Time.now.to_i))
    include_unpaid = request["unpaid"] == true
    type = request["type"]
    page = @transactions.select do |transaction|
      created_at = Integer(transaction.fetch("created_at"))
      next false if type && transaction["type"] != type
      next false unless created_at >= from && created_at <= until_time
      next false if !include_unpaid && transaction["transaction_state"] != "settled" && transaction["state"] != "settled"

      true
    end.slice(offset, limit) || []
    { "transactions" => page }
  end

  def preflight
    {
      "receive_checkout_ready" => true,
      "methods" => ["make_invoice", "list_transactions"],
      "notifications" => []
    }
  end
end

class FakeDurableInvoiceStore
  def initialize
    @inner = OpenReceive::InMemoryInvoiceKvStore.new
  end

  OpenReceive::Rails::Adapter::STORE_METHODS.each do |method|
    define_method(method) do |*args, **kwargs|
      @inner.public_send(method, *args, **kwargs)
    end
  end
end

class OpenReceiveRailsTest < Minitest::Test
  Controller = Struct.new(:current_user_id)
  ROOT = File.expand_path("../../../..", __dir__)

  def build_adapter(client: FakeReceiveClient.new, completed: [], store: nil)
    config = OpenReceive::Rails::Configuration.new
    config.client = client
    config.store = store unless store.nil?
    config.namespace = "rails:test"
    config.production = false
    config.metadata = ->(controller, params) { { "user_id" => controller.current_user_id, "fruit" => params["fruit"] } }
    config.settlement_action = ->(invoice) { completed << invoice.fetch("invoice_id") }
    [OpenReceive::Rails::Adapter.new(config), client, completed]
  end

  def read_generator_template(relative_path)
    File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/openreceive/rails/generators/templates",
        relative_path
      )
    )
  end

  def require_sqlite3!
    require "sqlite3"
  rescue LoadError
    skip "sqlite3 gem is not installed; skipping SQLite-backed Rails store test"
  end

  def settled_transaction(payment_hash: "a" * 64, invoice: "lnbc-rails", created_at: 1000)
    {
      "type" => "incoming",
      "invoice" => invoice,
      "payment_hash" => payment_hash,
      "amount" => 200_000,
      "transaction_state" => "settled",
      "created_at" => created_at,
      "settled_at" => created_at + 200,
      "metadata" => { "large" => "not persisted" }
    }
  end

  def pending_transaction(payment_hash:, invoice:, created_at: 1000)
    {
      "type" => "incoming",
      "invoice" => invoice,
      "payment_hash" => payment_hash,
      "amount" => 200_000,
      "transaction_state" => "pending",
      "created_at" => created_at
    }
  end

  def test_rails_storage_resolver_uses_owned_sqlite_store
    require_sqlite3!

    rails_source = File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/openreceive/rails.rb"
      )
    )

    assert_includes rails_source, "class SqliteInvoiceStore"
    assert_includes rails_source, "resolve_invoice_store"
    assert_includes rails_source, "CREATE TABLE IF NOT EXISTS"
    assert_includes rails_source, "idempotency_scope TEXT NOT NULL UNIQUE"
    assert_includes rails_source, "data TEXT NOT NULL"
    refute_includes rails_source, "class ActiveRecordInvoiceStore"
    refute_includes rails_source, "create_active_record_invoice_store"
    refute_includes rails_source, "ApplicationRecord"

    Dir.mktmpdir do |dir|
      store = OpenReceive::Rails.resolve_invoice_store(
        uri: "sqlite://#{File.join(dir, "openreceive.sqlite3")}",
        namespace: "rails_test"
      )
      adapter, _client = build_adapter(store: store)
      first = adapter.create_invoice(
        controller: Controller.new(7),
        params: { "amount_msats" => 200_000, "fruit" => "banana" },
        headers: { "idempotency-key" => "order-sqlite" }
      )
      second = adapter.create_invoice(
        controller: Controller.new(7),
        params: { "amount_msats" => 200_000, "fruit" => "banana" },
        headers: { "idempotency-key" => "order-sqlite" }
      )

      assert_equal 201, first.fetch("status")
      assert_equal 200, second.fetch("status")
      assert_equal first.fetch("body"), second.fetch("body")
      assert File.exist?(File.join(dir, "openreceive.sqlite3"))
    end
  end

  def test_sqlite_store_claims_transaction_scan_gate_once_per_interval
    require_sqlite3!

    Dir.mktmpdir do |dir|
      store = OpenReceive::Rails.resolve_invoice_store(
        uri: "sqlite://#{File.join(dir, "openreceive.sqlite3")}",
        namespace: "rails_test"
      )

      first = store.cas_meta(key: "transaction_scan_gate", value: JSON.generate("claimed_at" => 1000), expected_rev: nil)
      second = store.cas_meta(key: "transaction_scan_gate", value: JSON.generate("claimed_at" => 1001), expected_rev: nil)
      current = store.get_meta("transaction_scan_gate")
      third = store.cas_meta(key: "transaction_scan_gate", value: JSON.generate("claimed_at" => 1002), expected_rev: current.fetch("rev"))

      assert_equal "ok", first.fetch("status")
      assert_equal "conflict", second.fetch("status")
      assert_equal "ok", third.fetch("status")
    end
  end

  def test_rails_route_and_status_templates_preserve_receive_only_boundary
    controller = read_generator_template("app/controllers/openreceive_controller.rb")
    partial = read_generator_template("app/views/openreceive/_invoice.html.erb")
    routes = read_generator_template("config/openreceive_routes.rb")
    initializer = read_generator_template("config/initializers/openreceive.rb")
    combined = [controller, partial, routes].join("\n")

    assert_includes controller, "create_invoice"
    assert_includes controller, "refresh_invoice_status"
    assert_includes controller, "protect_from_forgery"
    refute_includes controller, "lookup_invoice"
    refute_includes controller, "after_action"
    refute_includes controller, "maybe_sweep"
    assert_includes partial, "turbo_frame_tag"
    assert_includes partial, "data-openreceive-status"
    assert_includes partial, "amount_msats"
    assert_includes routes, "post \"/openreceive/v1/invoices\""
    assert_includes routes, "get \"/openreceive/v1/invoices/:invoice_id\""
    assert_includes routes, "post \"/openreceive/v1/invoices/:invoice_id/status\""
    refute_includes routes, "/poll"
    assert_includes initializer, 'ENV.fetch("OPENRECEIVE_NWC"'
    assert_includes initializer, "OpenReceive.missing_nwc_message"
    assert_includes initializer, "OpenReceive.invalid_nwc_message"
    assert_includes initializer, "OpenReceive.parse_nwc_uri"
    refute_includes initializer, "OpenReceive::UnavailableReceiveClient"
    assert_includes initializer, "NwcRuby::Client.from_uri"
    assert_includes initializer, "OpenReceive::Rails.resolve_invoice_store"
    refute_includes initializer, "config.authenticate"
    refute_includes initializer, "config.authorize_invoice"
    refute_includes combined, "pay_invoice"
    refute_includes combined, "nostr+walletconnect://"
    refute_includes initializer, "nostr+walletconnect://"
  end

  def test_install_generator_copies_public_templates_without_background_tasks_or_secrets
    generator = File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/generators/openreceive/install/install_generator.rb"
      )
    )

    assert_includes generator, "Rails::Generators::Base"
    refute_includes generator, "Rails::Generators::Migration"
    refute_includes generator, "next_migration_number"
    refute_includes generator, "migration_template"
    refute_includes generator, "create_openreceive_tables.rb"
    refute_includes generator, "openreceive_invoice.rb"
    assert_includes generator, "config/initializers/openreceive.rb"
    assert_includes generator, "openreceive_controller.rb"
    assert_includes generator, "_invoice.html.erb"
    assert_includes generator, "openreceive_routes.rb"
    refute_includes generator, "openreceive_poll_invoice_job.rb"
    refute_includes generator, "openreceive.rake"
    refute_includes generator, "nostr+walletconnect://"
  end

  def test_mounted_engine_route_surface_is_available_without_loading_rails
    calls = []
    router = Object.new
    router.define_singleton_method(:post) { |path, options| calls << [:post, path, options] }
    router.define_singleton_method(:get) { |path, options| calls << [:get, path, options] }

    OpenReceive::Rails::Routes.draw(router)

    assert_equal(
      [
        [:post, "/v1/invoices", { to: "invoices#create" }],
        [:get, "/v1/invoices/:invoice_id", { to: "invoices#show" }],
        [:post, "/v1/invoices/:invoice_id/status", { to: "invoices#status" }]
      ],
      calls
    )
  end

  def test_mounted_engine_controller_definitions_preserve_boundaries
    source = File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/openreceive/rails.rb"
      )
    )

    assert_includes source, "class InvoicesController"
    assert_includes source, "routes.draw"
    assert_includes source, "OpenReceive::Rails::Routes.draw(self)"
    assert_includes source, "create_invoice"
    assert_includes source, "refresh_invoice_status"
    assert_includes source, "def status"
    assert_includes source, "rescue_from OpenReceive::WalletUnavailableError"
    assert_includes source, "render_openreceive_error"
    refute_includes source, "lookup_invoice"
    refute_includes source, "after_action :run_openreceive_route_recovery"
    refute_includes source, "maybe_sweep"
    refute_includes source, "def poll"
    refute_includes source, "pay_invoice"
    refute_includes source, "OPENRECEIVE_NWC"
    refute_includes source, "nostr+walletconnect://"
  end

  def test_production_configuration_leaves_route_protection_to_host_app
    config = OpenReceive::Rails::Configuration.new
    config.client = FakeReceiveClient.new
    config.store = FakeDurableInvoiceStore.new
    config.production = true

    assert_instance_of OpenReceive::Rails::Adapter, OpenReceive::Rails::Adapter.new(config)
  end

  def test_production_configuration_fails_closed_with_in_memory_storage
    config = OpenReceive::Rails::Configuration.new
    config.client = FakeReceiveClient.new
    config.production = true

    error = assert_raises(SecurityError) { OpenReceive::Rails::Adapter.new(config) }
    assert_includes error.message, "durable invoice storage"
  end

  def test_create_invoice_is_idempotent_and_receive_only
    adapter, client = build_adapter
    controller = Controller.new(7)
    params = {
      "amount_msats" => 200_000,
      "description" => "Fruit sticker",
      "fruit" => "banana"
    }
    headers = { "idempotency-key" => "order-123" }

    first = adapter.create_invoice(controller: controller, params: params, headers: headers)
    second = adapter.create_invoice(controller: controller, params: params, headers: headers)

    assert_equal 201, first.fetch("status")
    assert_equal 200, second.fetch("status")
    assert_equal first.fetch("body"), second.fetch("body")
    assert_equal 1, client.make_invoice_calls.length
    refute client.respond_to?(:pay_invoice)
    refute_includes first.fetch("body").to_s, "OPENRECEIVE_NWC"
    refute_includes first.fetch("body").to_s, "nostr+walletconnect://"
  end

  def test_create_invoice_rejects_idempotency_drift_before_wallet_call
    adapter, client = build_adapter
    controller = Controller.new(7)
    headers = { "idempotency-key" => "order-123" }

    adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: headers
    )

    assert_raises(OpenReceive::IdempotencyConflictError) do
      adapter.create_invoice(
        controller: controller,
        params: { "amount_msats" => 300_000, "fruit" => "banana" },
        headers: headers
      )
    end
    assert_equal 1, client.make_invoice_calls.length
  end

  def test_create_invoice_rejects_invalid_amount_before_wallet_call
    adapter, client = build_adapter

    assert_raises(ArgumentError) do
      adapter.create_invoice(
        controller: Controller.new(7),
        params: { "amount_msats" => 999, "fruit" => "banana" },
        headers: { "idempotency-key" => "order-123" }
      )
    end

    assert_empty client.make_invoice_calls
  end

  def test_status_refresh_scans_one_page_and_settles_once
    adapter, client, completed = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    pending = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1000)
    assert_equal "pending", pending.fetch("body").fetch("transaction_state")
    assert_equal true, pending.fetch("body").fetch("wallet_scan_performed")
    assert_equal 0, pending.fetch("body").fetch("transactions_checked")
    assert_empty completed

    client.transactions = [settled_transaction]
    settled = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1002)
    replayed = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1004)

    assert_equal "settled", settled.fetch("body").fetch("transaction_state")
    assert_equal "settlement_action_completed", settled.fetch("body").fetch("workflow_state")
    assert_equal [invoice_id], completed
    assert_equal false, replayed.fetch("body").fetch("wallet_scan_performed")
    assert_equal [invoice_id], completed
    assert_equal [0, 0], client.list_transactions_calls.map { |call| call.fetch("offset") }
  end

  def test_status_refresh_advances_cursor_and_global_gate_blocks_request_storms
    adapter, client, completed = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")
    decoys = 20.times.map do |index|
      pending_transaction(
        payment_hash: format("%064x", index + 1),
        invoice: "lnbc-decoy-#{index}",
        created_at: 1000
      )
    end
    client.transactions = decoys + [settled_transaction]

    first = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1000)
    gated = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1001)
    second = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1002)

    assert_equal "pending", first.fetch("body").fetch("transaction_state")
    assert_equal false, gated.fetch("body").fetch("wallet_scan_performed")
    assert_equal "settled", second.fetch("body").fetch("transaction_state")
    assert_equal [0, 20], client.list_transactions_calls.map { |call| call.fetch("offset") }
    assert_equal [invoice_id], completed
  end

  def test_status_refresh_resets_cursor_on_short_page_and_keeps_cycling
    adapter, client = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")
    client.transactions = [
      pending_transaction(payment_hash: "b" * 64, invoice: "lnbc-decoy", created_at: 1000)
    ]

    adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1000)
    adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1002)

    assert_equal [0, 0], client.list_transactions_calls.map { |call| call.fetch("offset") }
  end

  def test_status_refresh_uses_bolt11_fallback_when_payment_hash_is_missing
    adapter, client, completed = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")
    client.transactions = [settled_transaction(payment_hash: nil).reject { |key, value| key == "payment_hash" && value.nil? }]

    result = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1000)

    assert_equal "settled", result.fetch("body").fetch("transaction_state")
    assert_equal [invoice_id], completed
  end

  def test_wallet_error_returns_stored_status_without_advancing_cursor
    adapter, client = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    client.raise_list_transactions = true
    failed = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1000)
    client.raise_list_transactions = false
    client.transactions = 20.times.map do |index|
      pending_transaction(
        payment_hash: format("%064x", index + 100),
        invoice: "lnbc-decoy-#{index}",
        created_at: 1000
      )
    end
    retried = adapter.refresh_invoice_status(controller: controller, invoice_id: invoice_id, now: 1002)

    assert_equal false, failed.fetch("body").fetch("wallet_scan_performed")
    assert_equal true, retried.fetch("body").fetch("wallet_scan_performed")
    assert_equal [0, 0], client.list_transactions_calls.map { |call| call.fetch("offset") }
  end

  def test_status_refresh_leaves_access_checks_to_host_controller
    adapter = build_adapter.first
    created = adapter.create_invoice(
      controller: Controller.new(7),
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )

    result = adapter.refresh_invoice_status(
      controller: Controller.new(8),
      invoice_id: created.fetch("body").fetch("invoice_id")
    )

    assert_equal 200, result.fetch("status")
    assert_equal created.fetch("body").fetch("invoice_id"), result.fetch("body").fetch("invoice_id")
  end
end
