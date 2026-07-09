# frozen_string_literal: true

require "json"
require "openreceive/server/request_handler"

module OpenReceive
  module Server
    # Framework-agnostic HTTP routes — the Ruby port of the shipped @openreceive/http contract
    # (spec/openapi/openreceive-http.v1.yaml). Implemented against the bare Rack `call(env)`
    # contract; it does NOT require the `rack` gem so it can run in any Rack-compatible host.
    #
    # RackApp is a THIN Rack adapter: it parses `env` into (method, path, query, headers, raw body,
    # token), routes to the matching Server::RequestHandler method, and converts the returned
    # `[status, headers, body]` triple into a Rack response. ALL request -> response logic (tiers,
    # authorize, token extraction, get_order_amount, error mapping) lives in Server::RequestHandler,
    # which the openreceive-rails controllers also delegate to — so the two adapters cannot drift.
    #
    # Routes (mounted under `prefix`, default /openreceive):
    #   POST {prefix}/checkouts                    Tier 1  action=checkout.create
    #   POST {prefix}/orders/{order_id}            Tier 2  action=order.read | swap.*
    #   GET  {prefix}/checkouts/{checkout_id}      Tier 2  action=checkout.read
    #   GET  {prefix}/orders/{order_id}/swap-options Tier 2 action=swap.options
    #   GET  {prefix}/rates                        Tier 1  action=rate.list (public)
    #   POST {prefix}/admin/sweep                  Tier 3  action=invoice.sweep (FAILS CLOSED)
    #
    # Security tiers (default authorize):
    #   Tier 1 → allow. Tier 2 → allow iff a valid per-order capability token is presented.
    #   Tier 3 → DENY (host must supply an authorize hook that opts in).
    #
    # The host supplies `authorize` and `get_order_amount`. The create route uses get_order_amount to
    # compute the authoritative amount and NEVER trusts the client-supplied amount when it is set.
    class RackApp
      DEFAULT_PREFIX = "/openreceive"

      # authorize      : ->(context) { boolean }  — context = { action:, request: env, resource:, token:, token_valid: }
      # get_order_amount : ->(context) { amount_source } — { "amount" => ... } | { "sats" => ... } | { "usd" => ... }
      # rate_limit     : ->(context) { allowed_boolean } — returning false yields 429 (optional)
      # tokens         : Tokens::Manager
      def initialize(service:, tokens:, authorize: nil, get_order_amount: nil, rate_limit: nil, prefix: DEFAULT_PREFIX)
        @prefix = normalize_prefix(prefix)
        @handler = RequestHandler.new(
          service: service,
          tokens: tokens,
          authorize: authorize,
          get_order_amount: get_order_amount,
          rate_limit: rate_limit,
          prefix: @prefix
        )
      end

      def call(env)
        request_id = env["HTTP_X_REQUEST_ID"]
        route = strip_prefix(env["PATH_INFO"].to_s)
        return not_found(request_id) if route.nil?

        dispatch(env["REQUEST_METHOD"], segments(route), env, request_id)
      rescue StandardError, NotImplementedError => e
        # NotImplementedError (scaffolded swaps / live price feeds) is a ScriptError, not a
        # StandardError, so it must be named explicitly to be mapped instead of crashing the host.
        rack_response(@handler.error_response(e, request_id))
      end

      private

      # Route method + path segments to the matching handler call, then wrap the triple for Rack.
      def dispatch(method, parts, env, request_id)
        if method == "POST" && parts == %w[checkouts]
          rack_response(@handler.create_checkout(
            raw_body: raw_body(env), request: env, token: token_from(env), request_id: request_id
          ))
        elsif method == "POST" && parts.length == 2 && parts[0] == "orders"
          rack_response(@handler.order_action(
            order_id: parts[1], raw_body: raw_body(env), request: env, token: token_from(env), request_id: request_id
          ))
        elsif method == "GET" && parts.length == 2 && parts[0] == "checkouts"
          rack_response(@handler.read_checkout(
            checkout_id: parts[1], request: env, token: token_from(env), request_id: request_id
          ))
        elsif method == "GET" && parts.length == 3 && parts[0] == "orders" && parts[2] == "swap-options"
          rack_response(@handler.read_swap_options(
            order_id: parts[1], request: env, token: token_from(env), request_id: request_id
          ))
        elsif method == "GET" && parts == %w[rates]
          rack_response(@handler.read_rates(
            query_string: env["QUERY_STRING"], request: env, token: token_from(env), request_id: request_id
          ))
        elsif method == "POST" && parts == %w[admin sweep]
          rack_response(@handler.admin_sweep(request: env, token: token_from(env), request_id: request_id))
        else
          not_found(request_id)
        end
      end

      # --- env parsing (Rack concern) --------------------------------------------------------------

      def token_from(env)
        RequestHandler.extract_token(
          env["HTTP_AUTHORIZATION"], env["HTTP_X_OPENRECEIVE_ORDER_TOKEN"], env["HTTP_COOKIE"]
        )
      end

      def raw_body(env)
        input = env["rack.input"]
        raw = input.nil? ? "" : input.read
        input.rewind if input.respond_to?(:rewind)
        raw
      end

      def normalize_prefix(prefix)
        value = prefix.to_s
        value = "/#{value}" unless value.start_with?("/")
        value = value.chomp("/")
        value.empty? ? "" : value
      end

      def strip_prefix(path)
        return path if @prefix.empty?
        return "" if path == @prefix
        return path[@prefix.length..] if path.start_with?("#{@prefix}/")

        nil
      end

      def segments(route)
        route.split("/").reject(&:empty?)
      end

      # --- Rack response plumbing ------------------------------------------------------------------

      # Convert the handler's [status, headers, body-object] triple into a Rack triple by JSON-encoding
      # the body into the single-element body array Rack expects.
      def rack_response(triple)
        status, headers, body = triple
        [status, headers, [JSON.generate(body)]]
      end

      def not_found(request_id)
        rack_response(@handler.error_response(NotFoundError.new("Route not found."), request_id))
      end
    end
  end
end
