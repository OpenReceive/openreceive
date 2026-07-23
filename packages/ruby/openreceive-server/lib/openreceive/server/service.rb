# frozen_string_literal: true

require "digest"
require "openreceive"
require "openreceive/server/errors"

module OpenReceive
  module Server
    class Service
      PAGE_LIMIT = 20
      INVOICE_EXPIRY_SECONDS = 600

      attr_reader :price_currencies

      def initialize(nwc_client:, tokens:, price_provider: nil, swap_providers: [], price_currencies: ["USD"], clock: -> { Time.now.to_i })
        @nwc = nwc_client
        @tokens = tokens
        @price_provider = price_provider
        @swap_providers = Array(swap_providers)
        @price_currencies = Array(price_currencies || ["USD"]).map { |value| value.to_s.upcase }
        @clock = clock
      end

      def create_checkout(input)
        data = stringify(input)
        order_id = required_string(data["orderId"] || data["order_id"], "orderId")
        amount_msats, fiat_quote = resolve_amount(data.fetch("amount"))
        expiry = Integer(data["expirySeconds"] || data["expiry_seconds"] || INVOICE_EXPIRY_SECONDS)
        request = {
          "amount_msats" => amount_msats,
          "expiry" => expiry,
          "metadata" => stringify(data["metadata"] || {}).merge("order_id" => order_id)
        }
        request["description"] = data["memo"] if data["memo"]
        request["description_hash"] = data["descriptionHash"] || data["description_hash"] if data["descriptionHash"] || data["description_hash"]
        wallet = OpenReceive.normalize_make_invoice_response(call_nwc(:make_invoice, request))
        created_at = wallet["created_at"] || @clock.call
        {
          "order_id" => order_id,
          "payment_hash" => wallet.fetch("payment_hash"),
          "bolt11" => wallet.fetch("invoice"),
          "amount_msats" => wallet.fetch("amount_msats"),
          "created_at" => created_at,
          "expires_at" => wallet["expires_at"] || created_at + expiry,
          "fiat_quote" => fiat_quote
        }
      rescue KeyError, ArgumentError => e
        raise ValidationError, e.message
      end

      def check_payment(input)
        data = stringify(input)
        payment_hash = payment_hash(data["paymentHash"] || data["payment_hash"])
        transaction = lookup_transaction(payment_hash, from: data["from"], until_time: data["until"])
        return { "payment_hash" => payment_hash, "status" => "not_found" } if transaction.nil?

        status = OpenReceive::Settlement.status(transaction)
        observed_at = @clock.call
        paid_at = status == "settled" ? (transaction["settled_at"] || observed_at) : nil
        details = {
          "transaction" => transaction,
          "observed_at" => observed_at
        }
        if status == "settled"
          details["paid_at_source"] = transaction["settled_at"] ? "settled_at" : "observed_at"
        end
        {
          "payment_hash" => payment_hash,
          "status" => status,
          "paid_at" => paid_at,
          "details" => details
        }.compact
      end

      def recover_checkout(order_id:, payment_hash:, expires_at: nil)
        hash = send(:payment_hash, payment_hash)
        transaction = lookup_transaction(hash, from: nil, until_time: nil)
        return nil if transaction.nil? || OpenReceive::Settlement.status(transaction) != "pending"
        return nil unless transaction["invoice"] && transaction["amount_msats"] && transaction["created_at"]
        expiry = expires_at || transaction["expires_at"] || transaction["created_at"] + INVOICE_EXPIRY_SECONDS
        return nil if expiry <= @clock.call
        {
          "order_id" => required_string(order_id, "order_id"),
          "payment_hash" => hash,
          "bolt11" => transaction["invoice"],
          "amount_msats" => Integer(transaction["amount_msats"]),
          "created_at" => transaction["created_at"],
          "expires_at" => expiry,
          "fiat_quote" => nil
        }
      end

      def reconcile_payments(input)
        data = stringify(input)
        Array(data.fetch("payment_hashes")).map do |hash|
          check_payment("payment_hash" => hash, "from" => data["from"], "until" => data["until"])
        end
      end

      def watch_payments(from: [@clock.call - 3600, 0].max, interval: 5, on_paid:, stop: -> { false })
        delivered = {}
        until stop.call
          begin
            list_transactions(from: from, until_time: @clock.call).each do |transaction|
              next unless OpenReceive.settled?(transaction)
              hash = transaction["payment_hash"]
              next if hash.nil? || delivered[hash]
              paid_at = transaction["settled_at"] || @clock.call
              on_paid.call("payment_hash" => hash, "paid_at" => paid_at, "details" => { "transaction" => transaction })
              delivered[hash] = true
            end
          rescue StandardError
            # Wallet and callback failures are retried by the next overlapping scan.
          end
          sleep(interval)
        end
      end

      def mint_capability_token(order_id:, payment_hash:, expires_at:)
        @tokens.seal("cap", "orderId" => order_id, "paymentHash" => payment_hash, "expiresAt" => expires_at)
      end

      def verify_capability_token(token)
        payload = @tokens.open("cap", token)
        return nil unless payload["orderId"].is_a?(String) && /\A[0-9a-f]{64}\z/.match?(payload["paymentHash"].to_s)
        payload
      rescue Tokens::InvalidToken
        nil
      end

      def quote_swap(input)
        data = stringify(input)
        amount_msats, = resolve_amount(data.fetch("amount"))
        asset = required_string(data["payInAsset"] || data["pay_in_asset"], "payInAsset")
        provider = select_provider(asset)
        call_provider(provider, :quote, "pay_in_asset" => asset, "invoice_amount_msats" => amount_msats)
      end

      def create_swap(input)
        data = stringify(input)
        asset = required_string(data["payInAsset"] || data["pay_in_asset"], "payInAsset")
        provider = select_provider(asset)
        expiry = provider.respond_to?(:invoice_expiry_seconds) ? provider.invoice_expiry_seconds(pay_in_asset: asset) : 1800
        checkout = create_checkout(data.merge("expiry_seconds" => expiry))
        order = stringify(call_provider(provider, :create_swap,
          "pay_in_asset" => asset,
          "bolt11" => checkout.fetch("bolt11"),
          "invoice_amount_msats" => checkout.fetch("amount_msats")))
        assert_provider_identity(provider_name(provider), order.fetch("provider_order_id"), order)
        if Integer(order.fetch("expires_at")) > checkout.fetch("expires_at")
          raise ValidationError, "swap provider order outlives its shadow Lightning invoice"
        end
        recovery = @tokens.seal("swap", {
          "provider" => provider_name(provider),
          "providerOrder" => order.reject { |key, _| key == "raw" },
          "paymentHash" => checkout.fetch("payment_hash"),
          "orderId" => checkout.fetch("order_id")
        })
        public_swap(order, checkout.fetch("payment_hash"), checkout.fetch("order_id")).merge(
          "checkout" => checkout,
          "swap_recovery_token" => recovery
        )
      end

      def get_swap(recovery_token:)
        recovery = @tokens.open("swap", recovery_token)
        provider = provider_by_name(recovery.fetch("provider"))
        current = stringify(call_provider(provider, :get_status, recovery.fetch("providerOrder")))
        assert_provider_identity(recovery.fetch("provider"), recovery.fetch("providerOrder").fetch("provider_order_id"), current)
        public_swap(current, recovery.fetch("paymentHash"), recovery.fetch("orderId")).merge(
          "swap_recovery_token" => recovery_token
        )
      rescue Tokens::InvalidToken, KeyError => e
        raise ValidationError, e.message
      end

      def create_swap_refund_confirmation(recovery_token:, refund_address:, ttl_seconds: 600)
        recovery = @tokens.open("swap", recovery_token)
        expires_at = @clock.call + Integer(ttl_seconds)
        token = @tokens.seal("confirm", {
          "recoveryDigest" => Digest::SHA256.hexdigest(recovery_token),
          "paymentHash" => recovery.fetch("paymentHash"),
          "providerOrderId" => recovery.fetch("providerOrder").fetch("provider_order_id"),
          "refundAddress" => required_string(refund_address, "refund_address"),
          "expiresAt" => expires_at
        })
        { "confirmation_token" => token, "expires_at" => expires_at }
      rescue Tokens::InvalidToken, KeyError => e
        raise ValidationError, e.message
      end

      def refund_swap(recovery_token:, refund_address:, confirmation_token:)
        recovery = @tokens.open("swap", recovery_token)
        confirmation = @tokens.open("confirm", confirmation_token)
        address = required_string(refund_address, "refund_address")
        unless confirmation["recoveryDigest"] == Digest::SHA256.hexdigest(recovery_token) &&
               confirmation["paymentHash"] == recovery["paymentHash"] &&
               confirmation["providerOrderId"] == recovery.fetch("providerOrder").fetch("provider_order_id") &&
               confirmation["refundAddress"] == address
          raise ValidationError, "refund confirmation does not match"
        end
        provider = provider_by_name(recovery.fetch("provider"))
        current = stringify(call_provider(provider, :get_status, recovery.fetch("providerOrder")))
        assert_provider_identity(recovery.fetch("provider"), recovery.fetch("providerOrder").fetch("provider_order_id"), current)
        raise ValidationError, "swap is not refund eligible" unless current["state"] == "refund_required"
        call_provider(provider, :request_refund, current, address)
        get_swap(recovery_token: recovery_token)
      rescue Tokens::InvalidToken, KeyError => e
        raise ValidationError, e.message
      end

      def list_rates(input = {})
        raise NotImplementedError, "price provider is not configured" if @price_provider.nil?
        currencies = Array(stringify(input)["currencies"] || @price_currencies)
        { "bitcoin" => currencies.to_h { |currency| [currency.downcase, @price_provider.btc_fiat_price(currency).to_s] } }
      end

      private

      def resolve_amount(input)
        amount = stringify(input)
        if amount.key?("sats")
          return [OpenReceive::Money.direct_to_msats(currency: "SATS", value: amount.fetch("sats")), nil]
        end
        currency = required_string(amount["currency"], "amount.currency").upcase
        value = required_string(amount["value"], "amount.value")
        return [OpenReceive::Money.direct_to_msats(currency: currency, value: value), nil] if %w[BTC SAT SATS].include?(currency)
        raise ValidationError, "price provider is not configured" if @price_provider.nil?
        raise ValidationError, "unsupported fiat currency" unless @price_currencies.include?(currency)
        price = @price_provider.btc_fiat_price(currency).to_s
        msats = OpenReceive.quote_fiat_to_msats(fiat_value: value, btc_fiat_price: price)
        [msats, { "fiat" => { "currency" => currency, "value" => value }, "btc_fiat_price" => price, "amount_msats" => msats, "as_of" => @clock.call }]
      end

      def lookup_transaction(hash, from:, until_time:)
        if @nwc.respond_to?(:lookup_invoice)
          begin
            return OpenReceive::Nwc.normalize_transaction(@nwc.lookup_invoice("payment_hash" => hash))
          rescue StandardError
            # list_transactions is the portable fallback.
          end
        end
        transaction = list_transactions(from: from, until_time: until_time).find { |row| row["payment_hash"] == hash }
        return transaction unless transaction.nil?

        list_transactions(from: from, until_time: until_time, unpaid: true).find { |row| row["payment_hash"] == hash }
      end

      def list_transactions(from:, until_time:, unpaid: false)
        offset = 0
        result = {}
        loop do
          request = { "type" => "incoming", "limit" => PAGE_LIMIT, "offset" => offset }
          request["unpaid"] = true if unpaid
          request["from"] = Integer(from) unless from.nil?
          request["until"] = Integer(until_time) unless until_time.nil?
          page = OpenReceive.normalize_list_transactions_response(call_nwc(:list_transactions, request)).fetch("transactions")
          page.each { |row| result[row["payment_hash"]] = row if row["payment_hash"] }
          break if page.length < PAGE_LIMIT
          offset += PAGE_LIMIT
        end
        result.values
      end

      def select_provider(asset)
        @swap_providers.find do |provider|
          supported = call_provider(provider, :supported_pay_in_assets)
          Array(supported).include?(asset) || supported.respond_to?(:include?) && supported.include?(asset)
        end || raise(ValidationError, "no swap provider supports #{asset}")
      end

      def provider_by_name(name)
        @swap_providers.find { |provider| provider_name(provider) == name } || raise(ValidationError, "swap provider is not configured")
      end

      def provider_name(provider)
        provider.respond_to?(:name) ? provider.name : provider.class.name
      end

      def public_swap(order, hash, order_id)
        {
          "payment_hash" => hash,
          "order_id" => order_id,
          "provider" => order.fetch("provider"),
          "pay_in_asset" => order.fetch("pay_in_asset"),
          "deposit_address" => order.fetch("deposit_address"),
          "deposit_memo" => order["deposit_memo"],
          "deposit_amount" => order.fetch("deposit_amount"),
          "provider_state" => order.fetch("state"),
          "provider_expires_at" => order.fetch("expires_at"),
          "deposit_tx_id" => order["deposit_tx_id"],
          "payout_tx_id" => order["payout_tx_id"],
          "refund_tx_id" => order["refund_tx_id"],
          "refund_reason" => order["refund_reason"],
          "refund_amount" => order["refund_amount"],
          "attention" => order["attention"]
        }.compact
      end

      def assert_provider_identity(provider, provider_order_id, order)
        return if order["provider"] == provider && order["provider_order_id"] == provider_order_id
        raise ValidationError, "swap provider returned a mismatched order"
      end

      def call_nwc(method, input)
        @nwc.public_send(method, input)
      rescue ArgumentError
        @nwc.public_send(method, **input.transform_keys(&:to_sym))
      end

      def call_provider(provider, method, *args)
        provider.public_send(method, *args)
      rescue ArgumentError
        if args.length == 1 && args.first.is_a?(Hash)
          provider.public_send(method, **args.first.transform_keys(&:to_sym))
        else
          raise
        end
      end

      def stringify(value)
        return {} unless value.respond_to?(:each_pair)
        value.each_pair.to_h { |key, item| [key.to_s, item] }
      end

      def required_string(value, field)
        text = value.to_s.strip
        raise ValidationError, "#{field} is required" if text.empty?
        text
      end

      def payment_hash(value)
        hash = required_string(value, "payment_hash").downcase
        raise ValidationError, "payment_hash must be 64 hexadecimal characters" unless /\A[0-9a-f]{64}\z/.match?(hash)
        hash
      end
    end
  end
end
