# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "openreceive/rails"

class FakeReceiveClient
  attr_reader :make_invoice_calls, :lookup_invoice_calls
  attr_accessor :lookup_state

  def initialize
    @make_invoice_calls = []
    @lookup_invoice_calls = []
    @lookup_state = "pending"
  end

  def make_invoice(request)
    @make_invoice_calls << request
    {
      "invoice" => "lnbc-rails",
      "payment_hash" => "a" * 64,
      "amount_msats" => request.fetch("amount_msats"),
      "created_at" => 1000,
      "expires_at" => 1600
    }
  end

  def lookup_invoice(request)
    @lookup_invoice_calls << request
    {
      "invoice" => "lnbc-rails",
      "payment_hash" => "a" * 64,
      "amount" => 200_000,
      "state" => @lookup_state,
      "settled_at" => (@lookup_state == "settled" ? 1200 : nil)
    }
  end

  def preflight
    {
      "receive_checkout_ready" => true,
      "methods" => ["make_invoice", "lookup_invoice"],
      "notifications" => []
    }
  end
end

class FakeDurableInvoiceStore
  def initialize
    @inner = OpenReceive::InMemoryInvoiceKvStore.new
  end

  def doctor
    [
      {
        "name" => "rails.store.owned",
        "status" => "ok",
        "message" => "fake durable store present"
      }
    ]
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
    config.merchant_scope = "rails:test"
    config.production = false
    config.authenticate = ->(controller) { raise "missing user" if controller.current_user_id.nil? }
    config.authorize_invoice = lambda do |controller, invoice|
      invoice.fetch("metadata").fetch("user_id") == controller.current_user_id
    end
    config.metadata = ->(controller, params) { { "user_id" => controller.current_user_id, "fruit" => params["fruit"] } }
    config.settlement_action = ->(invoice) { completed << invoice.fetch("invoice_id") }
    [OpenReceive::Rails::Adapter.new(config), client, completed]
  end

  def read_template(name)
    File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/openreceive/rails/generators/templates",
        name
      )
    )
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

  def test_rails_storage_resolver_uses_owned_sqlite_store
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
      checks = adapter.doctor.fetch("checks")
      assert checks.any? { |check| check.fetch("name") == "rails.store.owned" && check.fetch("status") == "ok" }
      assert File.exist?(File.join(dir, "openreceive.sqlite3"))
    end
  end

  def test_rails_route_and_poll_templates_preserve_receive_only_boundary
    controller = read_generator_template("app/controllers/openreceive_controller.rb")
    poll_job = read_generator_template("app/jobs/openreceive_poll_invoice_job.rb")
    partial = read_generator_template("app/views/openreceive/_invoice.html.erb")
    routes = read_generator_template("config/openreceive_routes.rb")
    initializer = read_generator_template("config/initializers/openreceive.rb")
    rake_tasks = read_generator_template("lib/tasks/openreceive.rake")
    combined = [controller, poll_job, partial, routes, rake_tasks].join("\n")

    assert_includes controller, "create_invoice"
    assert_includes controller, "lookup_invoice"
    assert_includes controller, "protect_from_forgery"
    assert_includes poll_job, "verify_invoice"
    assert_includes partial, "turbo_frame_tag"
    assert_includes partial, "transaction_state"
    assert_includes partial, "workflow_state"
    assert_includes partial, "amount_msats"
    assert_includes routes, "post \"/openreceive/v1/invoices\""
    assert_includes routes, "get \"/openreceive/v1/invoices/:invoice_id\""
    assert_includes routes, "post \"/openreceive/v1/poll\""
    assert_includes rake_tasks, "task poll: :environment"
    assert_includes rake_tasks, "task doctor: :environment"
    assert_includes rake_tasks, "OpenReceive::Rails.adapter.doctor"
    assert_includes rake_tasks, "poll_recoverable_invoices"
    refute_includes rake_tasks, "task listen"
    assert_includes initializer, 'ENV.fetch("OPENRECEIVE_NWC"'
    assert_includes initializer, "OpenReceive.missing_nwc_message"
    assert_includes initializer, "OpenReceive.invalid_nwc_message"
    assert_includes initializer, "OpenReceive.parse_nwc_uri"
    refute_includes initializer, "OpenReceive::UnavailableReceiveClient"
    assert_includes initializer, "NwcRuby::Client.from_uri"
    assert_includes initializer, "OpenReceive::Rails.resolve_invoice_store"
    assert_includes initializer, "Configure OpenReceive authentication before production"
    refute_includes combined, "pay_invoice"
    refute_includes combined, "nostr+walletconnect://"
    refute_includes initializer, "nostr+walletconnect://"
  end

  def test_install_generator_copies_public_templates_without_secrets
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
    assert_includes generator, "openreceive_poll_invoice_job.rb"
    assert_includes generator, "_invoice.html.erb"
    assert_includes generator, "openreceive.rake"
    assert_includes generator, "openreceive_routes.rb"
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
        [:post, "/v1/poll", { to: "invoices#poll" }],
        [:get, "/v1/poll", { to: "invoices#poll" }]
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
    assert_includes source, "lookup_invoice"
    assert_includes source, "def poll"
    assert_includes source, "rescue_from OpenReceive::WalletUnavailableError"
    assert_includes source, "render_openreceive_error"
    refute_includes source, "pay_invoice"
    refute_includes source, "OPENRECEIVE_NWC"
    refute_includes source, "nostr+walletconnect://"
  end

  def test_production_configuration_fails_closed_without_authenticate
    config = OpenReceive::Rails::Configuration.new
    config.client = FakeReceiveClient.new
    config.production = true

    assert_raises(SecurityError) { OpenReceive::Rails::Adapter.new(config) }
  end

  def test_production_configuration_fails_closed_with_in_memory_storage
    config = OpenReceive::Rails::Configuration.new
    config.client = FakeReceiveClient.new
    config.production = true
    config.authenticate = ->(_controller) { true }

    error = assert_raises(SecurityError) { OpenReceive::Rails::Adapter.new(config) }
    assert_includes error.message, "durable invoice storage"
  end

  def test_doctor_reports_store_nwc_and_poll_readiness
    adapter = build_adapter(store: FakeDurableInvoiceStore.new).first
    result = adapter.doctor

    assert_equal true, result.fetch("ok")
    checks = result.fetch("checks")
    assert checks.any? { |check| check.fetch("name") == "rails.store" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.store.owned" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.nwc" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.poll" && check.fetch("status") == "ok" }
    refute_includes result.to_s, "nostr+walletconnect://"
  end

  def test_doctor_fails_with_in_memory_storage
    adapter = build_adapter.first
    result = adapter.doctor

    assert_equal false, result.fetch("ok")
    checks = result.fetch("checks")
    assert checks.any? { |check| check.fetch("name") == "rails.store.durable" && check.fetch("status") == "error" }
    assert_includes result.to_s, "InMemoryInvoiceKvStore is for tests only"
  end

  def test_doctor_redacts_nwc_secrets_from_preflight_errors
    leaky_uri = "nostr+walletconnect://#{"c" * 64}?relay=wss%3A%2F%2Frelay.example.com&secret=#{"d" * 64}"
    client = FakeReceiveClient.new
    client.define_singleton_method(:preflight) do
      raise "wallet rejected #{leaky_uri}"
    end

    adapter = build_adapter(client: client, store: FakeDurableInvoiceStore.new).first
    result = adapter.doctor

    assert_equal false, result.fetch("ok")
    assert_includes result.to_s, "[REDACTED_NWC]"
    refute_includes result.to_s, "nostr+walletconnect://"
    refute_includes result.to_s, "secret=#{"d" * 64}"
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

  def test_lookup_verifies_backend_settlement_before_settlement_action
    adapter, client, completed = build_adapter
    controller = Controller.new(7)
    created = adapter.create_invoice(
      controller: controller,
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    pending = adapter.lookup_invoice(controller: controller, invoice_id: invoice_id)
    assert_equal "pending", pending.fetch("body").fetch("transaction_state")
    assert_empty completed

    client.lookup_state = "settled"
    settled = adapter.lookup_invoice(controller: controller, invoice_id: invoice_id)
    replayed = adapter.lookup_invoice(controller: controller, invoice_id: invoice_id)

    assert_equal "settled", settled.fetch("body").fetch("transaction_state")
    assert_equal "settlement_action_completed", settled.fetch("body").fetch("workflow_state")
    assert_equal [invoice_id], completed
    assert_equal "settlement_action_completed", replayed.fetch("body").fetch("workflow_state")
    assert_equal [invoice_id], completed
    assert_equal [{ "payment_hash" => "a" * 64 }] * 3, client.lookup_invoice_calls
  end

  def test_internal_verify_can_be_used_by_poll_schedulers
    adapter, client, completed = build_adapter
    created = adapter.create_invoice(
      controller: Controller.new(7),
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    pending = adapter.verify_invoice(invoice_id: invoice_id)
    client.lookup_state = "settled"
    settled = adapter.verify_invoice(invoice_id: invoice_id)

    assert_equal "pending", pending.fetch("transaction_state")
    assert_equal "settlement_action_completed", settled.fetch("workflow_state")
    assert_equal [invoice_id], completed
  end

  def test_poll_recoverable_invoices_uses_package_owned_store
    adapter, client, completed = build_adapter
    created = adapter.create_invoice(
      controller: Controller.new(7),
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    client.lookup_state = "settled"
    invoices = adapter.poll_recoverable_invoices(now: 1001)

    assert_equal 1, invoices.length
    assert_equal invoice_id, invoices.first.fetch("invoice_id")
    assert_equal "settlement_action_completed", invoices.first.fetch("workflow_state")
    assert_equal [invoice_id], completed
  end

  def test_lookup_denies_cross_user_invoice_access
    adapter = build_adapter.first
    created = adapter.create_invoice(
      controller: Controller.new(7),
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )

    assert_raises(SecurityError) do
      adapter.lookup_invoice(
        controller: Controller.new(8),
        invoice_id: created.fetch("body").fetch("invoice_id")
      )
    end
  end
end
