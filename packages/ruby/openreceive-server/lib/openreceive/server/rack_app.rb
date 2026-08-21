# frozen_string_literal: true

require "json"
require "openreceive/server/client_ip"
require "openreceive/server/request_handler"

module OpenReceive
  module Server
    class RackApp
      # Route paths (method-independent), used to answer a known path called
      # with the wrong method with 405 instead of 404 — mirrors the JS router.
      KNOWN_PATHS = [
        "/checkouts/prepare", "/checkouts", "/payments/check", "/swaps/quote",
        "/swaps", "/swaps/status", "/swaps/refunds", "/rates"
      ].freeze

      def initialize(service:, authorize:, resolve_checkout:, on_checkout_created:, on_paid:,
                     rate_limit: nil, client_ip: nil, prefix: "/openreceive")
        @prefix = prefix.to_s.chomp("/")
        raw_client_ip = client_ip || ->(request) { request.is_a?(Hash) ? request["REMOTE_ADDR"] : nil }
        @handler = RequestHandler.new(
          service: service,
          authorize: authorize,
          resolve_checkout: resolve_checkout,
          on_checkout_created: on_checkout_created,
          on_paid: on_paid,
          rate_limit: rate_limit,
          # Stamped IPs are normalized into the same bucket the limiter counts
          # with (IPv6 /64, v4-mapped collapsed) — mirrors the JS handler.
          client_ip: ->(request) { ClientIp.attributed(raw_client_ip.call(request)) }
        )
      end

      def call(env)
        # Always server-generated (matches JS): a client-supplied X-Request-Id
        # is unvalidated content and must not be reflected into headers/logs.
        request_id = "req_#{SecureRandom.uuid}"
        path = env["PATH_INFO"].to_s
        return response(@handler.error_response(NotFoundError.new("No OpenReceive route matched this method and path."), request_id)) unless path.start_with?(@prefix)
        relative = path.delete_prefix(@prefix).sub(%r{/\z}, "")
        # The body is read only after a route matches (an unknown path stays a
        # 404 no matter how large the body is), mirroring the JS dispatch order.
        triple = case [env["REQUEST_METHOD"], relative]
                 when ["POST", "/checkouts/prepare"] then @handler.prepare_checkout(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/checkouts"] then @handler.create_checkout(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/payments/check"] then @handler.check_payment(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/swaps/quote"] then @handler.quote_swap(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/swaps"] then @handler.create_swap(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/swaps/status"] then @handler.get_swap(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["POST", "/swaps/refunds"] then @handler.refund_swap(raw_body: read_body(env), request: env, request_id: request_id)
                 when ["GET", "/rates"] then @handler.read_rates(query_string: env["QUERY_STRING"], request: env, request_id: request_id)
                 else @handler.error_response(unmatched_route_error(relative), request_id)
                 end
        response(triple)
      rescue StandardError => e
        response(@handler.error_response(e, request_id))
      end

      private

      # 405 INVALID_REQUEST for a known path with the wrong method, 404
      # NOT_FOUND otherwise — status, code, and messages match the JS router
      # (which sets no Allow header).
      def unmatched_route_error(relative)
        if KNOWN_PATHS.include?(relative)
          MethodNotAllowedError.new
        else
          NotFoundError.new("No OpenReceive route matched this method and path.")
        end
      end

      # Pre-auth body cap, mirroring the JS readJsonBody: an over-declared
      # Content-Length is rejected before any read, and the read itself stops
      # one byte past the cap — an unauthenticated payer can never stream an
      # unbounded (chunked) body into memory.
      def read_body(env)
        input = env["rack.input"]
        return "" if input.nil?
        raise PayloadTooLargeError if env["CONTENT_LENGTH"].to_i > RequestHandler::MAX_BODY_BYTES
        value = input.read(RequestHandler::MAX_BODY_BYTES + 1) || ""
        input.rewind if input.respond_to?(:rewind)
        raise PayloadTooLargeError if value.bytesize > RequestHandler::MAX_BODY_BYTES
        value
      end

      def response(triple)
        status, headers, body = triple
        [status, headers, [JSON.generate(body)]]
      end
    end
  end
end
