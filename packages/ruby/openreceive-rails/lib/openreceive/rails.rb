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
        self
      end
    end

    class Adapter
      CREATE_OPERATION = "invoice.create"

      def initialize(config = Configuration.new)
        @config = config
        @config.validate!
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

        verify_stored_invoice(row)
      end

      private

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
    end
  end
end
