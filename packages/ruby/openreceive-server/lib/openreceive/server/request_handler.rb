# frozen_string_literal: true

require "json"
require "securerandom"

module OpenReceive
  module Server
    class RequestHandler
      COOKIE_NAME = "openreceive_payment_capability"

      def self.extract_token(authorization, header, cookie = nil)
        match = authorization.to_s.match(/\ABearer\s+(.+)\z/i)
        return match[1].strip if match
        return header if header.is_a?(String) && !header.empty?
        cookie.to_s.split(";").each do |part|
          name, value = part.strip.split("=", 2)
          return value if name == COOKIE_NAME
        end
        nil
      end

      def initialize(service:, authorize:, resolve_checkout_amount:, on_checkout_created:, rate_limit: nil, prefix: "/openreceive")
        raise ArgumentError, "authorize is required" if authorize.nil?
        raise ArgumentError, "resolve_checkout_amount is required" if resolve_checkout_amount.nil?
        raise ArgumentError, "on_checkout_created is required" if on_checkout_created.nil?
        @service = service
        @authorize = authorize
        @resolve_checkout_amount = resolve_checkout_amount
        @on_checkout_created = on_checkout_created
        @rate_limit = rate_limit
        @prefix = prefix
      end

      def create_checkout(raw_body:, request:, token:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          reject_payer_amount(body)
          guard("checkout.create", request, { order_id: order_id }, token)
          resolved = resolved_host_checkout(@resolve_checkout_amount.call(
            action: "checkout.create", request: request, order_id: order_id, input: body
          ))
          checkout = if resolved["payment_hash"]
                       recover_checkout(order_id, resolved["payment_hash"])
                     else
                       @service.create_checkout(
                         "order_id" => order_id, "amount" => resolved.fetch("amount"),
                         "memo" => body["memo"], "description_hash" => body["description_hash"],
                         "metadata" => body["metadata"]
                       )
                     end
          expires_at = [checkout.fetch("expires_at"), Time.now.to_i + 86_400].max
          capability = @service.mint_capability_token(
            order_id: order_id,
            payment_hash: checkout.fetch("payment_hash"),
            expires_at: expires_at
          )
          commit(checkout) unless resolved["payment_hash"]
          success(201, { "checkout" => checkout, "order_access_token" => capability }, request_id,
                  "Set-Cookie" => cookie(capability, request))
        end
      end

      def check_payment(raw_body:, request:, token:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          hash = required(body["payment_hash"] || body["paymentHash"], "payment_hash").downcase
          guard("payment.check", request, { payment_hash: hash }, token)
          success(200, @service.check_payment("payment_hash" => hash), request_id)
        end
      end

      def quote_swap(raw_body:, request:, token:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          guard("swap.quote", request, {}, token)
          success(200, @service.quote_swap(body), request_id)
        end
      end

      def create_swap(raw_body:, request:, token:, request_id:)
        handle(request_id) do
          body = parse(raw_body)
          order_id = required(body["order_id"] || body["orderId"], "order_id")
          reject_payer_amount(body)
          pay_in_asset = required(body["pay_in_asset"] || body["payInAsset"], "pay_in_asset")
          guard("swap.create", request, { order_id: order_id }, token)
          resolved = resolved_host_checkout(@resolve_checkout_amount.call(
            action: "swap.create", request: request, order_id: order_id,
            pay_in_asset: pay_in_asset, input: body
          ))
          swap = if resolved["payment_hash"]
                   recovery = required(resolved["swap_recovery_token"], "swap_recovery_token")
                   status = @service.get_swap(recovery_token: recovery)
                   status.merge("checkout" => recover_checkout(
                     order_id, resolved["payment_hash"], status["provider_expires_at"]
                   ))
                 else
                   @service.create_swap(body.merge(
                     "amount" => resolved.fetch("amount"), "pay_in_asset" => pay_in_asset
                   ))
                 end
          capability = @service.mint_capability_token(
            order_id: order_id,
            payment_hash: swap.fetch("payment_hash"),
            expires_at: [swap.fetch("provider_expires_at"), Time.now.to_i + 86_400].max
          )
          commit(swap.fetch("checkout"), swap["swap_recovery_token"]) unless resolved["payment_hash"]
          success(201, { "swap" => swap, "order_access_token" => capability }, request_id,
                  "Set-Cookie" => cookie(capability, request))
        end
      end

      def get_swap(raw_body:, request:, token:, request_id:)
        swap_action("swap.read", raw_body, request, token, request_id) do |recovery, _body|
          @service.get_swap(recovery_token: recovery)
        end
      end

      def create_refund_confirmation(raw_body:, request:, token:, request_id:)
        swap_action("swap.refund.confirm", raw_body, request, token, request_id, status: 201) do |recovery, body|
          @service.create_swap_refund_confirmation(
            recovery_token: recovery,
            refund_address: required(body["refund_address"] || body["refundAddress"], "refund_address")
          )
        end
      end

      def refund_swap(raw_body:, request:, token:, request_id:)
        swap_action("swap.refund", raw_body, request, token, request_id) do |recovery, body|
          @service.refund_swap(
            recovery_token: recovery,
            refund_address: required(body["refund_address"] || body["refundAddress"], "refund_address"),
            confirmation_token: required(body["confirmation_token"] || body["confirmationToken"], "confirmation_token")
          )
        end
      end

      def read_rates(query_string:, request:, token:, request_id:)
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

      def swap_action(action, raw_body, request, token, request_id, status: 200)
        handle(request_id) do
          body = parse(raw_body)
          recovery = required(body["swap_recovery_token"] || body["recovery_token"] || body["recoveryToken"], "swap_recovery_token")
          guard(action, request, { recovery_token_present: true }, token, recovery: true)
          success(status, yield(recovery, body), request_id)
        end
      end

      def guard(action, request, resource, token, recovery: false)
        capability = token.nil? ? nil : @service.verify_capability_token(token)
        valid = recovery || (!capability.nil? &&
          (!resource[:order_id] || capability["orderId"] == resource[:order_id]) &&
          (!resource[:payment_hash] || capability["paymentHash"] == resource[:payment_hash]))
        context = { action: action, request: request, resource: resource, token: token, token_valid: valid }
        raise ValidationError, "Too many requests." if @rate_limit && !@rate_limit.call(context)
        raise UnauthorizedError, "Not authorized for this action." unless @authorize.call(context)
      end

      def commit(checkout, recovery = nil)
        @on_checkout_created.call(
          order_id: checkout.fetch("order_id"),
          payment_hash: checkout.fetch("payment_hash"),
          checkout: checkout,
          swap_recovery_token: recovery
        )
      rescue StandardError
        raise ConflictError, "The host did not persist this payment hash; payer instructions were withheld."
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

      def reject_payer_amount(body)
        return unless body.key?("amount") || body.key?("amount_msats")
        raise ValidationError, "Checkout create does not accept a payer-supplied amount; the host resolves its order price."
      end

      def resolved_host_checkout(value)
        data = value.respond_to?(:each_pair) ? value.each_pair.to_h { |key, item| [key.to_s, item] } : {}
        return data if data.key?("amount")
        { "amount" => value }
      end

      def recover_checkout(order_id, payment_hash, expires_at = nil)
        checkout = @service.recover_checkout(
          order_id: order_id, payment_hash: payment_hash, expires_at: expires_at
        )
        return checkout unless checkout.nil?
        raise ConflictError, "The host order has a payment hash that is not a reusable pending checkout."
      end

      def success(status, body, request_id, extra = {})
        [status, headers(request_id).merge(extra), body]
      end

      def headers(request_id)
        { "Content-Type" => "application/json; charset=utf-8", "X-Request-Id" => request_id }.compact
      end

      def cookie(token, request)
        secure = request.respond_to?(:[]) && request["rack.url_scheme"] == "https" ? "; Secure" : ""
        "#{COOKIE_NAME}=#{token}; Path=#{@prefix}; HttpOnly; SameSite=Lax; Max-Age=86400#{secure}"
      end
    end
  end
end
