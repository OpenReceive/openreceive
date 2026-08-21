# frozen_string_literal: true

require "json"
require "securerandom"
require "uri"

module OpenReceive
  module Server
    class RequestHandler
      # Spec-declared caps, mirroring the OpenAPI request schemas and the JS
      # handler exactly (the second settlement engine must not drift).
      MAX_ORDER_ID_LENGTH = 200
      MAX_MEMO_LENGTH = 500
      MAX_BODY_BYTES = 64 * 1024
      # Declared fields per route (additionalProperties: false, snake_case
      # only — camelCase aliases are rejected, matching JS).
      ROUTE_BODY_FIELDS = {
        "checkout.prepare" => %w[order_id],
        "checkout.create" => %w[order_id memo metadata],
        "payment.check" => %w[order_id payment_hash],
        "swap.quote" => %w[order_id pay_in_asset],
        "swap.create" => %w[order_id pay_in_asset memo metadata],
        "swap.read" => %w[order_id payment_hash],
        "swap.refund" => %w[order_id payment_hash refund_address]
      }.freeze

      # `client_ip` (a proc receiving the framework request) attributes payer
      # IPs for rate limiting and for stamping committed attempt rows; when it
      # returns nil the limiter fails open for that request.
      def initialize(service:, authorize:, resolve_checkout:, on_checkout_created:, on_paid:,
                     rate_limit: nil, client_ip: nil)
        raise ArgumentError, "authorize is required" if authorize.nil?
        raise ArgumentError, "resolve_checkout is required" if resolve_checkout.nil?
        raise ArgumentError, "on_checkout_created is required" if on_checkout_created.nil?
        raise ArgumentError, "on_paid is required" if on_paid.nil?
        @service = service
        @authorize = authorize
        @resolve_checkout = resolve_checkout
        @on_checkout_created = on_checkout_created
        @on_paid = on_paid
        @rate_limit = rate_limit
        @client_ip = client_ip
      end

      def prepare_checkout(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body, "checkout.prepare")
          order_id = required_order_id(body)
          reject_payer_amount(body)
          guard("checkout.prepare", request, { order_id: order_id })
          resolved = resolve_host("checkout.prepare", request, order_id, body)
          prepared = @service.prepare_checkout("amount" => required_amount(resolved))
          success(200, prepared.merge("order_id" => order_id), request_id)
        end
      end

      def create_checkout(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body, "checkout.create")
          order_id = required_order_id(body)
          reject_payer_amount(body)
          authorize!("checkout.create", request, { order_id: order_id })
          resolved = resolve_host("checkout.create", request, order_id, body)
          # Rate limits meter minting only: re-serving an already-committed
          # attempt costs no wallet call, so a capped payer can still re-fetch
          # instructions they were already given (mirrors JS).
          enforce_rate_limit!("checkout.create", request, { order_id: order_id }) unless resolved["payment_hash"]
          checkout = if resolved["payment_hash"]
                       committed_checkout(order_id, resolved)
                     else
                       @service.create_checkout(
                         "order_id" => order_id, "amount" => required_amount(resolved),
                         "memo" => validated_memo(body), "metadata" => body["metadata"]
                       )
                     end
          commit(checkout, nil, request) unless resolved["payment_hash"]
          success(201, { "checkout" => checkout }, request_id)
        end
      end

      # Storage-aware callers (the Rails engine) pass `reconcile_pass` — the
      # request-level gated reconcile result ({ "reason" => "ran", "checks" }
      # or a skip reason) — plus `attempt_status`, a proc mapping a payment
      # hash to its persisted { "status", "paid_at"? }. The requested hash is
      # then served from the pass (winner) or the host row (gate_busy / outside
      # the pending set / disabled) with `details` omitted — never a second
      # per-invoice wallet walk and never a second gate claim. Row `attention`
      # serves as `pending` on the wire (operator state, not payer
      # information); the row path never emits `not_found`. Storage-agnostic
      # callers (Server::RackApp) omit both and keep the direct per-invoice
      # wallet check.
      def check_payment(raw_body:, request:, request_id:, reconcile_pass: nil, attempt_status: nil)
        handle(request_id) do
          body = parse(raw_body, "payment.check")
          order_id = required_order_id(body)
          # Payer input is shape-validated BEFORE any host hook runs (mirrors
          # JS): guard/resolve never see an un-vetted selector.
          requested_hash = required_payment_hash(body["payment_hash"])
          guard("payment.check", request, { order_id: order_id, payment_hash: requested_hash })
          resolved = resolve_host("payment.check", request, order_id, body)
          hash = selected_payment_hash(resolved, requested_hash)
          checkout = committed_checkout(order_id, resolved)
          public_checked =
            if reconcile_pass.nil?
              checked_via_wallet(hash, checkout)
            else
              checked_from_pass(hash, reconcile_pass, attempt_status)
            end
          # Catalog warms on the first check; clients keep "Loading currencies…"
          # until payment_methods is present (even as an empty Lightning-only
          # list). Amount-aware, like the JS handler: limits are evaluated
          # against this attempt's committed invoice amount.
          payment_methods = @service.list_swap_options(amount_msats: checkout["amount_msats"])
          success(200, public_checked.merge("payment_methods" => payment_methods), request_id)
        end
      end

      def quote_swap(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body, "swap.quote")
          order_id = required_order_id(body)
          reject_payer_amount(body)
          asset = required(body["pay_in_asset"], "pay_in_asset")
          guard("swap.quote", request, { order_id: order_id })
          resolved = resolve_host("swap.quote", request, order_id, body, asset)
          success(200, @service.quote_swap("amount" => required_amount(resolved), "pay_in_asset" => asset), request_id)
        end
      end

      def create_swap(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body, "swap.create")
          order_id = required_order_id(body)
          reject_payer_amount(body)
          asset = required(body["pay_in_asset"], "pay_in_asset")
          authorize!("swap.create", request, { order_id: order_id })
          resolved = resolve_host("swap.create", request, order_id, body, asset)
          enforce_rate_limit!("swap.create", request, { order_id: order_id }) unless resolved["payment_hash"]
          swap = if resolved["payment_hash"]
                   data = required_swap_data(resolved["swap_data"])
                   status = @service.get_swap(
                     order_id: order_id, payment_hash: resolved["payment_hash"], swap_data: data
                   )
                   status.merge(
                     "checkout" => committed_checkout(order_id, resolved),
                     "swap_data" => data
                   )
                 else
                   # Explicit, validated fields only: the raw payer body must
                   # never reach the service (an "expirySeconds" key would beat
                   # the provider-mandated shadow-invoice expiry, and duplicate
                   # order keys would split authorization from minting).
                   @service.create_swap(
                     "order_id" => order_id,
                     "amount" => required_amount(resolved),
                     "pay_in_asset" => asset,
                     "memo" => validated_memo(body),
                     "metadata" => body["metadata"]
                   )
                 end
          commit(swap.fetch("checkout"), swap["swap_data"], request) unless resolved["payment_hash"]
          success(201, { "swap" => public_swap(swap) }, request_id)
        end
      end

      def get_swap(raw_body:, request:, request_id:)
        swap_action("swap.read", raw_body, request, request_id) do |order_id, hash, data, _body|
          @service.get_swap(order_id: order_id, payment_hash: hash, swap_data: data)
        end
      end

      def refund_swap(raw_body:, request:, request_id:)
        swap_action("swap.refund", raw_body, request, request_id) do |order_id, hash, data, body|
          @service.refund_swap(
            order_id: order_id,
            payment_hash: hash,
            swap_data: data,
            refund_address: required(body["refund_address"], "refund_address")
          )
        end
      end

      def read_rates(query_string:, request:, request_id:)
        handle(request_id) do
          pairs = begin
            URI.decode_www_form(query_string.to_s)
          rescue ArgumentError
            []
          end
          raw = pairs.filter_map { |key, value| value if key == "currencies" }.first
          currencies = raw&.split(",")&.map(&:strip)&.reject(&:empty?)
          success(200, @service.list_rates(currencies.nil? ? {} : { "currencies" => currencies }), request_id)
        end
      end

      def error_response(error, request_id)
        status = error.respond_to?(:status) ? error.status : 500
        code = error.respond_to?(:code) ? error.code : "INTERNAL"
        # Unexpected exceptions are redacted; a deliberate 500 (an error class
        # carrying its own code, e.g. InternalHostError) keeps its payer-safe
        # message on the wire, exactly like the JS OpenReceiveHttpError path.
        message = status == 500 && !error.respond_to?(:code) ? "Internal server error." : error.message
        body = { "code" => code, "message" => message, "request_id" => request_id }
        body["retryable"] = error.retryable if error.respond_to?(:retryable) && !error.retryable.nil?
        body["details"] = error.details if error.respond_to?(:details) && error.details.is_a?(Hash)
        response_headers = headers(request_id)
        # Mirrors the JS handler: a Retry-After hint (whole seconds, minimum 1)
        # rides along with retryable throttling errors.
        if error.respond_to?(:retry_after_seconds) && !error.retry_after_seconds.nil?
          response_headers = response_headers.merge(
            "retry-after" => [1, error.retry_after_seconds.ceil].max.to_s
          )
        end
        [status, response_headers, body.compact]
      end

      private

      # Legacy status refresh (no request-level pass supplied): one direct
      # per-invoice wallet check, delivering settlement inline.
      def checked_via_wallet(hash, checkout)
        checked = @service.check_payment(
          "payment_hash" => hash,
          "created_at" => checkout.fetch("created_at")
        )
        if checked["status"] == "settled" && checked["paid_at"]
          @on_paid.call(
            "payment_hash" => checked.fetch("payment_hash"),
            "paid_at" => checked.fetch("paid_at"),
            "details" => checked["details"]
          )
        end
        details = checked["details"]
        public_checked = checked.reject { |key, _| key == "details" }
        public_checked["details"] = public_payment_details(details) unless details.nil?
        public_checked
      end

      # Status refresh from the request-level gated pass. The winner serves the
      # requested hash straight from the pass results (settlement was already
      # delivered inside the pass); every other outcome serves the persisted
      # row via attempt_status with `details` omitted — `details` stays
      # contract-optional and no wallet snapshot is persisted just to make the
      # two paths uniform.
      def checked_from_pass(hash, reconcile_pass, attempt_status)
        if reconcile_pass["reason"] == "ran"
          checked = Array(reconcile_pass["checks"]).find do |check|
            check["payment_hash"].to_s.downcase == hash.to_s.downcase
          end
          # A `not_found` pass result falls through to the row. A wallet that
          # ignores `unpaid: true` omits a live invoice from the scan, and
          # serving not_found here would flap a pending attempt between
          # gate-winning and gate-busy requests.
          unless checked.nil? || checked["status"].to_s == "not_found"
            details = checked["details"]
            public_checked = checked.reject { |key, _| key == "details" }
            public_checked["details"] = public_payment_details(details) unless details.nil?
            return public_checked
          end
        end
        row = attempt_status&.call(hash)
        # resolve_host selected this hash from the same repository moments ago.
        raise NotFoundError, "Payment attempt not found for this order." if row.nil?

        # Row `attention` serves as `pending` on the wire (operator state, not
        # payer information); the row path never emits `not_found`.
        status = row["status"].to_s == "attention" ? "pending" : row["status"].to_s
        public_checked = { "payment_hash" => hash.to_s.downcase, "status" => status }
        public_checked["paid_at"] = Integer(row["paid_at"]) if row["paid_at"]
        public_checked
      end

      def swap_action(action, raw_body, request, request_id)
        handle(request_id) do
          body = parse(raw_body, action)
          order_id = required_order_id(body)
          # Shape-validated before guard/resolve, matching JS: host hooks
          # never receive an un-vetted payer selector.
          requested_hash = required_payment_hash(body["payment_hash"])
          guard(action, request, { order_id: order_id, payment_hash: requested_hash })
          resolved = resolve_host(action, request, order_id, body)
          hash = selected_payment_hash(resolved, requested_hash)
          success(200, yield(order_id, hash, required_swap_data(resolved["swap_data"]), body), request_id)
        end
      end

      def resolve_host(action, request, order_id, body, pay_in_asset = nil)
        args = { action: action, request: request, order_id: order_id, input: body }
        args[:pay_in_asset] = pay_in_asset unless pay_in_asset.nil?
        resolved_host_checkout(@resolve_checkout.call(**args))
      end

      def guard(action, request, resource)
        enforce_rate_limit!(action, request, resource)
        authorize!(action, request, resource)
      end

      # Create actions call these separately: authorize first, then the rate
      # limit only once the host has resolved that a new attempt must be
      # minted (reuse is exempt) — the same split as the JS handler.
      def enforce_rate_limit!(action, request, resource)
        return if @rate_limit.nil?
        context = { action: action, request: request, resource: resource }
        raise RateLimitedError unless @rate_limit.call(context)
      end

      def authorize!(action, request, resource)
        context = { action: action, request: request, resource: resource }
        raise UnauthorizedError, "Not authorized for this action." unless @authorize.call(context)
      end

      def commit(checkout, swap_data = nil, request = nil)
        client_ip = @client_ip&.call(request)
        @on_checkout_created.call(
          order_id: checkout.fetch("order_id"),
          payment_hash: checkout.fetch("payment_hash"),
          checkout: checkout,
          swap_data: swap_data,
          client_ip: client_ip
        )
      rescue StandardError => e
        # Meaningful repository refusals ("already paid", "live attempt for
        # the same method") carry their own status/code and pass through
        # untouched. Anything else is infrastructure failing to persist
        # (database down, bug): retryable 503, never a payer-blaming conflict
        # — mirrors the JS handler's commit().
        raise e if e.respond_to?(:status) && e.respond_to?(:code)
        raise HostPersistenceError
      end

      def public_swap(swap)
        swap.reject { |key, _| key == "swap_data" }
      end

      # Payer-facing subset of a settlement's wallet details, whitelisted
      # field-for-field from the JS handler's publicPaymentDetails: the raw
      # wallet transaction carries the preimage, full invoice, and wallet
      # metadata — none of which belong in a browser-polled response.
      # The keys a normalized NwcTransaction actually carries. `state`,
      # `amount` and `fees_paid` were never on it (they normalize to
      # transaction_state / amount_msats / fees_paid_msats), so whitelisting
      # them silently omitted the very fields this list exists to expose.
      # Never widen this to preimage or invoice: those stay server-side.
      PUBLIC_TRANSACTION_FIELDS = %w[
        payment_hash transaction_state amount_msats fees_paid_msats
        created_at settled_at expires_at
      ].freeze

      def public_payment_details(details)
        data = details.respond_to?(:each_pair) ? details.each_pair.to_h { |key, value| [key.to_s, value] } : {}
        result = {}
        transaction = data["transaction"]
        if transaction.respond_to?(:each_pair)
          rows = transaction.each_pair.to_h { |key, value| [key.to_s, value] }
          result["transaction"] = PUBLIC_TRANSACTION_FIELDS.each_with_object({}) do |field, picked|
            picked[field] = rows[field] unless rows[field].nil?
          end
        end
        result["observed_at"] = data["observed_at"]
        result["paid_at_source"] = data["paid_at_source"] unless data["paid_at_source"].nil?
        result
      end

      def handle(request_id)
        yield
      rescue StandardError, NotImplementedError => e
        error_response(e, request_id)
      end

      def parse(raw, route = nil)
        text = raw.to_s
        raise PayloadTooLargeError if text.bytesize > MAX_BODY_BYTES
        value = text.strip.empty? ? {} : JSON.parse(text)
        raise ValidationError, "Request body must be a JSON object." unless value.is_a?(Hash)
        assert_declared_fields!(value, route)
        value
      rescue JSON::ParserError
        raise ValidationError, "Request body must be a JSON object."
      end

      def assert_declared_fields!(body, route)
        allowed = ROUTE_BODY_FIELDS[route]
        return if allowed.nil?
        # A payer-supplied amount is the one undeclared field worth naming: the
        # generic "unexpected field" message reads like a typo when the caller
        # is actually reaching for the price authority.
        reject_payer_amount(body)
        body.each_key do |key|
          unless allowed.include?(key)
            raise ValidationError, "Unexpected request field for this route: #{key}."
          end
        end
      end

      def required(value, field)
        text = value.to_s.strip
        raise ValidationError, "#{field} is required." if text.empty?
        text
      end

      def required_order_id(body)
        order_id = required(body["order_id"], "order_id")
        if order_id.length > MAX_ORDER_ID_LENGTH
          raise ValidationError, "order_id must be #{MAX_ORDER_ID_LENGTH} characters or fewer."
        end
        order_id
      end

      def validated_memo(body)
        memo = body["memo"]
        if memo.is_a?(String) && memo.length > MAX_MEMO_LENGTH
          raise ValidationError, "memo must be #{MAX_MEMO_LENGTH} characters or fewer."
        end
        memo
      end

      def required_amount(resolved)
        amount = resolved["amount"]
        if amount.nil?
          # A host order without an amount is a host-integration bug, not a
          # payer mistake: 500 INTERNAL with the JS handler's exact message.
          raise InternalHostError, "The host resolved this order without an amount."
        end
        amount
      end

      def required_payment_hash(value)
        hash = required(value, "payment_hash").downcase
        unless /\A[0-9a-f]{64}\z/.match?(hash)
          raise ValidationError, "payment_hash must be 64 hexadecimal characters."
        end
        hash
      end

      def required_swap_data(value)
        raise NotFoundError, "The host order has no swap data." if value.nil?
        unless value.is_a?(Hash)
          raise ValidationError, "The host order's swap data is not a valid swap_data object."
        end
        value
      end

      def selected_payment_hash(resolved, requested_hash)
        selected = required_payment_hash(resolved["payment_hash"])
        return selected if selected == requested_hash

        raise NotFoundError, "The selected payment attempt does not belong to this order."
      end

      def reject_payer_amount(body)
        return unless body.key?("amount") || body.key?("amount_msats")
        raise ValidationError, "This route does not accept a payer-supplied amount; the host resolves its order price."
      end

      def resolved_host_checkout(value)
        data = value.respond_to?(:each_pair) ? value.each_pair.to_h { |key, item| [key.to_s, item] } : {}
        data
      end

      def committed_checkout(order_id, resolved)
        checkout = resolved["checkout"]
        unless checkout.is_a?(Hash)
          raise ConflictError, "The host payment attempt has no checkout snapshot."
        end

        data = checkout.each_pair.to_h { |key, value| [key.to_s, value] }
        hash = required(data["payment_hash"] || data["paymentHash"], "payment_hash").downcase
        selected = required(resolved["payment_hash"], "payment_hash").downcase
        checkout_order = required(data["order_id"] || data["orderId"], "order_id")
        if hash != selected || checkout_order != order_id
          raise ConflictError, "The selected payment attempt is not a reusable pending checkout."
        end
        data
      rescue ArgumentError, TypeError
        raise ConflictError, "The selected payment attempt is not a reusable pending checkout."
      end

      def success(status, body, request_id)
        [status, headers(request_id), body]
      end

      def headers(request_id)
        # Lowercase keys: the Rack 3 SPEC requires them; Rails normalizes.
        { "content-type" => "application/json; charset=utf-8", "x-request-id" => request_id }.compact
      end
    end
  end
end
