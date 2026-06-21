# frozen_string_literal: true

require "minitest/autorun"
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
    @inner = OpenReceive::InMemoryInvoiceStore.new
  end

  def doctor
    [
      {
        "name" => "rails.migration",
        "status" => "ok",
        "message" => "fake durable store migration present"
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

  def test_active_record_templates_preserve_storage_invariants
    migration = read_template("create_openreceive_tables.rb")
    model = read_template("openreceive_invoice.rb")
    rails_source = File.read(
      File.join(
        ROOT,
        "packages/ruby/openreceive-rails/lib/openreceive/rails.rb"
      )
    )

    assert_includes migration, "create_table :openreceive_invoices"
    assert_includes migration, "[:merchant_scope, :operation, :idempotency_key]"
    assert_includes migration, "unique: true"
    assert_includes migration, "payment_hash"
    assert_includes migration, "amount_msats >= 1000"
    assert_includes migration, "9007199254740991"
    assert_includes migration, "settled_at_seconds"
    assert_includes migration, "settlement_action_completed_at_seconds"
    assert_includes migration, "settlement_action_state IN"
    refute_includes migration, "OPENRECEIVE_NWC"
    refute_includes migration, "nostr+walletconnect://"

    assert_includes model, "self.table_name = \"openreceive_invoices\""
    assert_includes model, "idempotency_request_hash"
    assert_includes model, "transaction_state"
    assert_includes model, "workflow_state"
    assert_includes model, "settlement_action_state"

    assert_includes rails_source, "class ActiveRecordInvoiceStore"
    assert_includes rails_source, "create_active_record_invoice_store"
    assert_includes rails_source, "merchant_scope: data.fetch(\"merchant_scope\")"
    assert_includes rails_source, "operation: data.fetch(\"operation\")"
    assert_includes rails_source, "idempotency_key: data.fetch(\"idempotency_key\")"
    assert_includes rails_source, "settlement_action_completed_at_seconds ||= Integer"
    refute_includes rails_source, "expires_at_seconds + ? >= ?"
  end

  def test_rails_route_job_and_channel_templates_preserve_receive_only_boundary
    controller = read_generator_template("app/controllers/openreceive_controller.rb")
    poll_job = read_generator_template("app/jobs/openreceive_poll_invoice_job.rb")
    notification_job = read_generator_template("app/jobs/openreceive_payment_received_job.rb")
    channel = read_generator_template("app/channels/openreceive_invoice_channel.rb")
    partial = read_generator_template("app/views/openreceive/_invoice.html.erb")
    routes = read_generator_template("config/openreceive_routes.rb")
    initializer = read_generator_template("config/initializers/openreceive.rb")
    rake_tasks = read_generator_template("lib/tasks/openreceive.rake")
    combined = [controller, poll_job, notification_job, channel, partial, routes, rake_tasks].join("\n")

    assert_includes controller, "create_invoice"
    assert_includes controller, "lookup_invoice"
    assert_includes controller, "protect_from_forgery"
    assert_includes poll_job, "verify_invoice"
    assert_includes notification_job, "handle_payment_received"
    assert_includes channel, "authorize_invoice"
    assert_includes partial, "turbo_frame_tag"
    assert_includes partial, "transaction_state"
    assert_includes partial, "workflow_state"
    assert_includes partial, "amount_msats"
    assert_includes routes, "post \"/openreceive/v1/invoices\""
    assert_includes routes, "get \"/openreceive/v1/invoices/:invoice_id\""
    assert_includes rake_tasks, "task poll: :environment"
    assert_includes rake_tasks, "task listen: :environment"
    assert_includes rake_tasks, "task doctor: :environment"
    assert_includes rake_tasks, "OpenReceive::Rails.adapter.doctor"
    assert_includes rake_tasks, "poll_recoverable_invoices"
    assert_includes rake_tasks, "listen_for_payment_notifications"
    assert_includes initializer, 'ENV.fetch("OPENRECEIVE_NWC"'
    assert_includes initializer, "OpenReceive.missing_nwc_message"
    assert_includes initializer, "OpenReceive.invalid_nwc_message"
    assert_includes initializer, "OpenReceive.parse_nwc_uri"
    refute_includes initializer, "OpenReceive::UnavailableReceiveClient"
    assert_includes initializer, "NwcRuby::Client.from_uri"
    assert_includes initializer, "OpenReceive::Rails.create_active_record_invoice_store"
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
    assert_includes generator, "Rails::Generators::Migration"
    assert_includes generator, "next_migration_number"
    assert_includes generator, "migration_template \"create_openreceive_tables.rb\""
    assert_includes generator, "create_openreceive_tables.rb"
    assert_includes generator, "config/initializers/openreceive.rb"
    assert_includes generator, "openreceive_controller.rb"
    assert_includes generator, "openreceive_poll_invoice_job.rb"
    assert_includes generator, "openreceive_payment_received_job.rb"
    assert_includes generator, "openreceive_invoice_channel.rb"
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
        [:get, "/v1/invoices/:invoice_id", { to: "invoices#show" }]
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

  def test_doctor_reports_store_nwc_and_worker_readiness
    adapter = build_adapter(store: FakeDurableInvoiceStore.new).first
    result = adapter.doctor

    assert_equal true, result.fetch("ok")
    checks = result.fetch("checks")
    assert checks.any? { |check| check.fetch("name") == "rails.store" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.migration" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.nwc" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.worker.poll" && check.fetch("status") == "ok" }
    assert checks.any? { |check| check.fetch("name") == "rails.worker.listen" && check.fetch("status") == "ok" }
    refute_includes result.to_s, "nostr+walletconnect://"
  end

  def test_doctor_fails_with_in_memory_storage
    adapter = build_adapter.first
    result = adapter.doctor

    assert_equal false, result.fetch("ok")
    checks = result.fetch("checks")
    assert checks.any? { |check| check.fetch("name") == "rails.store.durable" && check.fetch("status") == "error" }
    assert_includes result.to_s, "InMemoryInvoiceStore is for tests only"
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

  def test_internal_verify_can_be_used_by_polling_workers
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

  def test_payment_received_notification_marks_settled_without_lookup
    adapter, client, completed = build_adapter
    created = adapter.create_invoice(
      controller: Controller.new(7),
      params: { "amount_msats" => 200_000, "fruit" => "banana" },
      headers: { "idempotency-key" => "order-123" }
    )
    invoice_id = created.fetch("body").fetch("invoice_id")

    settled = adapter.handle_payment_received(notification: { "payment_hash" => "a" * 64, "settled_at" => 1300 })
    replayed = adapter.handle_payment_received(notification: { "payment_hash" => "a" * 64 })

    assert_equal "settlement_action_completed", settled.fetch("workflow_state")
    assert_equal 1300, settled.fetch("settled_at")
    assert_equal "settlement_action_completed", replayed.fetch("workflow_state")
    assert_equal [invoice_id], completed
    assert_empty client.lookup_invoice_calls
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
