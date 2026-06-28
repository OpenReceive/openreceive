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
        router.post "/v1/invoices/:invoice_id/status", to: "invoices#status"
      end
    end

    class Configuration
      attr_accessor :client,
                    :store,
                    :namespace,
                    :metadata,
                    :settlement_action,
                    :production,
                    :transaction_scan_interval_seconds,
                    :transaction_scan_page_limit,
                    :transaction_scan_window_padding_seconds

      def initialize
        @store = OpenReceive::InMemoryInvoiceKvStore.new
        @namespace = "default"
        @production = false
        @transaction_scan_interval_seconds = 2
        @transaction_scan_page_limit = 20
        @transaction_scan_window_padding_seconds = 0
      end

      def validate!
        raise ArgumentError, "client is required" if client.nil?
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

      def find_by_bolt11_invoice(invoice)
        row_by_control("bolt11", invoice)
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

      def get_meta(key)
        row = @database.get_first_row(
          "SELECT value, rev FROM #{meta_table} WHERE key = ? LIMIT 1",
          key
        )
        row.nil? ? nil : { "value" => row.fetch("value"), "rev" => Integer(row.fetch("rev")) }
      end

      def cas_meta(key:, value:, expected_rev:)
        raise ArgumentError, "meta key must be a non-empty string" unless key.is_a?(String) && !key.empty?

        current = get_meta(key)
        if expected_rev.nil?
          return { "status" => "conflict", "row" => current } unless current.nil?

          @database.execute(
            "INSERT INTO #{meta_table} (key, value, rev) VALUES (?, ?, 0)",
            [key, value]
          )
          return { "status" => "ok", "row" => { "value" => value, "rev" => 0 } }
        end

        return { "status" => "conflict", "row" => current || { "value" => "", "rev" => -1 } } if current.nil?

        updated = @database.execute(
          "UPDATE #{meta_table} SET value = ?, rev = ? WHERE key = ? AND rev = ?",
          [value, Integer(expected_rev) + 1, key, Integer(expected_rev)]
        )
        if updated.respond_to?(:changes) && updated.changes.zero?
          latest = get_meta(key)
          return { "status" => "conflict", "row" => latest || { "value" => "", "rev" => -1 } }
        end

        { "status" => "ok", "row" => { "value" => value, "rev" => Integer(expected_rev) + 1 } }
      rescue SQLite3::ConstraintException
        current = get_meta(key)
        { "status" => "conflict", "row" => current || { "value" => "", "rev" => -1 } }
      end

      private

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
        unless %w[invoice_id payment_hash bolt11 idempotency_scope].include?(column)
          raise ArgumentError, "unsupported control read"
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
          namespace: data.fetch("namespace"),
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
        find_by_bolt11_invoice
        mark_verifying
        mark_expiry_pending_verification
        mark_settled
        mark_expired_closed
        mark_failed_closed
        mark_settlement_action_completed
        mark_settlement_action_failed
        get_meta
        cas_meta
      ].freeze

      TRANSACTION_SCAN_GATE_META_KEY = "transaction_scan_gate"

      def initialize(config = Configuration.new)
        @config = config
        @config.validate!
      end

      def create_invoice(controller:, params:, headers: {})
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

      def get_invoice(controller:, invoice_id:)
        row = @config.store.find_by_invoice_id(invoice_id)
        raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if row.nil?

        response(200, invoice_payload(row))
      end

      def refresh_invoice_status(controller:, invoice_id:, now: Time.now.to_i)
        row = @config.store.find_by_invoice_id(invoice_id)
        raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if row.nil?

        if terminal?(row)
          body = invoice_payload(row)
          body["wallet_scan_performed"] = false
          body["transactions_checked"] = 0
          return response(200, body)
        end

        unless claim_transaction_scan_gate(now)
          body = invoice_payload(row)
          body["wallet_scan_performed"] = false
          body["transactions_checked"] = 0
          return response(200, body)
        end

        refreshed = refresh_stored_invoice(row, now: now)
        body = invoice_payload(refreshed.fetch("row"))
        body["wallet_scan_performed"] = refreshed.fetch("wallet_scan_performed")
        body["transactions_checked"] = refreshed.fetch("transactions_checked")
        response(200, body)
      end

      private

      def terminal?(row)
        %w[
          settlement_action_completed
          expired_closed
          failed_closed
          cancelled
        ].include?(row.fetch("workflow_state"))
      end

      def refresh_stored_invoice(row, now:)
        window = creation_window(row)
        cursor = read_transaction_scan_cursor(window)
        begin
          result = @config.client.list_transactions(
            "type" => "incoming",
            "unpaid" => true,
            "from" => cursor.fetch("from"),
            "until" => cursor.fetch("until"),
            "limit" => cursor.fetch("limit"),
            "offset" => cursor.fetch("offset")
          )
          transactions = OpenReceive.normalize_list_transactions_response(result).fetch("transactions")
        rescue StandardError
          return {
            "row" => row,
            "transactions_checked" => 0,
            "wallet_scan_performed" => false
          }
        end

        apply_transaction_page(transactions, window, now: now)
        advance_transaction_scan_cursor(cursor, transactions.length, now)
        latest = @config.store.find_by_invoice_id(row.fetch("invoice_id")) || row
        {
          "row" => latest,
          "transactions_checked" => transactions.length,
          "wallet_scan_performed" => true
        }
      end

      def apply_transaction_page(transactions, window, now:)
        transactions.each do |transaction|
          next if transaction["type"] && transaction["type"] != "incoming"

          row = find_local_invoice_for_transaction(transaction)
          next if row.nil? || terminal?(row)
          created_at = row.fetch("created_at")
          next unless created_at >= window.fetch("from") && created_at <= window.fetch("until")

          apply_transaction_to_invoice(row, transaction, now: now)
        end
      end

      def find_local_invoice_for_transaction(transaction)
        if transaction["payment_hash"]
          row = @config.store.find_by_payment_hash(transaction["payment_hash"])
          return row unless row.nil?
        end

        return nil unless transaction["invoice"]

        @config.store.find_by_bolt11_invoice(transaction["invoice"])
      end

      def apply_transaction_to_invoice(row, transaction, now:)
        if OpenReceive.expired?(transaction)
          row = @config.store.mark_expired_closed(invoice_id: row.fetch("invoice_id"))
          return row
        end
        if OpenReceive.failed?(transaction)
          row = @config.store.mark_failed_closed(invoice_id: row.fetch("invoice_id"))
          return row
        end
        unless OpenReceive.settled?(transaction)
          return @config.store.mark_verifying(invoice_id: row.fetch("invoice_id"))
        end

        settled_at = transaction["settled_at"] || now
        settled = @config.store.mark_settled(
          invoice_id: row.fetch("invoice_id"),
          settled_at: settled_at
        )
        run_settlement_action_once(settled)
      end

      def claim_transaction_scan_gate(now)
        interval = positive_integer(@config.transaction_scan_interval_seconds, "transaction_scan_interval_seconds")
        6.times do
          current = @config.store.get_meta(TRANSACTION_SCAN_GATE_META_KEY)
          if current
            claimed_at = parse_claimed_at(current.fetch("value"))
            return false if claimed_at && now - claimed_at < interval
          end

          claimed = @config.store.cas_meta(
            key: TRANSACTION_SCAN_GATE_META_KEY,
            value: JSON.generate("claimed_at" => now),
            expected_rev: current ? current.fetch("rev") : nil
          )
          return true if claimed.fetch("status") == "ok"
        end
        false
      end

      def creation_window(row)
        padding = nonnegative_integer(@config.transaction_scan_window_padding_seconds, "transaction_scan_window_padding_seconds")
        created_at = Integer(row.fetch("created_at"))
        {
          "from" => [created_at - padding, 0].max,
          "until" => created_at + padding,
          "limit" => positive_integer(@config.transaction_scan_page_limit, "transaction_scan_page_limit")
        }
      end

      def read_transaction_scan_cursor(window)
        row = @config.store.get_meta(transaction_scan_cursor_key(window))
        return window.merge("offset" => 0, "cycle" => 0) if row.nil?

        parsed = JSON.parse(row.fetch("value"))
        window.merge(
          "offset" => nonnegative_or_default(parsed["offset"], 0),
          "cycle" => nonnegative_or_default(parsed["cycle"], 0),
          "last_page_scanned_at" => nonnegative_or_default(parsed["last_page_scanned_at"], nil)
        ).compact
      rescue JSON::ParserError
        window.merge("offset" => 0, "cycle" => 0)
      end

      def advance_transaction_scan_cursor(cursor, count, now)
        key = transaction_scan_cursor_key(cursor)
        6.times do
          current = @config.store.get_meta(key)
          latest = current.nil? ? cursor : read_transaction_scan_cursor(cursor)
          full_page = count >= latest.fetch("limit")
          next_cursor = latest.merge(
            "offset" => full_page ? latest.fetch("offset") + latest.fetch("limit") : 0,
            "cycle" => full_page ? latest.fetch("cycle") : latest.fetch("cycle") + 1,
            "last_page_scanned_at" => now
          )
          updated = @config.store.cas_meta(
            key: key,
            value: JSON.generate(next_cursor),
            expected_rev: current ? current.fetch("rev") : nil
          )
          return if updated.fetch("status") == "ok"
        end
      end

      def transaction_scan_cursor_key(window)
        "transaction_scan_cursor:#{window.fetch("from")}:#{window.fetch("until")}"
      end

      def parse_claimed_at(value)
        parsed = JSON.parse(value)
        integer = parsed["claimed_at"]
        integer.is_a?(Integer) && integer >= 0 ? integer : nil
      rescue JSON::ParserError
        nil
      end

      def positive_integer(value, field)
        integer = Integer(value)
        raise ArgumentError, "#{field} must be positive" unless integer.positive?

        integer
      end

      def nonnegative_integer(value, field)
        integer = Integer(value)
        raise ArgumentError, "#{field} must be nonnegative" if integer.negative?

        integer
      end

      def nonnegative_or_default(value, default)
        integer = Integer(value)
        integer.negative? ? default : integer
      rescue ArgumentError, TypeError
        default
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
          "namespace" => @config.namespace,
          "operation" => CREATE_OPERATION,
          "idempotency_key" => idempotency_key
        }
      end

      def invoice_row(scope, request_hash, wallet_invoice, metadata)
        now = wallet_invoice["created_at"] || Time.now.to_i
        {
          "invoice_id" => "or_inv_#{SecureRandom.hex(12)}",
          "namespace" => scope.fetch("namespace"),
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
          result = OpenReceive::Rails.adapter.get_invoice(
            controller: self,
            invoice_id: params.fetch(:invoice_id)
          )
          render json: result.fetch("body"), status: result.fetch("status")
        end

        def status
          result = OpenReceive::Rails.adapter.refresh_invoice_status(
            controller: self,
            invoice_id: params.fetch(:invoice_id)
          )
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
