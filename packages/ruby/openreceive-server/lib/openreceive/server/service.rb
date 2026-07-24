# frozen_string_literal: true

require "openreceive"
require "openreceive/server/errors"

module OpenReceive
  module Server
    class Service
      PAGE_LIMIT = 20
      INVOICE_EXPIRY_SECONDS = 600

      attr_reader :price_currencies

      def initialize(nwc_client:, price_provider: nil, swap_providers: [], price_currencies: ["USD"], clock: -> { Time.now.to_i })
        @nwc = nwc_client
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
        created_at = Integer(data["createdAt"] || data.fetch("created_at"))
        overlap = Integer(data["overlapSeconds"] || data.fetch("overlap_seconds", 60))
        transaction = lookup_transaction(
          payment_hash,
          from: [created_at - overlap, 0].max,
          until_time: data["until"]
        )
        return { "payment_hash" => payment_hash, "status" => "not_found" } if transaction.nil?

        payment_result(payment_hash, transaction)
      end

      def reconcile_payments(input)
        data = stringify(input)
        attempts = Array(data.fetch("attempts"))
        return [] if attempts.empty?

        expected = attempts.to_h do |attempt|
          row = stringify(attempt)
          [payment_hash(row.fetch("payment_hash") { row.fetch("paymentHash") }),
           Integer(row.fetch("created_at") { row.fetch("createdAt") })]
        end
        overlap = Integer(data.fetch("overlap_seconds", 60))
        from = [expected.values.min - overlap, 0].max
        until_time = Integer(data["until"] || @clock.call)
        rows = list_transactions(from: from, until_time: until_time)
        by_hash = rows.to_h { |row| [row["payment_hash"], row] }
        if expected.keys.any? { |hash| !by_hash.key?(hash) }
          list_transactions(from: from, until_time: until_time, unpaid: true).each do |row|
            by_hash[row["payment_hash"]] ||= row
          end
        end
        expected.keys.map do |hash|
          by_hash[hash] ? payment_result(hash, by_hash.fetch(hash)) :
            { "payment_hash" => hash, "status" => "not_found" }
        end
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
        swap_data = {
          "version" => 1,
          "provider_order" => order.reject { |key, _| key == "raw" }
        }
        public_swap(order, checkout.fetch("payment_hash"), checkout.fetch("order_id")).merge(
          "checkout" => checkout,
          "swap_data" => swap_data
        )
      end

      def get_swap(order_id:, payment_hash:, swap_data:)
        recovery = normalize_swap_data(swap_data)
        provider_name = recovery.fetch("provider_order").fetch("provider")
        provider = provider_by_name(provider_name)
        current = stringify(call_provider(provider, :get_status, recovery.fetch("provider_order")))
        assert_provider_identity(provider_name, recovery.fetch("provider_order").fetch("provider_order_id"), current)
        public_swap(current, send(:payment_hash, payment_hash), required_string(order_id, "order_id"))
      rescue KeyError => e
        raise ValidationError, e.message
      end

      def refund_swap(order_id:, payment_hash:, swap_data:, refund_address:)
        recovery = normalize_swap_data(swap_data)
        hash = send(:payment_hash, payment_hash)
        host_order_id = required_string(order_id, "order_id")
        address = required_string(refund_address, "refund_address")
        provider_name = recovery.fetch("provider_order").fetch("provider")
        provider = provider_by_name(provider_name)
        current = stringify(call_provider(provider, :get_status, recovery.fetch("provider_order")))
        assert_provider_identity(provider_name, recovery.fetch("provider_order").fetch("provider_order_id"), current)
        raise ValidationError, "swap is not refund eligible" unless current["state"] == "refund_required"
        call_provider(provider, :request_refund, current, address)
        get_swap(order_id: host_order_id, payment_hash: hash, swap_data: recovery)
      rescue KeyError => e
        raise ValidationError, e.message
      end

      def list_rates(input = {})
        raise NotImplementedError, "price provider is not configured" if @price_provider.nil?
        currencies = Array(stringify(input)["currencies"] || @price_currencies)
        { "bitcoin" => currencies.to_h { |currency| [currency.downcase, @price_provider.btc_fiat_price(currency).to_s] } }
      end

      private

      def normalize_swap_data(value)
        data = stringify(value)
        unless data["version"] == 1 && data["provider_order"].is_a?(Hash) &&
               !data.dig("provider_order", "provider").to_s.empty? &&
               !data.dig("provider_order", "provider_order_id").to_s.empty?
          raise ValidationError, "swap_data is invalid"
        end
        data
      end

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
        transaction = list_transactions(from: from, until_time: until_time).find { |row| row["payment_hash"] == hash }
        return transaction unless transaction.nil?

        list_transactions(from: from, until_time: until_time, unpaid: true).find { |row| row["payment_hash"] == hash }
      end

      def payment_result(hash, transaction)
        status = OpenReceive::Settlement.status(transaction)
        observed_at = @clock.call
        paid_at = status == "settled" ? (transaction["settled_at"] || observed_at) : nil
        details = { "transaction" => transaction, "observed_at" => observed_at }
        details["paid_at_source"] = transaction["settled_at"] ? "settled_at" : "observed_at" if status == "settled"
        {
          "payment_hash" => hash,
          "status" => status,
          "paid_at" => paid_at,
          "details" => details
        }.compact
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
