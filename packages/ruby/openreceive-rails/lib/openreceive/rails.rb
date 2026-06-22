# frozen_string_literal: true

require "fileutils"
require "securerandom"
require "openreceive"

module OpenReceive
  module Rails
    module Routes
      module_function

      def draw(router)
        router.post "/v1/invoices", to: "invoices#create"
        router.get "/v1/invoices/:invoice_id", to: "invoices#show"
        router.post "/v1/poll", to: "invoices#poll"
        router.get "/v1/poll", to: "invoices#poll"
      end
    end

    class Configuration
      attr_accessor :client,
                    :store,
                    :merchant_scope,
                    :authenticate,
                    :authorize_invoice,
                    :metadata,
                    :settlement_action,
                    :production,
                    :allow_unauthenticated_demo

      def initialize
        @store = OpenReceive::InMemoryInvoiceKvStore.new
        @merchant_scope = "default"
        @production = false
        @allow_unauthenticated_demo = false
      end

      def validate!
        raise ArgumentError, "client is required" if client.nil?
        if production && authenticate.nil? && !allow_unauthenticated_demo
          raise SecurityError, "OpenReceive Rails adapter requires authenticate in production"
        end
        if production && store.is_a?(OpenReceive::InMemoryInvoiceKvStore)
          raise SecurityError, "OpenReceive Rails adapter requires durable invoice storage in production"
        end
        self
      end
    end

    class SqliteInvoiceStore
      DEFAULT_NAMESPACE = "default"
      SCHEMA_VERSION = "v0.1"
      TERMINAL_WORKFLOW_STATES = %w[
        settlement_action_completed
        expired_closed
        failed_closed
        cancelled
      ].freeze
      TERMINAL_TRANSACTION_STATES = %w[settled expired failed].freeze

      def initialize(path:, namespace: DEFAULT_NAMESPACE, database: nil)
        require "sqlite3" if database.nil? && !defined?(SQLite3)

        @namespace = normalize_namespace(namespace)
        @database = database || SQLite3::Database.new(path)
        @database.results_as_hash = true if @database.respond_to?(:results_as_hash=)
        ensure_schema
      end

      def check_idempotency(scope:, idempotency_request_hash:)
        data = stringify_keys(scope)
        row = row_by_control("idempotency_scope", scope_key(scope))
        return nil if row.nil?

        raise OpenReceive::IdempotencyConflictError.new(data) unless row.fetch("idempotency_request_hash") == idempotency_request_hash

        { "status" => "replayed", "row" => row }
      end

      def create_invoice(row)
        data = stringify_keys(row)
        replay = check_idempotency(
          scope: data,
          idempotency_request_hash: data.fetch("idempotency_request_hash")
        )
        return replay unless replay.nil?

        @database.execute(
          "INSERT INTO #{invoice_table} (invoice_id, rev, payment_hash, bolt11, idempotency_scope, terminal, expires_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            data.fetch("invoice_id"),
            0,
            data.fetch("payment_hash"),
            data.fetch("invoice"),
            scope_key(data),
            terminal?(data) ? 1 : 0,
            Integer(data.fetch("expires_at")),
            encode_record(0, data)
          ]
        )
        { "status" => "created", "row" => data }
      rescue SQLite3::ConstraintException
        replay = check_idempotency(
          scope: data,
          idempotency_request_hash: data.fetch("idempotency_request_hash")
        )
        return replay unless replay.nil?

        raise OpenReceive::InvoiceStorageConflictError.new("invoice_id, payment_hash, invoice, and idempotency scope must be unique")
      end

      def find_by_invoice_id(invoice_id)
        row_by_control("invoice_id", invoice_id)
      end

      def find_by_payment_hash(payment_hash)
        row_by_control("payment_hash", payment_hash)
      end

      def recoverable_invoices(now:, grace_seconds: 15)
        Integer(now)
        Integer(grace_seconds)
        @database.execute(
          "SELECT data FROM #{invoice_table} WHERE terminal = 0 ORDER BY expires_at ASC, invoice_id ASC"
        ).map { |record| decode_row(record.fetch("data")) }
      end

      def mark_verifying(invoice_id:)
        update_invoice(invoice_id) do |record|
          if record["transaction_state"] != "settled" &&
              %w[invoice_created expiry_pending_verification].include?(record["workflow_state"])
            record["workflow_state"] = "verifying"
          end
        end
      end

      def mark_expiry_pending_verification(invoice_id:)
        update_invoice(invoice_id) do |record|
          unless TERMINAL_TRANSACTION_STATES.include?(record["transaction_state"])
            record["workflow_state"] = "expiry_pending_verification"
          end
        end
      end

      def mark_settled(invoice_id:, settled_at:)
        update_invoice(invoice_id) do |record|
          record["transaction_state"] = "settled"
          record["workflow_state"] = "settlement_action_pending" unless record["workflow_state"] == "settlement_action_completed"
          record["settled_at"] ||= Integer(settled_at)
        end
      end

      def mark_expired_closed(invoice_id:)
        update_invoice(invoice_id) do |record|
          if record["transaction_state"] != "settled"
            record["transaction_state"] = "expired"
            record["workflow_state"] = "expired_closed"
          end
        end
      end

      def mark_failed_closed(invoice_id:)
        update_invoice(invoice_id) do |record|
          if record["transaction_state"] != "settled"
            record["transaction_state"] = "failed"
            record["workflow_state"] = "failed_closed"
          end
        end
      end

      def mark_settlement_action_completed(invoice_id:, settlement_action_completed_at:)
        update_invoice(invoice_id) do |record|
          record["workflow_state"] = "settlement_action_completed"
          record["settlement_action_state"] = "completed"
          record["settlement_action_completed_at"] ||= Integer(settlement_action_completed_at)
        end
      end

      def mark_settlement_action_failed(invoice_id:)
        update_invoice(invoice_id) do |record|
          record["workflow_state"] = "settlement_action_pending"
          record["settlement_action_state"] = "failed"
        end
      end

      def doctor
        owner = meta_value("owner")
        version = meta_value("schema_version")
        [
          doctor_check("rails.store.owned", owner == "openreceive" ? "ok" : "error", "OpenReceive-owned SQLite store namespace=#{@namespace}"),
          doctor_check("rails.store.schema", version == SCHEMA_VERSION ? "ok" : "error", "schema_version=#{version || "missing"}")
        ]
      rescue StandardError => error
        [doctor_check("rails.store", "error", error.message)]
      end

      private

      def doctor_check(name, status, message)
        { "name" => name, "status" => status, "message" => message }
      end

      def ensure_schema
        @database.execute("PRAGMA journal_mode = WAL")
        @database.execute(
          "CREATE TABLE IF NOT EXISTS #{invoice_table} (" \
          "invoice_id TEXT PRIMARY KEY, " \
          "rev INTEGER NOT NULL, " \
          "payment_hash TEXT NOT NULL UNIQUE, " \
          "bolt11 TEXT NOT NULL UNIQUE, " \
          "idempotency_scope TEXT NOT NULL UNIQUE, " \
          "terminal INTEGER NOT NULL DEFAULT 0, " \
          "expires_at INTEGER NOT NULL, " \
          "data TEXT NOT NULL)"
        )
        @database.execute(
          "CREATE INDEX IF NOT EXISTS #{quoted_identifier("#{@namespace}_openreceive_open_idx")} " \
          "ON #{invoice_table} (terminal, expires_at)"
        )
        @database.execute(
          "CREATE TABLE IF NOT EXISTS #{meta_table} (" \
          "key TEXT PRIMARY KEY, " \
          "value TEXT NOT NULL, " \
          "rev INTEGER NOT NULL DEFAULT 0)"
        )
        claim_meta("owner", "openreceive")
        claim_meta("schema_version", SCHEMA_VERSION)
        claim_meta("namespace", @namespace)
      end

      def update_invoice(invoice_id)
        current = record_by_invoice_id(invoice_id)
        raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if current.nil?

        row = current.fetch("row")
        yield row
        write_record(row, current.fetch("rev") + 1)
        row
      end

      def row_by_control(column, value)
        record = record_by_control(column, value)
        record.nil? ? nil : record.fetch("row")
      end

      def record_by_invoice_id(invoice_id)
        record_by_control("invoice_id", invoice_id)
      end

      def record_by_control(column, value)
        unless %w[invoice_id payment_hash idempotency_scope].include?(column)
          raise ArgumentError, "unsupported control lookup"
        end

        record = @database.get_first_row(
          "SELECT rev, data FROM #{invoice_table} WHERE #{column} = ? LIMIT 1",
          value
        )
        return nil if record.nil?

        {
          "rev" => Integer(record.fetch("rev")),
          "row" => decode_row(record.fetch("data"))
        }
      end

      def write_record(row, rev)
        @database.execute(
          "UPDATE #{invoice_table} SET rev = ?, payment_hash = ?, bolt11 = ?, idempotency_scope = ?, terminal = ?, expires_at = ?, data = ? WHERE invoice_id = ?",
          [
            rev,
            row.fetch("payment_hash"),
            row.fetch("invoice"),
            scope_key(row),
            terminal?(row) ? 1 : 0,
            Integer(row.fetch("expires_at")),
            encode_record(rev, row),
            row.fetch("invoice_id")
          ]
        )
      end

      def decode_row(data)
        JSON.parse(data).fetch("row")
      end

      def encode_record(rev, row)
        JSON.generate("rev" => rev, "row" => row)
      end

      def terminal?(row)
        TERMINAL_WORKFLOW_STATES.include?(row.fetch("workflow_state"))
      end

      def scope_key(scope)
        data = stringify_keys(scope)
        OpenReceive.idempotency_scope_key(
          merchant_scope: data.fetch("merchant_scope"),
          operation: data.fetch("operation"),
          idempotency_key: data.fetch("idempotency_key")
        )
      end

      def claim_meta(key, value)
        @database.execute(
          "INSERT OR IGNORE INTO #{meta_table} (key, value, rev) VALUES (?, ?, 0)",
          [key, value]
        )
      end

      def meta_value(key)
        row = @database.get_first_row(
          "SELECT value FROM #{meta_table} WHERE key = ? LIMIT 1",
          key
        )
        row&.fetch("value")
      end

      def invoice_table
        quoted_identifier("#{@namespace}_openreceive_invoices")
      end

      def meta_table
        quoted_identifier("#{@namespace}_openreceive_meta")
      end

      def quoted_identifier(identifier)
        %("#{identifier.gsub("\"", "\"\"")}")
      end

      def normalize_namespace(value)
        namespace = value.to_s.strip
        unless /\A[a-z0-9_]{1,40}\z/.match?(namespace)
          raise ArgumentError, "OPENRECEIVE_NAMESPACE must match ^[a-z0-9_]{1,40}$"
        end
        namespace
      end

      def stringify_keys(value)
        value.each_pair.each_with_object({}) do |(key, item), result|
          result[key.to_s] = item
        end
      end
    end

    class Adapter
      CREATE_OPERATION = "invoice.create"
      STORE_METHODS = %i[
        check_idempotency
        create_invoice
        find_by_invoice_id
        find_by_payment_hash
        recoverable_invoices
        mark_verifying
        mark_expiry_pending_verification
        mark_settled
        mark_expired_closed
        mark_failed_closed
        mark_settlement_action_completed
        mark_settlement_action_failed
      ].freeze

      def initialize(config = Configuration.new)
        @config = config
        @config.validate!
      end

      def doctor
        checks = []
        missing_store_methods = STORE_METHODS.reject { |method| @config.store.respond_to?(method) }
        checks << if missing_store_methods.empty?
                    doctor_check("rails.store", "ok", "invoice store responds to required lifecycle methods")
                  else
                    doctor_check("rails.store", "error", "invoice store missing #{missing_store_methods.join(", ")}")
                  end

        if @config.store.respond_to?(:doctor)
          checks.concat(@config.store.doctor)
        elsif @config.store.is_a?(OpenReceive::InMemoryInvoiceKvStore)
          checks << doctor_check("rails.store.durable", "error", "InMemoryInvoiceKvStore is for tests only; configure OPENRECEIVE_STORE with OpenReceive::Rails.resolve_invoice_store")
        else
          checks << doctor_check("rails.store.durable", "error", "invoice store must expose doctor ownership/schema diagnostics")
        end

        checks.concat(client_doctor_checks)
        checks << if @config.store.respond_to?(:recoverable_invoices)
                    doctor_check("rails.poll", "ok", "one-shot poll can recover invoices from the configured store")
                  else
                    doctor_check("rails.poll", "error", "store does not support recoverable_invoices")
                  end
        {
          "ok" => checks.none? { |check| check.fetch("status") == "error" },
          "checks" => checks
        }
      end

      def create_invoice(controller:, params:, headers: {})
        authenticate!(controller)
        idempotency_key = header(headers, "idempotency-key") || params["idempotency_key"]
        raise ArgumentError, "idempotency key is required" if blank?(idempotency_key)

        metadata = build_metadata(controller, params)
        request = create_request(params, metadata)
        scope = idempotency_scope(idempotency_key)
        request_hash = OpenReceive.idempotency_request_hash(request)
        replay = @config.store.check_idempotency(
          scope: scope,
          idempotency_request_hash: request_hash
        )
        return response(200, invoice_payload(replay.fetch("row"))) unless replay.nil?

        wallet_invoice = @config.client.make_invoice(request)
        normalized = OpenReceive.normalize_make_invoice_response(wallet_invoice)
        row = invoice_row(scope, request_hash, normalized, metadata)
        created = @config.store.create_invoice(row)
        response(201, invoice_payload(created.fetch("row")))
      end

      def lookup_invoice(controller:, invoice_id:)
        row = @config.store.find_by_invoice_id(invoice_id)
        raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if row.nil?

        authenticate!(controller)
        authorize!(controller, row)
        response(200, invoice_payload(verify_invoice(invoice_id: invoice_id)))
      end

      def verify_invoice(invoice_id:)
        row = @config.store.find_by_invoice_id(invoice_id)
        raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if row.nil?

        verify_stored_invoice(row)
      end

      def poll_recoverable_invoices(now: Time.now.to_i)
        unless @config.store.respond_to?(:recoverable_invoices)
          raise NotImplementedError, "OpenReceive store must provide recoverable_invoices"
        end

        @config.store.recoverable_invoices(now: now).map do |row|
          verify_stored_invoice(row)
        end
      end

      def poll(controller:, now: Time.now.to_i)
        authenticate!(controller)
        invoices = poll_recoverable_invoices(now: now)
        response(200, {
          "invoice_ids" => invoices.map { |invoice| invoice.fetch("invoice_id") },
          "checked" => invoices.length
        })
      end

      private

      def doctor_check(name, status, message)
        { "name" => name, "status" => status, "message" => message }
      end

      def client_doctor_checks
        unless @config.client.respond_to?(:preflight)
          return [doctor_check("rails.nwc", "warn", "client does not expose preflight; invoice creation will fail closed if NWC is unavailable")]
        end

        @config.client.preflight
        [doctor_check("rails.nwc", "ok", "NWC preflight completed")]
      rescue StandardError => error
        [doctor_check("rails.nwc", "error", "NWC preflight failed: #{redact_diagnostic_message(error.message)}")]
      end

      def redact_diagnostic_message(message)
        message.to_s
               .gsub(%r{nostr\+walletconnect://[^\s"'`<>]+}, "[REDACTED_NWC]")
               .gsub(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/i, "\\1[REDACTED]")
      end

      def verify_stored_invoice(row)
        if %w[invoice_created expiry_pending_verification].include?(row.fetch("workflow_state"))
          row = @config.store.mark_verifying(invoice_id: row.fetch("invoice_id"))
        end

        lookup = @config.client.lookup_invoice("payment_hash" => row.fetch("payment_hash"))
        normalized = OpenReceive.normalize_lookup_invoice_response(lookup)
        if OpenReceive.expired?(normalized)
          return @config.store.mark_expired_closed(invoice_id: row.fetch("invoice_id"))
        end
        if OpenReceive.failed?(normalized)
          return @config.store.mark_failed_closed(invoice_id: row.fetch("invoice_id"))
        end
        return row unless OpenReceive.settled?(normalized)

        settled_at = normalized["settled_at"] || Time.now.to_i
        settled = @config.store.mark_settled(
          invoice_id: row.fetch("invoice_id"),
          settled_at: settled_at
        )
        run_settlement_action_once(settled)
      end

      def authenticate!(controller)
        return @config.authenticate.call(controller) unless @config.authenticate.nil?
        return true unless @config.production
        return true if @config.allow_unauthenticated_demo

        raise SecurityError, "OpenReceive Rails adapter requires authenticate in production"
      end

      def authorize!(controller, invoice)
        return true if @config.authorize_invoice.nil?
        raise SecurityError, "invoice access denied" unless @config.authorize_invoice.call(controller, invoice)

        true
      end

      def build_metadata(controller, params)
        return {} if @config.metadata.nil?

        @config.metadata.call(controller, params)
      end

      def create_request(params, metadata)
        request = {
          "amount_msats" => Integer(params.fetch("amount_msats")),
          "metadata" => metadata
        }
        request["description"] = params["description"] if params.key?("description")
        request["description_hash"] = params["description_hash"] if params.key?("description_hash")
        request["expiry"] = Integer(params["expiry"]) if params.key?("expiry")
        OpenReceive.make_invoice_nip47_request(request)
        request
      end

      def idempotency_scope(idempotency_key)
        {
          "merchant_scope" => @config.merchant_scope,
          "operation" => CREATE_OPERATION,
          "idempotency_key" => idempotency_key
        }
      end

      def invoice_row(scope, request_hash, wallet_invoice, metadata)
        now = wallet_invoice["created_at"] || Time.now.to_i
        {
          "invoice_id" => "or_inv_#{SecureRandom.hex(12)}",
          "merchant_scope" => scope.fetch("merchant_scope"),
          "operation" => scope.fetch("operation"),
          "idempotency_key" => scope.fetch("idempotency_key"),
          "idempotency_request_hash" => request_hash,
          "payment_hash" => wallet_invoice.fetch("payment_hash"),
          "invoice" => wallet_invoice.fetch("invoice"),
          "amount_msats" => wallet_invoice.fetch("amount_msats"),
          "transaction_state" => "pending",
          "workflow_state" => "invoice_created",
          "settlement_action_state" => "pending",
          "created_at" => now,
          "expires_at" => wallet_invoice["expires_at"] || now + 600,
          "metadata" => metadata
        }
      end

      def run_settlement_action_once(invoice)
        return invoice if invoice["settlement_action_state"] == "completed"

        unless @config.settlement_action.nil?
          begin
            @config.settlement_action.call(invoice)
          rescue StandardError
            @config.store.mark_settlement_action_failed(invoice_id: invoice.fetch("invoice_id"))
            raise
          end
        end

        @config.store.mark_settlement_action_completed(
          invoice_id: invoice.fetch("invoice_id"),
          settlement_action_completed_at: Time.now.to_i
        )
      end

      def invoice_payload(row)
        {
          "invoice_id" => row.fetch("invoice_id"),
          "invoice" => row.fetch("invoice"),
          "payment_hash" => row.fetch("payment_hash"),
          "amount_msats" => row.fetch("amount_msats"),
          "transaction_state" => row.fetch("transaction_state"),
          "workflow_state" => row.fetch("workflow_state"),
          "settlement_action_state" => row.fetch("settlement_action_state"),
          "created_at" => row.fetch("created_at"),
          "expires_at" => row.fetch("expires_at"),
          "settled_at" => row["settled_at"],
          "settlement_action_completed_at" => row["settlement_action_completed_at"]
        }.reject { |_key, value| value.nil? }
      end

      def response(status, body)
        { "status" => status, "body" => body }
      end

      def header(headers, name)
        headers[name] || headers[name.downcase] || headers[name.upcase]
      end

      def blank?(value)
        value.nil? || value.to_s.empty?
      end

      def stringify_keys(value)
        return {} unless value.respond_to?(:each_pair)

        value.each_pair.each_with_object({}) do |(key, item), result|
          result[key.to_s] = item
        end
      end
    end

    if defined?(::ActionController::Base)
      class InvoicesController < ::ActionController::Base
        protect_from_forgery with: :exception if respond_to?(:protect_from_forgery)
        rescue_from OpenReceive::WalletUnavailableError, with: :render_openreceive_error if respond_to?(:rescue_from)

        def create
          result = OpenReceive::Rails.adapter.create_invoice(
            controller: self,
            params: openreceive_params,
            headers: request.headers
          )
          render json: result.fetch("body"), status: result.fetch("status")
        end

        def show
          result = OpenReceive::Rails.adapter.lookup_invoice(
            controller: self,
            invoice_id: params.fetch(:invoice_id)
          )
          render json: result.fetch("body"), status: result.fetch("status")
        end

        def poll
          result = OpenReceive::Rails.adapter.poll(controller: self)
          render json: result.fetch("body"), status: result.fetch("status")
        end

        private

        def openreceive_params
          return params.to_unsafe_h if params.respond_to?(:to_unsafe_h)
          return params.to_h if params.respond_to?(:to_h)

          params
        end

        def render_openreceive_error(error)
          render json: {
            code: error.code,
            message: error.message
          }, status: error.status
        end
      end
    end

    class Engine < ::Rails::Engine
      isolate_namespace OpenReceive::Rails

      routes.draw do
        OpenReceive::Rails::Routes.draw(self)
      end
    end if defined?(::Rails::Engine)

    class << self
      attr_writer :configuration

      def configuration
        @configuration ||= Configuration.new
      end

      def configure
        yield configuration
        configuration
      end

      def adapter
        Adapter.new(configuration)
      end

      def resolve_invoice_store(
        uri: ENV["OPENRECEIVE_STORE"],
        namespace: ENV.fetch("OPENRECEIVE_NAMESPACE", "default"),
        root: Dir.pwd
      )
        store_uri = uri.to_s.strip
        case store_uri
        when "", "memory:", "memory"
          OpenReceive::InMemoryInvoiceKvStore.new
        when "local-sqlite"
          path = File.join(root, ".openreceive")
          FileUtils.mkdir_p(path)
          SqliteInvoiceStore.new(
            path: File.join(path, "#{namespace}.sqlite3"),
            namespace: namespace
          )
        else
          if store_uri.start_with?("sqlite:///")
            SqliteInvoiceStore.new(path: store_uri.delete_prefix("sqlite://"), namespace: namespace)
          elsif store_uri.start_with?("sqlite://")
            SqliteInvoiceStore.new(path: store_uri.delete_prefix("sqlite://"), namespace: namespace)
          elsif store_uri.start_with?("sqlite:")
            SqliteInvoiceStore.new(path: store_uri.delete_prefix("sqlite:"), namespace: namespace)
          else
            raise ArgumentError, "Set OPENRECEIVE_STORE to local-sqlite, sqlite://, or memory: for the current Rails adapter."
          end
        end
      end
    end
  end
end
