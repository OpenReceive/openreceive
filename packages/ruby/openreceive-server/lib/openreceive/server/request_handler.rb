# frozen_string_literal: true

require "cgi"
require "json"
require "uri"

module OpenReceive
  module Server
    # Framework-neutral HTTP request handler — the single home of OpenReceive's request -> response
    # logic (routing actions, security tiers/authorize, capability-token extraction, get_checkout_amount
    # usage, and error mapping). It is the Ruby port of the shipped @openreceive/http contract
    # (spec/openapi/openreceive-http.v1.yaml).
    #
    # It takes ALREADY-PARSED inputs (raw body string, request object, token, request_id, query
    # string) and returns a `[status, headers, body]` triple where `body` is a plain Ruby object
    # (Hash) — NOT yet JSON-encoded. Adapters wrap it for their framework:
    #   - Server::RackApp parses `env`, delegates here, and JSON-encodes the body into a Rack triple.
    #   - the openreceive-rails controllers convert the Rails request, delegate here, and render.
    # Because both adapters share this one implementation, the Rack app and the Rails controllers
    # cannot drift — the routing/authorize/error semantics live in exactly one place.
    #
    # The one intentional superset over a bare keyword call: `get_checkout_amount` may be supplied either
    # in the keyword form `->(order_id:, client_amount:, metadata:, request:)` OR in the
    # single-context form `->(ctx) { ctx[:order_id] }` documented in the Rails quickstart. Dispatch
    # is by the callable's parameters. See #call_get_checkout_amount. `get_checkout_amount` is REQUIRED.
    class RequestHandler
      TIER_1_ACTIONS = %w[checkout.create rate.list].freeze
      TIER_2_ACTIONS = %w[order.read checkout.read swap.options swap.quote swap.start swap.refund swap.refresh].freeze
      TIER_3_ACTIONS = %w[invoice.sweep].freeze

      DEFAULT_PREFIX = "/openreceive"
      # How long (seconds) the order-token cookie lives; matched to the JS ORDER_TOKEN_COOKIE_MAX_AGE.
      ORDER_TOKEN_COOKIE_MAX_AGE = 86_400

      # Extract the raw capability token from a request. Preference order mirrors the JS extractToken:
      # `Authorization: Bearer <t>` (scheme case-insensitive) first, then the X-OpenReceive-Order-Token
      # header, then the path-scoped `openreceive_order_token` cookie. A header token always wins over
      # the cookie. Exposed as a class method so every adapter (Rack env, Rails controller) reuses the
      # one definition; `cookie_header` is the raw `Cookie` request header (nil when absent).
      def self.extract_token(authorization, order_token_header, cookie_header = nil)
        if authorization.is_a?(String) && (match = authorization.match(/\ABearer\s+(.+)\z/i))
          return match[1].strip
        end
        return order_token_header if order_token_header.is_a?(String) && !order_token_header.empty?

        cookie_token = cookie_value(cookie_header, Tokens::ORDER_TOKEN_COOKIE_NAME)
        return cookie_token if cookie_token && !cookie_token.empty?

        nil
      end

      # Read a single cookie value by name from a raw `Cookie` header (`name=value; name2=value2`).
      # Byte-for-byte the JS readCookie: split on ";", match the trimmed name before the first "=".
      def self.cookie_value(cookie_header, name)
        return nil unless cookie_header.is_a?(String)

        cookie_header.split(";").each do |part|
          eq = part.index("=")
          next if eq.nil?
          return part[(eq + 1)..].to_s.strip if part[0...eq].strip == name
        end
        nil
      end

      # authorize      : ->(context) { boolean } — context = { action:, request:, resource:, token:, token_valid:, order_id? }
      # get_checkout_amount  : REQUIRED. keyword form ->(order_id:, client_amount:, metadata:, request:) OR
      #                  single-context form ->(ctx) — returns { "amount" => { "sats" } | { "currency", "value" } } or nil (404)
      # rate_limit     : ->(context) { allowed_boolean } — returning false yields 429 (optional)
      # tokens         : Tokens::Manager
      # prefix         : mount prefix used to path-scope the order-token cookie set on create
      def initialize(service:, tokens:, get_checkout_amount:, authorize: nil, rate_limit: nil, prefix: DEFAULT_PREFIX)
        raise ArgumentError,
              "RequestHandler requires a `get_checkout_amount` hook — the create-checkout route " \
              "never trusts a client-supplied price." if get_checkout_amount.nil?

        @service = service
        @tokens = tokens
        @get_checkout_amount = get_checkout_amount
        @rate_limit = rate_limit
        @prefix = normalize_prefix(prefix)
        @authorize = authorize || default_authorize
      end

      # The built-in tier policy, exposed so a host's authorize hook (or the Rails Authorization
      # concern's default) can defer to it (Tier 1 allow, Tier 2 iff a valid per-order token, Tier 3
      # / unknown deny).
      def default_authorize_decision(context)
        default_authorize.call(context)
      end

      # --- route handlers (one per HTTP action) ----------------------------------------------------
      #
      # Every handler accepts an optional `authorize:` override (a callable). The Rails controllers
      # pass `method(:openreceive_authorize)` so a host that uses the Authorization concern gates
      # through its own controller (with current_user etc.); when nil, the handler falls back to the
      # authorize hook / default policy captured at build time — matching the Rack app.

      # POST {prefix}/checkouts — Tier 1. Mints the per-order token on the first checkout.
      def create_checkout(raw_body:, request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          body = parse_json_body(raw_body)
          order_id = optional_string(body["order_id"] || body["orderId"])
          context = build_context("checkout.create", request, { order_id: order_id }, token)
          guard(context, request_id, authorize) do
            create_request = build_create_request(order_id, body, context)
            checkout = @service.get_or_create_checkout(create_request)
            minted_order_id = checkout.fetch("order_id")
            minted = @tokens.mint(minted_order_id)
            response = { "checkout" => checkout }
            extra_headers = {}
            if minted[:created] && minted[:token]
              # First checkout for the order: return the raw token once AND drop it as an httpOnly
              # cookie path-scoped to this order's read route, so a same-origin browser is auto-
              # authorized for its own order with no client-side token handling (mirrors the JS handler).
              response["order_access_token"] = minted[:token]
              extra_headers["Set-Cookie"] = build_order_token_cookie(minted_order_id, minted[:token], request)
            end
            success(201, response, request_id, extra_headers)
          end
        end
      end

      # POST {prefix}/orders/{order_id} — Tier 2 action multiplexer (status | swap.*).
      # Mirrors packages/js/http/src/handler.ts handleOrderAction: call typed service methods
      # directly — there is no parallel `order()` dispatcher on the service.
      def order_action(order_id:, raw_body:, request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          body = parse_json_body(raw_body)
          action = body["action"].nil? ? "status" : body["action"]
          unless %w[status swap_quote start_swap refund_swap refresh_swap].include?(action)
            raise ValidationError,
                  "Unknown order action: #{action.inspect}. " \
                  'Expected "status", "swap_quote", "start_swap", "refund_swap", or "refresh_swap".'
          end

          action_label = order_action_label(action)
          resource = { order_id: order_id }
          if %w[refund_swap refresh_swap].include?(action) && body["attempt_id"].is_a?(String)
            resource[:attempt_id] = body["attempt_id"]
          end
          context = build_context(action_label, request, resource, token)
          guard(context, request_id, authorize) do
            result =
              case action
              when "status"
                order = @service.get_order(order_id: order_id)
                swap = @service.swap_options(order_id: order_id)
                order.merge(
                  "swaps_enabled" => swap.fetch("enabled"),
                  "swap_pay_options" => (swap.fetch("enabled") ? swap.fetch("options") : [])
                )
              when "swap_quote"
                pay_in_asset = required_string(body["pay_in_asset"], "pay_in_asset")
                { "quote" => @service.swap_quote(order_id: order_id, pay_in_asset: pay_in_asset) }
              when "start_swap"
                pay_in_asset = required_string(body["pay_in_asset"], "pay_in_asset")
                { "attempt" => @service.start_swap(order_id: order_id, pay_in_asset: pay_in_asset) }
              when "refresh_swap"
                {
                  "attempt" => @service.refresh_swap(
                    attempt_id: required_string(body["attempt_id"], "attempt_id")
                  )
                }
              else # refund_swap
                {
                  "attempt" => @service.refund_swap(
                    attempt_id: required_string(body["attempt_id"], "attempt_id"),
                    refund_address: required_string(body["refund_address"], "refund_address"),
                    refund_nonce: required_string(body["refund_nonce"], "refund_nonce"),
                    confirm: body["confirm"] == true
                  )
                }
              end
            success(200, result, request_id)
          end
        end
      end

      # GET {prefix}/checkouts/{checkout_id} — Tier 2.
      def read_checkout(checkout_id:, request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          order_id = resolve_checkout_order_id(checkout_id)
          context = build_context("checkout.read", request, { checkout_id: checkout_id, order_id: order_id }, token)
          guard(context, request_id, authorize) do
            checkout = @service.get_checkout(checkout_id: checkout_id)
            success(200, checkout, request_id)
          end
        end
      end

      # GET {prefix}/orders/{order_id}/swap-options — Tier 2.
      def read_swap_options(order_id:, request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          context = build_context("swap.options", request, { order_id: order_id }, token)
          guard(context, request_id, authorize) do
            success(200, @service.swap_options(order_id: order_id), request_id)
          end
        end
      end

      # GET {prefix}/rates — Tier 1 (public).
      def read_rates(query_string:, request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          context = build_context("rate.list", request, {}, token)
          guard(context, request_id, authorize) do
            success(200, @service.list_rates(parse_query(query_string)), request_id)
          end
        end
      end

      # POST {prefix}/admin/sweep — Tier 3, fails closed.
      def admin_sweep(request:, token:, request_id:, authorize: nil)
        handle(request_id) do
          context = build_context("invoice.sweep", request, {}, token)
          guard(context, request_id, authorize) do
            success(200, @service.sweep_pending_invoices, request_id)
          end
        end
      end

      # Map any error to a `[status, headers, body]` triple (error.schema.json body). Public so
      # adapters can reuse the one mapping for concerns that live outside a route handler — e.g. the
      # Rack app's route-not-found (404) and its top-level rescue.
      def error_response(error, request_id)
        status, code, retryable = map_error(error)
        body = { "code" => code, "message" => error.message.to_s }
        body["retryable"] = true if retryable
        body["request_id"] = request_id unless request_id.nil?
        [status, headers_for(request_id), body]
      end

      private

      # --- guard / authorize -----------------------------------------------------------------------

      # Wrap handler work so any raised error maps to an error response. NotImplementedError is a
      # ScriptError, not a StandardError, so it is named explicitly (scaffolded swaps / price feeds).
      def handle(request_id)
        yield
      rescue StandardError, NotImplementedError => e
        error_response(e, request_id)
      end

      def guard(context, request_id, authorize = nil)
        return rate_limited(request_id) if rate_limited?(context)
        unless (authorize || @authorize).call(context)
          return error_response(UnauthorizedError.new("Missing or invalid order access token."), request_id)
        end

        yield
      end

      def rate_limited?(context)
        !@rate_limit.nil? && @rate_limit.call(context) == false
      end

      def default_authorize
        # guest_checkout-style policy sourced from the handler-precomputed context[:token_valid]:
        #   Tier 1 (checkout.create + the public rate.list) allow, Tier 2 iff a valid per-order token
        #   (token_valid), Tier 3 (invoice.sweep) + anything unrecognized fail closed. The policy no
        #   longer touches the token manager — token_valid is computed once in build_context.
        lambda do |context|
          case tier_for(context[:action])
          when 1
            true
          when 2
            context[:token_valid] == true
          else
            false
          end
        end
      end

      def tier_for(action)
        return 1 if TIER_1_ACTIONS.include?(action)
        return 2 if TIER_2_ACTIONS.include?(action)

        3
      end

      def order_action_label(action)
        case action
        when "swap_quote" then "swap.quote"
        when "start_swap" then "swap.start"
        when "refund_swap" then "swap.refund"
        when "refresh_swap" then "swap.refresh"
        else "order.read"
        end
      end

      def resolve_checkout_order_id(checkout_id)
        return nil unless @service.respond_to?(:store) && @service.store.respond_to?(:list_by_checkout_id)

        row = @service.store.list_by_checkout_id(checkout_id).first
        return nil if row.nil?

        Models.stored_order_id(row)
      rescue StandardError
        nil
      end

      # --- create-request assembly -----------------------------------------------------------------

      def build_create_request(order_id, body, context)
        # Client prices are never trusted on this route. amount/sats/usd are rejected so a tampered
        # client cannot quietly underpay; tip-jar / donation hosts honor a payer-chosen amount inside
        # get_checkout_amount (typically via metadata) and return it explicitly.
        reject_client_amount_fields!(body)

        base = { "order_id" => order_id }
        base["memo"] = body["memo"] if body.key?("memo")
        if body.key?("description_hash") || body.key?("descriptionHash")
          base["description_hash"] = body["description_hash"] || body["descriptionHash"]
        end
        base["metadata"] = body["metadata"] if body.key?("metadata")

        resolved =
          begin
            call_get_checkout_amount(
              order_id: order_id,
              client_amount: nil,
              metadata: body["metadata"],
              request: context[:request]
            )
          rescue StandardError => e
            # Host get_checkout_amount throws map to 400 (validation), matching the JS handler.
            raise ValidationError, e.message
          end
        raise NotFoundError, "Order not found." if resolved.nil?

        apply_order_amount(base, resolved)
      end

      # The keyword form calls get_checkout_amount with keyword args (byte-identical to a bare host hook).
      # The single-context form (documented in the Rails quickstart) receives one hash carrying
      # :order_id (and :action) so `ctx[:order_id]` works. Dispatch by the callable's parameters.
      def call_get_checkout_amount(order_id:, client_amount:, metadata:, request:)
        if keyword_hook?(@get_checkout_amount)
          @get_checkout_amount.call(order_id: order_id, client_amount: client_amount, metadata: metadata, request: request)
        else
          @get_checkout_amount.call(
            action: "checkout.create",
            order_id: order_id,
            client_amount: client_amount,
            metadata: metadata,
            request: request
          )
        end
      end

      def keyword_hook?(callable)
        callable.respond_to?(:parameters) &&
          callable.parameters.any? { |type, _name| %i[key keyreq keyrest].include?(type) }
      end

      def apply_order_amount(base, resolved)
        record = stringify_keys(resolved)
        unless record.key?("amount") && record["amount"].is_a?(Hash)
          raise ValidationError,
                "get_checkout_amount must return { amount: { sats } | { currency, value } } (or nil for not found)."
        end

        base["amount"] = record["amount"]
        base
      end

      def reject_client_amount_fields!(body)
        %w[amount sats usd].each do |key|
          next unless body.key?(key)

          raise ValidationError,
                "Create checkout does not accept client-supplied '#{key}'. Provide the price via get_checkout_amount."
        end
      end

      # --- request/response plumbing ---------------------------------------------------------------

      def build_context(action, request, resource, token)
        order_id = resource[:order_id]
        # Precompute per-order token validity once so both rate_limit and authorize (and the presets)
        # see the same context[:token_valid] and never touch the token manager themselves. Mirrors the
        # JS handler's computeTokenValid: false when there is no order id, no token, or it does not verify.
        token_valid = order_id && token ? @tokens.verify(order_id, token) : false
        context = { action: action, request: request, resource: resource, token: token, token_valid: token_valid }
        context[:order_id] = order_id unless order_id.nil?
        context
      end

      def parse_json_body(raw)
        return {} if raw.nil? || raw.empty?

        parsed = JSON.parse(raw)
        raise ValidationError, "Request body must be a JSON object." unless parsed.is_a?(Hash)

        parsed
      rescue JSON::ParserError
        raise ValidationError, "Request body must be valid JSON."
      end

      def parse_query(query_string)
        query = query_string.to_s
        return {} if query.empty?

        pairs =
          begin
            URI.decode_www_form(query)
          rescue ArgumentError
            []
          end
        params = {}
        pairs.each { |key, value| params[key] = value }

        result = {}
        result["currencies"] = params["currencies"] if params.key?("currencies")
        result["base"] = params["base"] if params.key?("base")
        result
      end

      def success(status, body, request_id, extra_headers = {})
        headers = headers_for(request_id)
        headers.merge!(extra_headers) unless extra_headers.empty?
        [status, headers, body]
      end

      # Build the Set-Cookie value for the minted order token: httpOnly + SameSite=Lax, path-scoped to
      # `{prefix}/orders/{order_id}` so the browser only sends it to that order's read route, and Secure
      # only over https (so localhost http dev keeps working). Byte-identical to the JS
      # buildOrderTokenCookie in @openreceive/http.
      def build_order_token_cookie(order_id, token, request)
        path = "#{@prefix}/orders/#{CGI.escape(order_id.to_s)}"
        cookie = "#{Tokens::ORDER_TOKEN_COOKIE_NAME}=#{token}; Path=#{path}; HttpOnly; SameSite=Lax; " \
                 "Max-Age=#{ORDER_TOKEN_COOKIE_MAX_AGE}"
        cookie += "; Secure" if request_https?(request)
        cookie
      end

      # True when the request arrived over https, directly (`rack.url_scheme == "https"`) or via an
      # `x-forwarded-proto: https` proxy. Framework-neutral: reads a Rack env Hash or any request object
      # responding to `get_header` (e.g. an ActionDispatch::Request).
      def request_https?(request)
        request_env_value(request, "rack.url_scheme") == "https" ||
          request_env_value(request, "HTTP_X_FORWARDED_PROTO") == "https"
      end

      def request_env_value(request, key)
        if request.is_a?(Hash)
          request[key]
        elsif request.respond_to?(:get_header)
          request.get_header(key)
        end
      end

      def rate_limited(request_id)
        body = { "code" => "RATE_LIMITED", "message" => "Too many requests.", "retryable" => true }
        body["request_id"] = request_id unless request_id.nil?
        [429, headers_for(request_id), body]
      end

      def map_error(error)
        if error.respond_to?(:status) && error.respond_to?(:code) && error.status && error.code
          [error.status, error.code, [429, 503].include?(error.status)]
        elsif error.is_a?(NotImplementedError)
          [500, "NOT_IMPLEMENTED", false]
        elsif error.is_a?(ArgumentError)
          [400, "INVALID_REQUEST", false]
        else
          [500, "INTERNAL", false]
        end
      end

      def headers_for(request_id)
        headers = { "Content-Type" => "application/json" }
        headers["X-Request-Id"] = request_id unless request_id.nil?
        headers
      end

      def required_string(value, field)
        text = optional_string(value)
        raise ValidationError, "#{field} is required." if text.nil?

        text
      end

      def optional_string(value)
        value.is_a?(String) && !value.empty? ? value : nil
      end

      # Normalize the mount prefix the cookie path is scoped to (leading slash, no trailing slash),
      # matching Server::RackApp#normalize_prefix so both adapters produce the same cookie Path.
      def normalize_prefix(prefix)
        value = prefix.to_s
        value = "/#{value}" unless value.start_with?("/")
        value = value.chomp("/")
        value.empty? ? "" : value
      end

      def stringify_keys(value)
        return {} unless value.respond_to?(:each_pair)

        value.each_pair.each_with_object({}) { |(key, item), result| result[key.to_s] = item }
      end
    end
  end
end
