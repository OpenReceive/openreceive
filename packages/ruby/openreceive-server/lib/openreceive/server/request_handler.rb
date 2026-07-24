# frozen_string_literal: true

require "json"
require "securerandom"

module OpenReceive
  module Server
    class RequestHandler
      def initialize(service:, authorize:, resolve_checkout:, on_checkout_created:, on_paid:, rate_limit: nil, prefix: "/openreceive")
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
        @prefix = prefix
      end

      def create_checkout(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          reject_payer_amount(body)
          guard("checkout.create", request, { order_id: order_id })
          resolved = resolve_host("checkout.create", request, order_id, body)
          checkout = if resolved["payment_hash"]
                       committed_checkout(order_id, resolved)
                     else
                       @service.create_checkout(
                         "order_id" => order_id, "amount" => required_amount(resolved),
                         "memo" => body["memo"], "description_hash" => body["description_hash"],
                         "metadata" => body["metadata"]
                       )
                     end
          commit(checkout) unless resolved["payment_hash"]
          success(201, { "checkout" => checkout }, request_id)
        end
      end

      def check_payment(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          requested_hash = required(body["payment_hash"] || body["paymentHash"], "payment_hash").downcase
          guard("payment.check", request, { order_id: order_id, payment_hash: requested_hash })
          resolved = resolve_host("payment.check", request, order_id, body)
          hash = selected_payment_hash(resolved, requested_hash)
          checkout = committed_checkout(order_id, resolved)
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
          success(200, checked, request_id)
        end
      end

      def quote_swap(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          reject_payer_amount(body)
          asset = required(body["pay_in_asset"] || body["payInAsset"], "pay_in_asset")
          guard("swap.quote", request, { order_id: order_id })
          resolved = resolve_host("swap.quote", request, order_id, body, asset)
          success(200, @service.quote_swap("amount" => required_amount(resolved), "pay_in_asset" => asset), request_id)
        end
      end

      def create_swap(raw_body:, request:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          reject_payer_amount(body)
          asset = required(body["pay_in_asset"] || body["payInAsset"], "pay_in_asset")
          guard("swap.create", request, { order_id: order_id })
          resolved = resolve_host("swap.create", request, order_id, body, asset)
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
                   @service.create_swap(
                     body.merge("amount" => required_amount(resolved), "pay_in_asset" => asset)
                   )
                 end
          commit(swap.fetch("checkout"), swap["swap_data"]) unless resolved["payment_hash"]
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
            refund_address: required(body["refund_address"] || body["refundAddress"], "refund_address")
          )
        end
      end

      def read_rates(query_string:, request:, request_id:)
        handle(request_id) do
          currencies = query_string.to_s[/currencies=([^&]+)/, 1]&.split(",")
          success(200, @service.list_rates(currencies.nil? ? {} : { "currencies" => currencies }), request_id)
        end
      end

      def error_response(error, request_id)
        status = error.respond_to?(:status) ? error.status : 500
        code = error.respond_to?(:code) ? error.code : "INTERNAL"
        message = status == 500 ? "Internal server error." : error.message
        [status, headers(request_id), { "code" => code, "message" => message, "request_id" => request_id }.compact]
      end

      private

      def swap_action(action, raw_body, request, request_id)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          requested_hash = required(body["payment_hash"] || body["paymentHash"], "payment_hash").downcase
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
        context = { action: action, request: request, resource: resource }
        raise ValidationError, "Too many requests." if @rate_limit && !@rate_limit.call(context)
        raise UnauthorizedError, "Not authorized for this action." unless @authorize.call(context)
      end

      def commit(checkout, swap_data = nil)
        @on_checkout_created.call(
          order_id: checkout.fetch("order_id"),
          payment_hash: checkout.fetch("payment_hash"),
          checkout: checkout,
          swap_data: swap_data
        )
      rescue StandardError
        raise ConflictError, "The host did not persist this payment attempt; payer instructions were withheld."
      end

      def public_swap(swap)
        swap.reject { |key, _| key == "swap_data" }
      end

      def handle(request_id)
        yield
      rescue StandardError, NotImplementedError => e
        error_response(e, request_id)
      end

      def parse(raw)
        value = raw.to_s.strip.empty? ? {} : JSON.parse(raw)
        raise ValidationError, "Request body must be a JSON object." unless value.is_a?(Hash)
        value
      rescue JSON::ParserError
        raise ValidationError, "Request body must be valid JSON."
      end

      def required(value, field)
        text = value.to_s.strip
        raise ValidationError, "#{field} is required." if text.empty?
        text
      end

      def required_amount(resolved)
        resolved.fetch("amount")
      rescue KeyError
        raise NotFoundError, "The host order has no payable amount."
      end

      def required_swap_data(value)
        raise NotFoundError, "The host order has no swap data." unless value.is_a?(Hash)
        value
      end

      def selected_payment_hash(resolved, requested_hash)
        selected = required(resolved["payment_hash"], "payment_hash").downcase
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
        { "Content-Type" => "application/json; charset=utf-8", "X-Request-Id" => request_id }.compact
      end
    end
  end
end
