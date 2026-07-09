# frozen_string_literal: true

# Durable invoice store backed by ActiveRecord. Loads cleanly whether or not ActiveRecord is
# present: if the gem is absent, a stub class raises a clear error on instantiation.
#
# IMPORTANT (honesty): this store is a faithful port of the InMemoryInvoiceKvStore semantics
# against the normalized `openreceive_invoices` + `openreceive_meta` tables
# (packages/js/node/migrations/001_* and 002_*). It has NOT been exercised against a live
# database in this build — it is written against the ActiveRecord API and the canonical SQL
# schema. Treat it as review-ready but integration-test it before production use.
begin
  require "active_record"
rescue LoadError
  # ActiveRecord is an optional dependency; the stub below covers its absence.
end

require "json"

module OpenReceive
  module Server
    if defined?(ActiveRecord)
      # Same logical API as OpenReceive::InMemoryInvoiceKvStore, PLUS list_by_order_id,
      # list_by_checkout_id, list_open, ensure_schema, and mark_superseded — the reads the
      # service reconcile/create paths need. Uniqueness / idempotency / CAS logic is ported
      # from the in-memory store.
      class ActiveRecordInvoiceStore
        INVOICES_TABLE = "openreceive_invoices"
        META_TABLE = "openreceive_meta"

        TERMINAL_WORKFLOW_STATES = %w[
          settlement_action_completed expired_closed failed_closed cancelled
        ].freeze

        COLUMN_FIELDS = %w[
          invoice_id namespace operation idempotency_key idempotency_request_hash
          order_id checkout_id payment_hash invoice amount_msats transaction_state
          workflow_state settlement_action_state created_at expires_at settled_at
          settlement_action_completed_at refreshed_from_invoice_id order_access_token_hash
        ].freeze

        def initialize(connection: nil)
          @connection = connection
        end

        # --- schema --------------------------------------------------------------------------

        def ensure_schema
          connection.execute(<<~SQL)
            CREATE TABLE IF NOT EXISTS #{INVOICES_TABLE} (
              invoice_id TEXT PRIMARY KEY,
              namespace TEXT NOT NULL,
              operation TEXT NOT NULL,
              idempotency_key TEXT NOT NULL,
              idempotency_request_hash TEXT NOT NULL,
              order_id TEXT NOT NULL,
              checkout_id TEXT NOT NULL,
              payment_hash TEXT NOT NULL UNIQUE,
              invoice TEXT NOT NULL UNIQUE,
              amount_msats BIGINT NOT NULL,
              transaction_state TEXT NOT NULL,
              workflow_state TEXT NOT NULL,
              settlement_action_state TEXT NOT NULL,
              created_at BIGINT NOT NULL,
              expires_at BIGINT NOT NULL,
              settled_at BIGINT,
              settlement_action_completed_at BIGINT,
              refreshed_from_invoice_id TEXT,
              order_access_token_hash TEXT,
              metadata TEXT NOT NULL DEFAULT '{}',
              fiat_quote TEXT
            )
          SQL
          connection.execute(<<~SQL)
            CREATE UNIQUE INDEX IF NOT EXISTS openreceive_invoices_idempotency_scope_idx
              ON #{INVOICES_TABLE} (namespace, operation, idempotency_key)
          SQL
          connection.execute(<<~SQL)
            CREATE INDEX IF NOT EXISTS openreceive_invoices_order_idx
              ON #{INVOICES_TABLE} (order_id, created_at)
          SQL
          connection.execute(<<~SQL)
            CREATE INDEX IF NOT EXISTS openreceive_invoices_checkout_idx
              ON #{INVOICES_TABLE} (checkout_id, created_at)
          SQL
          connection.execute(<<~SQL)
            CREATE TABLE IF NOT EXISTS #{META_TABLE} (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              rev INTEGER NOT NULL DEFAULT 0
            )
          SQL
          self
        end

        # --- idempotency + writes ------------------------------------------------------------

        def check_idempotency(scope:, idempotency_request_hash:)
          data = stringify_keys(scope)
          transaction do
            existing = find_by_scope(data)
            return nil if existing.nil?

            unless existing["idempotency_request_hash"] == idempotency_request_hash
              raise OpenReceive::IdempotencyConflictError.new(data)
            end

            { "status" => "replayed", "row" => existing }
          end
        end

        def put_invoice_record(row)
          data = stringify_keys(row)
          validate_invoice_row(data)

          transaction do
            existing = find_by_scope(data)
            unless existing.nil?
              unless existing["idempotency_request_hash"] == data.fetch("idempotency_request_hash")
                raise OpenReceive::IdempotencyConflictError.new(data)
              end

              return { "status" => "replayed", "row" => existing }
            end

            assert_unique("invoice_id", data.fetch("invoice_id"))
            assert_unique("payment_hash", data.fetch("payment_hash"))
            assert_unique("invoice", data.fetch("invoice"))
            insert_row(data)
            { "status" => "created", "row" => require_stored_invoice(data.fetch("invoice_id")) }
          end
        end

        # --- reads ---------------------------------------------------------------------------

        def find_by_invoice_id(invoice_id)
          find_one("invoice_id", invoice_id)
        end

        def find_by_payment_hash(payment_hash)
          find_one("payment_hash", payment_hash)
        end

        def find_by_bolt11_invoice(invoice)
          find_one("invoice", invoice)
        end

        def require_stored_invoice(invoice_id)
          row = find_by_invoice_id(invoice_id)
          raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if row.nil?

          row
        end

        def list_by_order_id(order_id)
          rows_where("order_id = #{quote(order_id)} ORDER BY created_at ASC, invoice_id ASC")
        end

        def list_by_checkout_id(checkout_id)
          rows_where("checkout_id = #{quote(checkout_id)} ORDER BY created_at ASC, invoice_id ASC")
        end

        def list_open(now:, limit: 1000)
          threshold = Integer(now)
          terminal_list = TERMINAL_WORKFLOW_STATES.map { |state| quote(state) }.join(", ")
          rows_where(
            "expires_at > #{Integer(threshold)} AND workflow_state NOT IN (#{terminal_list}) " \
            "ORDER BY created_at ASC, invoice_id ASC LIMIT #{Integer(limit)}"
          )
        end

        # --- state machine -------------------------------------------------------------------

        def mark_verifying(invoice_id:)
          update_row(invoice_id) do |row|
            if row["transaction_state"] != "settled" &&
               %w[invoice_created expiry_pending_verification].include?(row["workflow_state"])
              row["workflow_state"] = "verifying"
            end
          end
        end

        def mark_expiry_pending_verification(invoice_id:)
          update_row(invoice_id) do |row|
            unless %w[settled expired failed].include?(row["transaction_state"])
              row["workflow_state"] = "expiry_pending_verification"
            end
          end
        end

        def mark_settled(invoice_id:, settled_at:)
          update_row(invoice_id) do |row|
            row["transaction_state"] = "settled"
            row["workflow_state"] = "settlement_action_pending" unless row["workflow_state"] == "settlement_action_completed"
            row["settled_at"] ||= Integer(settled_at)
          end
        end

        def mark_expired_closed(invoice_id:)
          update_row(invoice_id) do |row|
            if row["transaction_state"] != "settled"
              row["transaction_state"] = "expired"
              row["workflow_state"] = "expired_closed"
            end
          end
        end

        def mark_failed_closed(invoice_id:)
          update_row(invoice_id) do |row|
            if row["transaction_state"] != "settled"
              row["transaction_state"] = "failed"
              row["workflow_state"] = "failed_closed"
            end
          end
        end

        def mark_settlement_action_completed(invoice_id:, settlement_action_completed_at:)
          update_row(invoice_id) do |row|
            row["workflow_state"] = "settlement_action_completed"
            row["settlement_action_state"] = "completed"
            row["settlement_action_completed_at"] ||= Integer(settlement_action_completed_at)
          end
        end

        def mark_settlement_action_failed(invoice_id:)
          update_row(invoice_id) do |row|
            row["workflow_state"] = "settlement_action_pending"
            row["settlement_action_state"] = "failed"
          end
        end

        def mark_superseded(invoice_id:)
          update_row(invoice_id) do |row|
            row["metadata"] ||= {}
            row["metadata"]["superseded"] = true
          end
        end

        # --- meta KV (optimistic rev CAS) ----------------------------------------------------

        def get_meta(key)
          result = connection.exec_query("SELECT value, rev FROM #{META_TABLE} WHERE key = #{quote(key)}")
          row = result.to_a.first
          return nil if row.nil?

          { "value" => row["value"], "rev" => Integer(row["rev"]) }
        end

        def cas_meta(key:, value:, expected_rev:)
          raise ArgumentError, "meta key must be a non-empty string" unless key.is_a?(String) && !key.empty?

          transaction do
            current = get_meta(key)
            if expected_rev.nil?
              return { "status" => "conflict", "row" => current } unless current.nil?

              connection.execute(
                "INSERT INTO #{META_TABLE} (key, value, rev) VALUES (#{quote(key)}, #{quote(value)}, 0)"
              )
              return { "status" => "ok", "row" => { "value" => value, "rev" => 0 } }
            end

            if current.nil? || current["rev"] != Integer(expected_rev)
              return {
                "status" => "conflict",
                "row" => current.nil? ? { "value" => "", "rev" => -1 } : current
              }
            end

            next_rev = Integer(expected_rev) + 1
            connection.execute(
              "UPDATE #{META_TABLE} SET value = #{quote(value)}, rev = #{next_rev} " \
              "WHERE key = #{quote(key)} AND rev = #{Integer(expected_rev)}"
            )
            { "status" => "ok", "row" => { "value" => value, "rev" => next_rev } }
          end
        end

        def close
          nil
        end

        private

        def connection
          @connection || ActiveRecord::Base.connection
        end

        def transaction(&block)
          connection.transaction(&block)
        end

        def find_by_scope(data)
          rows_where(
            "namespace = #{quote(data.fetch('namespace'))} AND " \
            "operation = #{quote(data.fetch('operation'))} AND " \
            "idempotency_key = #{quote(data.fetch('idempotency_key'))} LIMIT 1"
          ).first
        end

        def find_one(column, value)
          rows_where("#{column} = #{quote(value)} LIMIT 1").first
        end

        def rows_where(clause)
          result = connection.exec_query("SELECT * FROM #{INVOICES_TABLE} WHERE #{clause}")
          result.to_a.map { |record| deserialize_row(record) }
        end

        def assert_unique(column, value)
          existing = connection.exec_query(
            "SELECT 1 FROM #{INVOICES_TABLE} WHERE #{column} = #{quote(value)} LIMIT 1"
          )
          return if existing.to_a.empty?

          raise OpenReceive::InvoiceStorageConflictError.new("#{column} must be unique")
        end

        def insert_row(data)
          columns = COLUMN_FIELDS.dup
          columns << "metadata"
          columns << "fiat_quote"
          values = COLUMN_FIELDS.map { |field| quote(column_value(data, field)) }
          values << quote(JSON.generate(data["metadata"] || {}))
          values << quote(data["fiat_quote"].nil? ? nil : JSON.generate(data["fiat_quote"]))
          connection.execute(
            "INSERT INTO #{INVOICES_TABLE} (#{columns.join(', ')}) VALUES (#{values.join(', ')})"
          )
        end

        def column_value(data, field)
          case field
          when "order_id"
            data["order_id"] || dig_metadata(data, "order_id")
          when "checkout_id"
            data["checkout_id"] || dig_metadata(data, "checkout_id")
          else
            data[field]
          end
        end

        def update_row(invoice_id)
          transaction do
            row = require_stored_invoice(invoice_id)
            yield(row)
            persist_row(row)
            require_stored_invoice(invoice_id)
          end
        end

        def persist_row(row)
          assignments = []
          assignments << "transaction_state = #{quote(row['transaction_state'])}"
          assignments << "workflow_state = #{quote(row['workflow_state'])}"
          assignments << "settlement_action_state = #{quote(row['settlement_action_state'])}"
          assignments << "settled_at = #{quote(row['settled_at'])}"
          assignments << "settlement_action_completed_at = #{quote(row['settlement_action_completed_at'])}"
          assignments << "metadata = #{quote(JSON.generate(row['metadata'] || {}))}"
          connection.execute(
            "UPDATE #{INVOICES_TABLE} SET #{assignments.join(', ')} " \
            "WHERE invoice_id = #{quote(row['invoice_id'])}"
          )
        end

        def deserialize_row(record)
          row = {}
          COLUMN_FIELDS.each do |field|
            next unless record.key?(field)

            value = record[field]
            row[field] = value unless value.nil?
          end
          %w[amount_msats created_at expires_at settled_at settlement_action_completed_at].each do |field|
            row[field] = Integer(row[field]) if row.key?(field) && !row[field].nil?
          end
          row["metadata"] = parse_json(record["metadata"]) || {}
          fiat_quote = parse_json(record["fiat_quote"])
          row["fiat_quote"] = fiat_quote unless fiat_quote.nil?
          # order_id / checkout_id live in both columns and metadata; make sure metadata carries
          # them so the wire snapshot builders (which read metadata first) stay correct.
          row["metadata"]["order_id"] ||= row["order_id"] if row["order_id"]
          row["metadata"]["checkout_id"] ||= row["checkout_id"] if row["checkout_id"]
          row
        end

        def validate_invoice_row(row)
          %w[
            invoice_id idempotency_request_hash payment_hash invoice
            namespace operation idempotency_key
          ].each do |key|
            value = row[key]
            raise ArgumentError, "#{key} must be a non-empty string" unless value.is_a?(String) && !value.empty?
          end
          unless /\Asha256:[0-9a-f]{64}\z/.match?(row.fetch("idempotency_request_hash").to_s)
            raise ArgumentError, "idempotency_request_hash must be sha256:<64 hex>"
          end
          raise ArgumentError, "order_id is required" if column_value(row, "order_id").nil?
          raise ArgumentError, "checkout_id is required" if column_value(row, "checkout_id").nil?
        end

        def dig_metadata(data, key)
          metadata = data["metadata"]
          metadata.is_a?(Hash) ? metadata[key] : nil
        end

        def parse_json(value)
          return nil if value.nil?
          return value if value.is_a?(Hash) || value.is_a?(Array)

          JSON.parse(value.to_s)
        rescue JSON::ParserError
          nil
        end

        def quote(value)
          connection.quote(value)
        end

        def stringify_keys(value)
          return {} unless value.respond_to?(:each_pair)

          value.each_pair.each_with_object({}) { |(key, item), result| result[key.to_s] = item }
        end
      end
    else
      # ActiveRecord is not available in this environment.
      class ActiveRecordInvoiceStore
        def initialize(*)
          raise NotImplementedError,
                "activerecord not available: add `activerecord` to your Gemfile/bundle to use " \
                "OpenReceive::Server::ActiveRecordInvoiceStore."
        end
      end
    end
  end
end
