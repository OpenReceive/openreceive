# frozen_string_literal: true

require "securerandom"
require "openreceive"

module OpenReceive
  module Rails
    module Routes
      module_function

      def draw(router)
        router.post "/v1/invoices", to: "invoices#create"
        router.get "/v1/invoices/:invoice_id", to: "invoices#show"
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
        @store = OpenReceive::InMemoryInvoiceStore.new
        @merchant_scope = "default"
        @production = false
        @allow_unauthenticated_demo = false
      end

      def validate!
        raise ArgumentError, "client is required" if client.nil?
        if production && authenticate.nil? && !allow_unauthenticated_demo
          raise SecurityError, "OpenReceive Rails adapter requires authenticate in production"
        end
        if production && store.is_a?(OpenReceive::InMemoryInvoiceStore)
          raise SecurityError, "OpenReceive Rails adapter requires durable invoice storage in production"
        end
        self
      end
    end

    class ActiveRecordInvoiceStore
      REQUIRED_COLUMNS = %w[
        id
        merchant_scope
        operation
        idempotency_key
        idempotency_request_hash
        payment_hash
        invoice
        amount_msats
        transaction_state
        workflow_state
        settlement_action_state
        created_at_seconds
        expires_at_seconds
        settled_at_seconds
        settlement_action_completed_at_seconds
        refreshed_from_invoice_id
        metadata
        fiat_quote
        created_at
        updated_at
      ].freeze
      REQUIRED_INDEXES = %w[
        idx_openreceive_invoice_idempotency
        index_openreceive_invoices_on_payment_hash
        index_openreceive_invoices_on_invoice
      ].freeze
      TERMINAL_WORKFLOW_STATES = %w[
        settlement_action_completed
        expired_closed
        failed_closed
        cancelled
      ].freeze
      TERMINAL_TRANSACTION_STATES = %w[settled expired failed].freeze

      def initialize(model_class: nil, model_class_name: "OpenReceiveInvoice")
        @model_class = model_class
        @model_class_name = model_class_name
      end

      def check_idempotency(scope:, idempotency_request_hash:)
        data = stringify_keys(scope)
        record = model_class.find_by(
          merchant_scope: data.fetch("merchant_scope"),
          operation: data.fetch("operation"),
          idempotency_key: data.fetch("idempotency_key")
        )
        return nil if record.nil?

        row = row_from_record(record)
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

        record = model_class.create!(attributes_from_row(data))
        { "status" => "created", "row" => row_from_record(record) }
      rescue StandardError => error
        replay = check_idempotency(
          scope: data,
          idempotency_request_hash: data.fetch("idempotency_request_hash")
        )
        return replay unless replay.nil?

        raise OpenReceive::InvoiceStorageConflictError.new("invoice_id, payment_hash, and invoice must be unique") if unique_constraint_error?(error)

        raise
      end

      def find_by_invoice_id(invoice_id)
        record = model_class.find_by(id: invoice_id)
        record.nil? ? nil : row_from_record(record)
      end

      def find_by_payment_hash(payment_hash)
        record = model_class.find_by(payment_hash: payment_hash)
        record.nil? ? nil : row_from_record(record)
      end

      def recoverable_invoices(now:, grace_seconds: 15)
        model_class
          .where.not(workflow_state: TERMINAL_WORKFLOW_STATES)
          .where(
            "(transaction_state = ? AND settlement_action_state <> ?) OR " \
            "(transaction_state NOT IN (?) AND expires_at_seconds + ? >= ?)",
            "settled",
            "completed",
            TERMINAL_TRANSACTION_STATES,
            Integer(grace_seconds),
            Integer(now)
          )
          .order(:created_at_seconds, :id)
          .map { |record| row_from_record(record) }
      end

      def mark_verifying(invoice_id:)
        update_invoice(invoice_id) do |record|
          if read(record, :transaction_state) != "settled" &&
              %w[invoice_created expiry_pending_verification].include?(read(record, :workflow_state))
            record.workflow_state = "verifying"
          end
        end
      end

      def mark_expiry_pending_verification(invoice_id:)
        update_invoice(invoice_id) do |record|
          unless TERMINAL_TRANSACTION_STATES.include?(read(record, :transaction_state))
            record.workflow_state = "expiry_pending_verification"
          end
        end
      end

      def mark_settled(invoice_id:, settled_at:)
        update_invoice(invoice_id) do |record|
          record.transaction_state = "settled"
          record.workflow_state = "settlement_action_pending" unless read(record, :workflow_state) == "settlement_action_completed"
          record.settled_at_seconds ||= Integer(settled_at)
        end
      end

      def mark_expired_closed(invoice_id:)
        update_invoice(invoice_id) do |record|
          if read(record, :transaction_state) != "settled"
            record.transaction_state = "expired"
            record.workflow_state = "expired_closed"
          end
        end
      end

      def mark_failed_closed(invoice_id:)
        update_invoice(invoice_id) do |record|
          if read(record, :transaction_state) != "settled"
            record.transaction_state = "failed"
            record.workflow_state = "failed_closed"
          end
        end
      end

      def mark_settlement_action_completed(invoice_id:, settlement_action_completed_at:)
        update_invoice(invoice_id) do |record|
          record.workflow_state = "settlement_action_completed"
          record.settlement_action_state = "completed"
          record.settlement_action_completed_at_seconds ||= Integer(settlement_action_completed_at)
        end
      end

      def mark_settlement_action_failed(invoice_id:)
        update_invoice(invoice_id) do |record|
          record.workflow_state = "settlement_action_pending"
          record.settlement_action_state = "failed"
        end
      end

      def doctor
        connection = model_class.connection
        table_name = model_class.table_name
        unless connection.data_source_exists?(table_name)
          return [doctor_check("rails.migration", "error", "missing #{table_name}; run bin/rails db:migrate")]
        end

        column_names = connection.columns(table_name).map(&:name)
        index_names = connection.indexes(table_name).map(&:name)
        missing_columns = REQUIRED_COLUMNS - column_names
        missing_indexes = REQUIRED_INDEXES - index_names
        checks = []
        if missing_columns.empty? && missing_indexes.empty?
          checks << doctor_check("rails.migration", "ok", "#{table_name} columns/indexes present")
        else
          missing = []
          missing << "columns: #{missing_columns.join(", ")}" unless missing_columns.empty?
          missing << "indexes: #{missing_indexes.join(", ")}" unless missing_indexes.empty?
          checks << doctor_check("rails.migration", "error", "incomplete #{table_name}; missing #{missing.join("; ")}")
        end
        checks
      rescue StandardError => error
        [doctor_check("rails.migration", "error", error.message)]
      end

      private

      def doctor_check(name, status, message)
        { "name" => name, "status" => status, "message" => message }
      end

      def model_class
        @model_class || Object.const_get(@model_class_name)
      rescue NameError
        raise ArgumentError, "#{@model_class_name} model is not loaded; pass model_class:"
      end

      def update_invoice(invoice_id)
        model_class.transaction do
          record = model_class.lock.find_by(id: invoice_id)
          raise OpenReceive::InvoiceNotFoundError.new(invoice_id) if record.nil?

          yield record
          record.save!
          row_from_record(record)
        end
      end

      def attributes_from_row(row)
        {
          id: row.fetch("invoice_id"),
          merchant_scope: row.fetch("merchant_scope"),
          operation: row.fetch("operation"),
          idempotency_key: row.fetch("idempotency_key"),
          idempotency_request_hash: row.fetch("idempotency_request_hash"),
          payment_hash: row.fetch("payment_hash"),
          invoice: row.fetch("invoice"),
          amount_msats: Integer(row.fetch("amount_msats")),
          transaction_state: row.fetch("transaction_state"),
          workflow_state: row.fetch("workflow_state"),
          settlement_action_state: row.fetch("settlement_action_state"),
          created_at_seconds: Integer(row.fetch("created_at")),
          expires_at_seconds: Integer(row.fetch("expires_at")),
          settled_at_seconds: optional_integer(row["settled_at"]),
          settlement_action_completed_at_seconds: optional_integer(row["settlement_action_completed_at"]),
          refreshed_from_invoice_id: row["refreshed_from_invoice_id"],
          metadata: row["metadata"] || {},
          fiat_quote: row["fiat_quote"]
        }
      end

      def row_from_record(record)
        {
          "invoice_id" => read(record, :id),
          "merchant_scope" => read(record, :merchant_scope),
          "operation" => read(record, :operation),
          "idempotency_key" => read(record, :idempotency_key),
          "idempotency_request_hash" => read(record, :idempotency_request_hash),
          "payment_hash" => read(record, :payment_hash),
          "invoice" => read(record, :invoice),
          "amount_msats" => Integer(read(record, :amount_msats)),
          "transaction_state" => read(record, :transaction_state),
          "workflow_state" => read(record, :workflow_state),
          "settlement_action_state" => read(record, :settlement_action_state),
          "created_at" => Integer(read(record, :created_at_seconds)),
          "expires_at" => Integer(read(record, :expires_at_seconds)),
          "settled_at" => optional_integer(read(record, :settled_at_seconds)),
          "settlement_action_completed_at" => optional_integer(read(record, :settlement_action_completed_at_seconds)),
          "refreshed_from_invoice_id" => read(record, :refreshed_from_invoice_id),
          "metadata" => read(record, :metadata) || {},
          "fiat_quote" => read(record, :fiat_quote)
        }.reject { |_key, value| value.nil? }
      end

      def read(record, attribute)
        return record.public_send(attribute) if record.respond_to?(attribute)
        return record[attribute] if record.respond_to?(:[])

        nil
      end

      def optional_integer(value)
        value.nil? ? nil : Integer(value)
      end

      def unique_constraint_error?(error)
        error.class.name.end_with?("RecordNotUnique")
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
        elsif @config.store.is_a?(OpenReceive::InMemoryInvoiceStore)
          checks << doctor_check("rails.store.durable", "error", "InMemoryInvoiceStore is for tests only; configure OpenReceive::Rails::ActiveRecordInvoiceStore and run bin/rails db:migrate")
        else
          checks << doctor_check("rails.store.durable", "error", "invoice store must expose doctor migration diagnostics")
        end

        checks.concat(client_doctor_checks)
        checks << if @config.store.respond_to?(:recoverable_invoices)
                    doctor_check("rails.worker.poll", "ok", "poll worker can recover invoices from the configured store")
                  else
                    doctor_check("rails.worker.poll", "error", "store does not support recoverable_invoices")
                  end
        checks << if @config.client.respond_to?(:subscribe_to_payment_received)
                    doctor_check("rails.worker.listen", "ok", "client exposes payment_received notifications")
                  else
                    doctor_check("rails.worker.listen", "warn", "client does not expose payment_received notifications; run polling")
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

      def listen_for_payment_notifications
        unless @config.client.respond_to?(:subscribe_to_payment_received)
          raise NotImplementedError, "Configured receive client does not support payment_received notification subscriptions"
        end

        @config.client.subscribe_to_payment_received do |notification|
          handle_payment_received(notification: notification)
        end

        sleep
      end

      def handle_payment_received(notification:)
        data = stringify_keys(notification)
        payment_hash = data["payment_hash"]
        raise ArgumentError, "payment_hash is required" if blank?(payment_hash)

        row = @config.store.find_by_payment_hash(payment_hash)
        raise OpenReceive::InvoiceNotFoundError.new(payment_hash) if row.nil?

        settled = @config.store.mark_settled(
          invoice_id: row.fetch("invoice_id"),
          settled_at: data["settled_at"] || Time.now.to_i
        )
        run_settlement_action_once(settled)
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

      def create_active_record_invoice_store(model_class: nil, model_class_name: "OpenReceiveInvoice")
        ActiveRecordInvoiceStore.new(
          model_class: model_class,
          model_class_name: model_class_name
        )
      end
    end
  end
end
