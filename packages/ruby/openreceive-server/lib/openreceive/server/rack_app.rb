# frozen_string_literal: true

require "json"
require "openreceive/server/request_handler"

module OpenReceive
  module Server
    class RackApp
      def initialize(service:, authorize:, resolve_checkout_amount:, on_checkout_created:, rate_limit: nil, prefix: "/openreceive")
        @prefix = prefix.to_s.chomp("/")
        @handler = RequestHandler.new(
          service: service,
          authorize: authorize,
          resolve_checkout_amount: resolve_checkout_amount,
          on_checkout_created: on_checkout_created,
          rate_limit: rate_limit,
          prefix: @prefix
        )
      end

      def call(env)
        request_id = env["HTTP_X_REQUEST_ID"] || "req_#{SecureRandom.uuid}"
        path = env["PATH_INFO"].to_s
        return response(@handler.error_response(NotFoundError.new("Route not found."), request_id)) unless path.start_with?(@prefix)
        relative = path.delete_prefix(@prefix).sub(%r{/\z}, "")
        token = RequestHandler.extract_token(env["HTTP_AUTHORIZATION"], env["HTTP_X_OPENRECEIVE_ORDER_TOKEN"], env["HTTP_COOKIE"])
        raw = read_body(env)
        triple = case [env["REQUEST_METHOD"], relative]
                 when ["POST", "/checkouts"] then @handler.create_checkout(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/payments/check"] then @handler.check_payment(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/swaps/quote"] then @handler.quote_swap(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/swaps"] then @handler.create_swap(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/swaps/status"] then @handler.get_swap(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/swaps/refund-confirmations"] then @handler.create_refund_confirmation(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["POST", "/swaps/refunds"] then @handler.refund_swap(raw_body: raw, request: env, token: token, request_id: request_id)
                 when ["GET", "/rates"] then @handler.read_rates(query_string: env["QUERY_STRING"], request: env, token: token, request_id: request_id)
                 else @handler.error_response(NotFoundError.new("Route not found."), request_id)
                 end
        response(triple)
      rescue StandardError => e
        response(@handler.error_response(e, request_id))
      end

      private

      def read_body(env)
        input = env["rack.input"]
        value = input.nil? ? "" : input.read
        input.rewind if input.respond_to?(:rewind)
        value
      end

      def response(triple)
        status, headers, body = triple
        [status, headers, [JSON.generate(body)]]
      end
    end
  end
end
