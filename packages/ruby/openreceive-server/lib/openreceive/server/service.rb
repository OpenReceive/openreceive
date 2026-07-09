# frozen_string_literal: true

require "json"
require "securerandom"
require "bigdecimal"

module OpenReceive
  module Server
    # OpenReceive checkout/order service — the Ruby port of the Node service (packages/js/node).
    #
    # Fully implemented: the Lightning create-checkout / read-checkout / read-order path, per-order
    # idempotency, checkout supersede, the bounded pending-invoice transaction scan (sweep), and
    # BTC/SATS + injected-price fiat amount resolution.
    #
    # Scaffolded (raise NotImplementedError with a clear message — the Node engine is the reference):
    #   * swaps: swap_options returns a disabled snapshot; swap_quote / start_swap / refund_swap raise.
    #   * live price feeds: list_rates / quote_rates require an injected price_provider; without one
    #     they raise (no live fetching is implemented here).
    #
    # Settlement authority is the backend status refresh (list_transactions), never a notification.
    # The NWC secret is never logged and never placed in a wire payload.
    class Service
      INVOICE_EXPIRY_SECONDS = 600
      SWEEP_OPEN_INVOICE_CAP = 1000
      TRANSACTION_SCAN_PAGE_LIMIT = 25
      MAX_TRANSACTION_SCAN_PAGE_LIMIT = 50
      SCAN_OVERLAP_SECONDS = 60
      MIN_TRANSACTION_SCAN_INTERVAL_SECONDS = 2
      QUOTE_TTL_SECONDS = 60
      SATS_PER_BTC = 100_000_000
      MSATS_PER_SAT = 1000
      TRANSACTION_SCAN_GATE_META_KEY = "transaction_scan_gate"
      TRANSACTION_SCAN_CURSOR_META_KEY = "transaction_scan_cursor:v2:global"
      DEFAULT_PRICE_CURRENCIES = %w[USD].freeze
      RESERVED_CHECKOUT_METADATA_KEYS = %w[
        order_id checkout_id superseded amount_spec memo description_hash
        rail swap swap_private swap_attempt_key
      ].freeze

      attr_reader :store, :namespace

      # `clock:` is an optional injection (defaults to wall-clock unix seconds) so callers and tests
      # can pin time. Everything else matches the Node service constructor.
      def initialize(nwc_client:, store:, namespace: "default", price_provider: nil,
                     swap_providers: [], logger: nil, price_currencies: nil, clock: nil)
        @nwc = wrap_nwc(nwc_client)
        @store = store
        @namespace = blank?(namespace) ? "default" : namespace.to_s
        @price_provider = price_provider
        @swap_providers = swap_providers || []
        @logger = logger
        @price_currencies = normalize_currencies(price_currencies) || DEFAULT_PRICE_CURRENCIES
        @clock = clock || -> { Time.now.to_i }
        @store.ensure_schema if @store.respond_to?(:ensure_schema)
      end

      # --- Checkouts -----------------------------------------------------------------------------

      def get_or_create_checkout(request)
        input = normalize_create_checkout_request(request)
        order_id = input.fetch("order_id")
        read_amount_kind(input.fetch("amount"))
        current = now

        checkouts = Models.group_checkouts(@store.list_by_order_id(order_id), current)
        paid = checkouts.find { |checkout| checkout["status"] == "paid" }
        return paid unless paid.nil?

        open = checkouts.find { |checkout| checkout["status"] == "open" }
        return open if !open.nil? && amount_matches?(input.fetch("amount"), open, current)

        superseded_id = open ? open["checkout_id"] : checkouts.find { |c| c["status"] == "expired" }&.fetch("checkout_id", nil)
        supersede_checkout(open) unless open.nil?

        checkout_id = generate_checkout_id
        minted = mint_invoice_for_checkout(
          order_id: order_id,
          checkout_id: checkout_id,
          input: input,
          superseded_id: superseded_id,
          now: current
        )

        # A settled payment for an abandoned invoice is only discovered by a scan. Any subsequent
        # action triggers the global sweep, so kick one here (best-effort, never fatal).
        best_effort_sweep

        fresh = Models.group_checkouts(@store.list_by_order_id(order_id), now)
        require_checkout(fresh, Models.stored_checkout_id(minted))
      end

      def get_checkout(checkout_id:)
        records = @store.list_by_checkout_id(checkout_id)
        raise NotFoundError, "No checkout found for the given checkout_id." if records.empty?

        sweep_pending_invoices
        fresh = @store.list_by_checkout_id(checkout_id)
        require_checkout(Models.group_checkouts(fresh, now), checkout_id)
      end

      def get_order(order_id:)
        records = @store.list_by_order_id(order_id)
        raise NotFoundError, "No order found for the given order_id." if records.empty?

        result = sweep_pending_invoices
        fresh = @store.list_by_order_id(order_id)
        Models.build_order(
          fresh,
          {
            wallet_scan_performed: result["swept"],
            transactions_checked: result["page_count"]
          },
          now
        )
      end

      # --- Swaps (scaffold) ----------------------------------------------------------------------

      # TODO(swaps): port the Node swap providers. Until then swaps are advertised as unavailable.
      def swap_options(order_id:)
        _ = order_id
        { "enabled" => false, "options" => [] }
      end

      def swap_quote(*)
        raise NotImplementedError, swap_not_implemented_message
      end

      def start_swap(*)
        raise NotImplementedError, swap_not_implemented_message
      end

      def refund_swap(*)
        raise NotImplementedError, swap_not_implemented_message
      end

      def refresh_swap(*)
        raise NotImplementedError, swap_not_implemented_message
      end

      # --- Pending-invoice sweep (backend settlement authority) -----------------------------------

      # Bounded, cursor-gated pending-invoice scan. Mirrors the Node core transaction-scan runner
      # (spec/test-vectors/transaction-scan-pagination.json): a single incoming/unpaid page per
      # durable gate claim, 60s window overlap, default limit 25 (capped at 50), cursor stored in
      # meta via cas_meta, cursor unchanged on wallet error/timeout.
      def sweep_pending_invoices
        current = now
        open = @store.list_open(now: current, limit: SWEEP_OPEN_INVOICE_CAP)
        return sweep_result(0, 0, 0, swept: false, reason: "no_pending") if open.empty?
        return sweep_result(0, 0, 0, swept: false, reason: "gate_busy") unless claim_transaction_scan_gate(current, open)

        from = [0, open.map { |row| integer(row["created_at"]) }.min - SCAN_OVERLAP_SECONDS].max
        cursor = read_transaction_scan_cursor
        until_cursor = !cursor["until_cursor"].nil? && cursor["until_cursor"] > from ? cursor["until_cursor"] : current
        limit = TRANSACTION_SCAN_PAGE_LIMIT

        begin
          page = @nwc.list_transactions(
            "type" => "incoming",
            "unpaid" => true,
            "from" => from,
            "until" => until_cursor,
            "limit" => limit
          )
        rescue StandardError => e
          # Cursor does NOT advance on wallet timeout/error.
          log(:warn, "transaction_scan.failed", e.message)
          return sweep_result(0, 0, 0, swept: false, reason: "wallet_scan_failed")
        end

        transactions = Array(page["transactions"])
        settled_count = 0
        expired_count = 0
        transactions.each do |transaction|
          next if !transaction["type"].nil? && transaction["type"] != "incoming"

          record = find_transaction_record(transaction)
          next if record.nil? || terminal_row?(record)

          case apply_transaction(record, transaction)
          when :settled then settled_count += 1
          when :expired then expired_count += 1
          end
        end

        write_transaction_scan_cursor(
          "until_cursor" => next_transaction_scan_until(transactions, limit, until_cursor, current),
          "last_swept_at" => current
        )

        sweep_result(transactions.length, settled_count, expired_count, swept: true, page_count: transactions.length)
      end

      # --- Rates -------------------------------------------------------------------------------

      # Returns a BtcFiatRateMap ({ "bitcoin" => { "usd" => "..." } }). Requires an injected
      # price_provider — live price feeds are scaffolded.
      def list_rates(input = nil)
        raise NotImplementedError, price_feed_not_implemented_message if @price_provider.nil?

        data = input.nil? ? {} : stringify_keys(input)
        currencies = normalize_currencies(data["currencies"]) || @price_currencies
        bitcoin = {}
        currencies.each { |currency| bitcoin[currency.downcase] = btc_fiat_price_for(currency).to_s }
        { "bitcoin" => bitcoin }
      end

      # Returns a RateQuote for a fiat amount. Requires an injected price_provider.
      def quote_rates(fiat:)
        raise NotImplementedError, price_feed_not_implemented_message if @price_provider.nil?

        quote_fiat_amount(parse_fiat_amount(fiat), now)
      end

      # --- Lifecycle -----------------------------------------------------------------------------

      def close
        @store.close if @store.respond_to?(:close)
        @nwc.close if @nwc.respond_to?(:close)
        nil
      end

      private

      # --- create-checkout internals -------------------------------------------------------------

      def mint_invoice_for_checkout(order_id:, checkout_id:, input:, superseded_id:, now:)
        operation = "invoice.create"
        amount_key = amount_key_from(input.fetch("amount"))
        idempotency_key = "#{order_id}:super:#{superseded_id || 'none'}:amt:#{amount_key}"
        request_hash = OpenReceive::Idempotency.request_hash(create_checkout_request_hash_body(input))
        scope = {
          "namespace" => @namespace,
          "operation" => operation,
          "idempotency_key" => idempotency_key
        }

        existing = @store.check_idempotency(scope: scope, idempotency_request_hash: request_hash)
        return existing.fetch("row") unless existing.nil?

        resolved = resolve_create_amount(input.fetch("amount"), now)
        description_fields = description_fields(input)
        wallet_invoice = @nwc.make_invoice(
          { "amount_msats" => resolved.fetch(:amount_msats) }
            .merge(description_fields)
            .merge("expiry" => INVOICE_EXPIRY_SECONDS)
        )

        created_at = optional_integer(wallet_invoice["created_at"]) || now
        expires_at = optional_integer(wallet_invoice["expires_at"]) || (created_at + INVOICE_EXPIRY_SECONDS)
        normalized_expires_at = [expires_at, created_at + INVOICE_EXPIRY_SECONDS].min
        metadata = checkout_metadata(input, order_id, checkout_id)

        row = {
          "invoice_id" => generate_invoice_id,
          "namespace" => @namespace,
          "operation" => operation,
          "idempotency_key" => idempotency_key,
          "idempotency_request_hash" => request_hash,
          "order_id" => order_id,
          "checkout_id" => checkout_id,
          "payment_hash" => wallet_invoice.fetch("payment_hash"),
          "invoice" => wallet_invoice.fetch("invoice"),
          "amount_msats" => integer(wallet_invoice.fetch("amount_msats")),
          "transaction_state" => "pending",
          "workflow_state" => "invoice_created",
          "settlement_action_state" => "pending",
          "created_at" => created_at,
          "expires_at" => normalized_expires_at,
          "metadata" => metadata,
          "fiat_quote" => resolved.fetch(:fiat_quote)
        }

        log(:info, "checkout.created", "order=#{order_id} checkout=#{checkout_id}")
        @store.put_invoice_record(row).fetch("row")
      end

      def checkout_metadata(input, order_id, checkout_id)
        metadata = checkout_passthrough_metadata(input)
        metadata["order_id"] = order_id
        metadata["checkout_id"] = checkout_id
        metadata["amount_spec"] = deep_dup(input.fetch("amount"))
        metadata["memo"] = input["memo"] if input.key?("memo")
        metadata["description_hash"] = input["description_hash"] if input.key?("description_hash")
        metadata
      end

      def checkout_passthrough_metadata(input)
        source = input["metadata"]
        return {} unless source.is_a?(Hash)

        source.each_with_object({}) do |(key, value), result|
          key = key.to_s
          result[key] = deep_dup(value) unless RESERVED_CHECKOUT_METADATA_KEYS.include?(key)
        end
      end

      def create_checkout_request_hash_body(input)
        body = {
          "order_id" => input.fetch("order_id"),
          "amount" => deep_dup(input.fetch("amount"))
        }
        body["memo"] = input["memo"] if input.key?("memo")
        body["description_hash"] = input["description_hash"] if input.key?("description_hash")
        body["metadata"] = checkout_passthrough_metadata(input) if input.key?("metadata")
        body
      end

      def supersede_checkout(checkout)
        return unless @store.respond_to?(:mark_superseded)

        @store.list_by_checkout_id(checkout["checkout_id"]).each do |row|
          @store.mark_superseded(invoice_id: row["invoice_id"])
        end
      end

      def require_checkout(checkouts, checkout_id)
        checkout = checkouts.find { |candidate| candidate["checkout_id"] == checkout_id }
        raise "Created checkout was not readable." if checkout.nil?

        checkout
      end

      def amount_matches?(amount, checkout, now)
        fiat = fiat_from_create_amount(amount)
        if !fiat.nil? || checkout.key?("fiat")
          return false if fiat.nil? || !checkout.key?("fiat")

          return fiat["currency"] == checkout["fiat"]["currency"] &&
                 fiat["value"] == checkout["fiat"]["value"]
        end

        resolve_create_amount(amount, now).fetch(:amount_msats) == checkout["amount_msats"]
      end

      def best_effort_sweep
        sweep_pending_invoices
      rescue StandardError => e
        log(:warn, "checkout.sweep.failed", e.message)
      end

      # --- amount resolution ---------------------------------------------------------------------

      def resolve_create_amount(amount, now)
        kind = read_amount_kind(amount)
        if kind == "sats"
          {
            amount_msats: quote_bitcoin_amount_to_msats("currency" => "SATS", "value" => normalize_sats_value(amount["sats"])),
            amount_source: "amount",
            fiat_quote: nil
          }
        elsif bitcoin_amount_currency?(amount["currency"])
          {
            amount_msats: quote_bitcoin_amount_to_msats("currency" => amount["currency"], "value" => amount["value"]),
            amount_source: "amount",
            fiat_quote: nil
          }
        else
          quote = quote_fiat_amount({ "currency" => amount["currency"], "value" => amount["value"] }, now)
          { amount_msats: quote.fetch("amount_msats"), amount_source: "fiat", fiat_quote: quote }
        end
      end

      def fiat_from_create_amount(amount)
        return nil unless read_amount_kind(amount) == "currency"
        return nil if bitcoin_amount_currency?(amount["currency"])

        { "currency" => amount["currency"], "value" => amount["value"] }
      end

      def bitcoin_amount_currency?(currency)
        %w[BTC SAT SATS].include?(currency.to_s.upcase)
      end

      def quote_bitcoin_amount_to_msats(btc)
        currency = btc["currency"].to_s.upcase
        value = OpenReceive::Money.parse_decimal(btc["value"])

        case currency
        when "BTC"
          sats_decimal = value * SATS_PER_BTC
          raise ValidationError, "BTC amount cannot be more precise than satoshis." unless sats_decimal.frac.zero?

          amount_sats = sats_decimal.to_i
        when "SAT", "SATS"
          raise ValidationError, "SATS amount must be a whole number of satoshis." unless value.frac.zero?

          amount_sats = value.to_i
        else
          raise ValidationError, "amount.currency must be BTC, SAT, or SATS. Use fiat for price-feed currencies."
        end

        amount_msats = amount_sats * MSATS_PER_SAT
        unless amount_sats >= 1 &&
               amount_msats >= OpenReceive::MIN_AMOUNT_MSATS &&
               amount_msats <= OpenReceive::MAX_AMOUNT_MSATS
          raise ValidationError, "amount is outside the supported v0.1 range."
        end

        amount_msats
      rescue ArgumentError => e
        raise ValidationError, e.message
      end

      def quote_fiat_amount(fiat, now)
        raise NotImplementedError, price_feed_not_implemented_message if @price_provider.nil?

        currency = fiat.fetch("currency")
        price = btc_fiat_price_for(currency)
        amount_sats = OpenReceive::Money.quote_fiat_to_sats(fiat_value: fiat.fetch("value"), btc_fiat_price: price)
        amount_msats = amount_sats * MSATS_PER_SAT
        as_of = now

        {
          "fiat" => { "currency" => currency, "value" => fiat.fetch("value") },
          "btc_fiat_price" => price.to_s,
          "amount_sats" => amount_sats,
          "amount_msats" => amount_msats,
          "source" => price_provider_source,
          "as_of" => as_of,
          "expires_at" => as_of + QUOTE_TTL_SECONDS
        }
      end

      def btc_fiat_price_for(currency)
        raise NotImplementedError, price_feed_not_implemented_message if @price_provider.nil?

        price =
          if @price_provider.respond_to?(:btc_fiat_price)
            @price_provider.btc_fiat_price(currency)
          elsif @price_provider.respond_to?(:get_btc_fiat_rates)
            rates = stringify_keys(@price_provider.get_btc_fiat_rates([currency]))
            rates[currency] || rates[currency.downcase] || rates[currency.upcase]
          else
            raise NotImplementedError,
                  "price_provider must respond to btc_fiat_price(currency) or get_btc_fiat_rates(currencies)."
          end
        raise ValidationError, "price provider did not return a price for #{currency}." if price.nil?

        price
      end

      def price_provider_source
        @price_provider.respond_to?(:source) ? @price_provider.source : "injected"
      end

      # --- sweep internals -----------------------------------------------------------------------

      def apply_transaction(record, transaction)
        invoice_id = record.fetch("invoice_id")
        if OpenReceive::Settlement.settled?(transaction)
          settled_at = optional_integer(transaction["settled_at"]) || now
          @store.mark_settled(invoice_id: invoice_id, settled_at: settled_at)
          run_settlement_action(invoice_id, transaction)
          log(:info, "invoice.settled", invoice_id)
          :settled
        elsif OpenReceive::Settlement.expired?(transaction)
          @store.mark_expired_closed(invoice_id: invoice_id)
          log(:info, "invoice.expired", invoice_id)
          :expired
        elsif OpenReceive::Settlement.failed?(transaction)
          @store.mark_failed_closed(invoice_id: invoice_id)
          :failed
        else
          @store.mark_verifying(invoice_id: invoice_id)
          :pending
        end
      end

      # After backend-verified settlement, complete the settlement action so the row becomes
      # terminal (excluded from later sweeps). Fulfillment hooks (onPaid) can be layered on top by
      # subscribing to the logger; this port keeps the state machine authoritative.
      def run_settlement_action(invoice_id, _transaction)
        @store.mark_settlement_action_completed(invoice_id: invoice_id, settlement_action_completed_at: now)
        log(:info, "invoice.settlement_action_completed", invoice_id)
      rescue StandardError => e
        @store.mark_settlement_action_failed(invoice_id: invoice_id) if @store.respond_to?(:mark_settlement_action_failed)
        log(:warn, "invoice.settlement_action_failed", e.message)
      end

      def find_transaction_record(transaction)
        if present?(transaction["payment_hash"])
          by_hash = @store.find_by_payment_hash(transaction["payment_hash"])
          return by_hash unless by_hash.nil?
        end
        return @store.find_by_bolt11_invoice(transaction["invoice"]) if present?(transaction["invoice"])

        nil
      end

      def terminal_row?(row)
        InMemoryInvoiceStore::TERMINAL_WORKFLOW_STATES.include?(row["workflow_state"])
      end

      def claim_transaction_scan_gate(current, open)
        interval = transaction_scan_gate_interval(open, current)
        6.times do
          meta = @store.get_meta(TRANSACTION_SCAN_GATE_META_KEY)
          unless meta.nil?
            claimed_at = parse_claimed_at(meta["value"])
            return false if !claimed_at.nil? && (current - claimed_at) < interval
          end

          result = @store.cas_meta(
            key: TRANSACTION_SCAN_GATE_META_KEY,
            value: JSON.generate("claimed_at" => current),
            expected_rev: meta && meta["rev"]
          )
          return true if result["status"] == "ok"
        end
        false
      end

      def transaction_scan_gate_interval(open, current)
        invoice_delay = open.map { |row| next_invoice_lookup_delay(current - integer(row["created_at"])) }.min
        [MIN_TRANSACTION_SCAN_INTERVAL_SECONDS, invoice_delay].max
      end

      def next_invoice_lookup_delay(elapsed)
        elapsed = 0 if elapsed.negative?
        return 2 if elapsed < 120
        return 6 if elapsed < 300

        12
      end

      def read_transaction_scan_cursor
        meta = @store.get_meta(TRANSACTION_SCAN_CURSOR_META_KEY)
        return { "until_cursor" => nil, "last_swept_at" => 0 } if meta.nil?

        parsed = parse_json(meta["value"])
        return { "until_cursor" => nil, "last_swept_at" => 0 } unless parsed.is_a?(Hash)

        until_cursor = parsed["until_cursor"]
        last_swept_at = parsed["last_swept_at"]
        {
          "until_cursor" => until_cursor.is_a?(Integer) && until_cursor >= 0 ? until_cursor : nil,
          "last_swept_at" => last_swept_at.is_a?(Integer) && last_swept_at >= 0 ? last_swept_at : 0
        }
      end

      def write_transaction_scan_cursor(cursor)
        6.times do
          current = @store.get_meta(TRANSACTION_SCAN_CURSOR_META_KEY)
          result = @store.cas_meta(
            key: TRANSACTION_SCAN_CURSOR_META_KEY,
            value: JSON.generate(cursor),
            expected_rev: current && current["rev"]
          )
          return if result["status"] == "ok"
        end
      end

      def next_transaction_scan_until(transactions, limit, until_cursor, current)
        return current if transactions.length < limit

        created = transactions.map { |transaction| transaction["created_at"] }
                              .select { |value| value.is_a?(Integer) && value >= 0 }
        next_until = created.empty? ? until_cursor - 1 : created.min
        next_until = until_cursor - 1 if next_until >= until_cursor
        [0, next_until].max
      end

      def parse_claimed_at(value)
        parsed = parse_json(value)
        return parsed["claimed_at"] if parsed.is_a?(Hash) && parsed["claimed_at"].is_a?(Integer)
        return value.to_i if value.to_s.match?(/\A-?\d+\z/)

        nil
      end

      def sweep_result(scanned, settled, expired, swept:, page_count: 0, reason: nil)
        result = {
          "scanned" => scanned,
          "settled" => settled,
          "expired" => expired,
          "swept" => swept,
          "page_count" => page_count
        }
        result["reason"] = reason unless reason.nil?
        result
      end

      # --- request normalization -----------------------------------------------------------------

      def normalize_create_checkout_request(request)
        body = stringify_keys(request)
        order_id = optional_string(body["order_id"] || body["orderId"])
        raise ValidationError, "order_id is required." if order_id.nil?
        raise ValidationError, "order_id must be 200 characters or fewer." if order_id.length > 200

        amount = normalize_create_checkout_amount(body)
        memo = optional_string(body["memo"])
        description_hash = optional_string(body["description_hash"] || body["descriptionHash"])
        metadata = optional_record(body["metadata"], "metadata")

        result = { "order_id" => order_id, "amount" => amount }
        result["memo"] = memo unless memo.nil?
        result["description_hash"] = description_hash unless description_hash.nil?
        result["metadata"] = metadata unless metadata.nil?
        result
      end

      def normalize_create_checkout_amount(body)
        if body.key?("usd") || body.key?("sats")
          raise ValidationError,
                "Create checkout request no longer accepts top-level usd or sats; " \
                "use amount: { currency, value } or amount: { sats }."
        end

        raise ValidationError,
              "Create checkout request requires amount: { sats } or amount: { currency, value }." unless body.key?("amount") && !body["amount"].nil?

        amount = deep_stringify(body["amount"])
        kind = read_amount_kind(amount)
        if kind == "sats"
          return { "sats" => normalize_sats_value(amount["sats"]) }
        end

        currency = optional_string(amount["currency"])
        value = optional_string(amount["value"])
        if currency.nil? || value.nil?
          raise ValidationError, "Create checkout amount must be { sats } or { currency, value }."
        end

        if bitcoin_amount_currency?(currency)
          return { "currency" => currency.upcase, "value" => value }
        end

        unless currency.match?(/\A[A-Z]{3}\z/)
          raise ValidationError, "amount.currency must be an ISO 4217 uppercase code, or BTC/SAT/SATS."
        end
        if !value.match?(/\A[0-9]+(?:\.[0-9]+)?\z/) || value.match?(/\A0+(?:\.0+)?\z/)
          raise ValidationError, "amount.value must be a positive decimal string."
        end

        { "currency" => currency, "value" => value }
      end

      def read_amount_kind(amount)
        raise ValidationError, "Create checkout amount must be { sats } or { currency, value }." unless amount.is_a?(Hash)

        keys = amount.keys.map(&:to_s)
        unsupported = keys - %w[sats currency value]
        has_sats = amount.key?("sats") && !amount["sats"].nil?
        has_currency = amount.key?("currency") && !amount["currency"].nil?
        has_value = amount.key?("value") && !amount["value"].nil?

        if !unsupported.empty?
          raise ValidationError, "Create checkout amount must be { sats } or { currency, value }."
        end

        if has_sats && !has_currency && !has_value
          return "sats"
        end

        if !has_sats && has_currency && has_value
          return "currency"
        end

        raise ValidationError, "Create checkout amount must be { sats } or { currency, value }."
      end

      def normalize_sats_value(value)
        if value.is_a?(Integer)
          raise ValidationError, "sats must be a positive integer." unless value.positive?

          return value.to_s
        end
        return value if value.is_a?(String) && value.match?(/\A[0-9]+\z/) && value.to_i.positive?

        raise ValidationError, "sats must be a positive integer."
      end

      def amount_key_from(amount)
        kind = read_amount_kind(amount)
        if kind == "sats"
          "btc:SATS:#{normalize_sats_value(amount['sats'])}"
        elsif bitcoin_amount_currency?(amount["currency"])
          "btc:#{amount['currency']}:#{amount['value']}"
        else
          "fiat:#{amount['currency']}:#{amount['value']}"
        end
      end

      def description_fields(input)
        memo = input["memo"]
        description_hash = input["description_hash"]

        raise ValidationError, "memo must be 500 characters or fewer." if present?(memo) && memo.length > 500
        if present?(memo) && present?(description_hash)
          raise ValidationError, "Create checkout request accepts only one of memo or description_hash."
        end
        if present?(description_hash) && !OpenReceive::HEX_64_PATTERN.match?(description_hash)
          raise ValidationError, "description_hash must be 64 hex characters."
        end

        fields = {}
        fields["description"] = memo if present?(memo)
        fields["description_hash"] = description_hash if present?(description_hash)
        fields
      end

      def parse_fiat_amount(value)
        record = optional_record(value, "fiat")
        raise ValidationError, "fiat must be a JSON object." if record.nil?

        currency = optional_string(record["currency"])
        amount_value = optional_string(record["value"])
        raise ValidationError, "fiat.currency must be an ISO 4217 uppercase code." if currency.nil? || !currency.match?(/\A[A-Z]{3}\z/)
        raise ValidationError, "fiat.value must be a decimal string." if amount_value.nil?

        { "currency" => currency, "value" => amount_value }
      end

      # --- shared helpers ------------------------------------------------------------------------

      def wrap_nwc(client)
        return client if client.is_a?(OpenReceive::NwcRubyReceiveClient)

        OpenReceive::NwcRubyReceiveClient.new(client: client)
      end

      def swap_not_implemented_message
        "Swaps are not implemented in openreceive-server yet (scaffold). " \
          "The Node engine is the reference implementation for swaps."
      end

      def price_feed_not_implemented_message
        "Live price feeds are not implemented in openreceive-server (scaffold). " \
          "Inject a price_provider (responding to btc_fiat_price(currency)) or use the Node engine."
      end

      def log(level, event, message)
        return if @logger.nil?

        if @logger.respond_to?(level)
          @logger.public_send(level, "openreceive.#{event}: #{message}")
        elsif @logger.respond_to?(:call)
          @logger.call(level: level, event: event, message: message)
        end
      rescue StandardError
        nil
      end

      def now
        Integer(@clock.call)
      end

      def generate_invoice_id
        "or_inv_#{SecureRandom.hex(16)}"
      end

      def generate_checkout_id
        "or_chk_#{SecureRandom.hex(16)}"
      end

      def normalize_currencies(value)
        list =
          case value
          when nil then nil
          when String then value.split(",")
          when Array then value
          else return nil
          end
        return nil if list.nil?

        normalized = list.map { |item| item.to_s.strip.upcase }.reject(&:empty?).uniq
        normalized.empty? ? nil : normalized
      end

      def stringify_keys(value)
        return {} unless value.respond_to?(:each_pair)

        value.each_pair.each_with_object({}) { |(key, item), result| result[key.to_s] = item }
      end

      def deep_stringify(value)
        case value
        when Hash
          value.each_with_object({}) { |(key, item), result| result[key.to_s] = deep_stringify(item) }
        when Array
          value.map { |item| deep_stringify(item) }
        else
          value
        end
      end

      def deep_dup(value)
        case value
        when Hash then value.each_with_object({}) { |(key, item), result| result[key] = deep_dup(item) }
        when Array then value.map { |item| deep_dup(item) }
        else value
        end
      end

      def optional_string(value)
        value.is_a?(String) && !value.empty? ? value : nil
      end

      def optional_record(value, field)
        return nil if value.nil?
        raise ValidationError, "#{field} must be a JSON object." unless value.is_a?(Hash)

        stringify_keys(value)
      end

      def optional_integer(value)
        return nil if value.nil?

        Integer(value)
      rescue ArgumentError, TypeError
        nil
      end

      def integer(value)
        Integer(value)
      rescue ArgumentError, TypeError
        raise ArgumentError, "expected integer"
      end

      def parse_json(value)
        JSON.parse(value.to_s)
      rescue JSON::ParserError
        nil
      end

      def present?(value)
        !value.nil? && value != ""
      end

      def blank?(value)
        value.nil? || value.to_s.strip.empty?
      end
    end
  end
end
