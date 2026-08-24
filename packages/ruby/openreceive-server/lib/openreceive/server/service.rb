# frozen_string_literal: true

require "openreceive"
require "openreceive/server/errors"
require "openreceive/server/wallet_info"

module OpenReceive
  module Server
    class Service
      PAGE_LIMIT = OpenReceive::TRANSACTION_PAGE_LIMIT
      # Upper bound on wallet history pages per scan (mirrors JS maxPages): a
      # wallet/relay that keeps returning full pages must not hang the scan.
      MAX_PAGES = 10_000
      INVOICE_EXPIRY_SECONDS = 600
      # Default shadow-invoice expiry when a swap provider does not report its
      # own (mirrors the JS default).
      SWAP_INVOICE_EXPIRY_SECONDS = 600
      # Maximum seconds the wallet's returned expiry may deviate from the
      # requested expiry before checkout creation fails closed.
      INVOICE_EXPIRY_TOLERANCE_SECONDS = 60

      # NIP-47 method names that let a connection move funds out of the wallet
      # (mirrors the JS preflight, including the keysend variants). Preflight
      # compares against already-normalized names from WalletInfo.summarize.
      SPEND_METHODS = WalletInfo::SPEND_METHODS

      attr_reader :price_currencies

      # `swap_providers: nil` (the default) auto-builds FixedFloat-compatible
      # providers from LSC_URI_PRIMARY / LSC_URI_BACKUP, exactly like the JS
      # createOpenReceive. Pass an explicit array (possibly empty) to override.
      # `price_provider: nil` (the default) uses the built-in cached live
      # price feed (with OPENRECEIVE_PRICE_FEED_*_URL overrides), mirroring
      # the JS default; pass a provider to override, or `false` to run
      # without rates entirely (the JS `priceProviders: []`): fiat amounts
      # and GET /rates then fail with their not-configured errors.
      # `logger:` is an optional standard Logger-shaped sink (debug/info/
      # warn/error) for operational events such as swap-provider API calls.
      def initialize(nwc_client:, price_provider: nil, swap_providers: nil, price_currencies: ["USD"],
                     clock: -> { Time.now.to_i }, allow_spend_capable_wallet: false, env: ENV,
                     logger: nil)
        @nwc = nwc_client
        @clock = clock
        @env = env
        @logger = logger
        @price_currencies = Array(price_currencies || ["USD"]).map { |value| value.to_s.upcase }
        @price_provider = price_provider == false ? nil : price_provider || default_price_provider(env)
        @swap_providers =
          if swap_providers.nil?
            Swap.providers_from_environment(env, now: @clock)
          else
            Array(swap_providers)
          end
        attach_swap_provider_runtime!
        # The override relaxes only the spend refusal: receive-readiness and
        # encryption are still enforced, exactly as in the JS preflight.
        wallet_preflight!(
          allow_spend_capable: allow_spend_capable_wallet || spend_override_from_env?
        )
      end

      def prepare_checkout(input)
        validating_input do
          data = stringify(input)
          amount_msats, fiat_quote = resolve_amount(data.fetch("amount"))
          {
            "amount_msats" => amount_msats,
            "fiat_quote" => fiat_quote,
            "payment_methods" => list_swap_options(amount_msats: amount_msats)
          }
        end
      end

      # Amount-aware swap pay-in options for the shared browser widget
      # (mirrors the JS service listSwapOptions + resolveSwapProviderCatalog):
      # exactly one live provider's catalog — primary when healthy, otherwise
      # the first backup that answers — mapped over the full OpenReceive asset
      # list with amount-vs-limit availability.
      def list_swap_options(amount_msats:)
        return [] if @swap_providers.empty?

        normalized_amount = normalize_swap_amount_msats(amount_msats)
        catalog = resolve_swap_provider_catalog
        # Providers ARE configured (checked above), so an empty catalog means
        # every one of them failed its fetch — an outage, not a configuration
        # gap. Mirrors the JS listSwapOptions ruling.
        catalog_unreachable = catalog.empty?
        Swap::Assets.list_info.map do |asset|
          swap_catalog_option(
            asset, normalized_amount, catalog[asset.fetch("pay_in_asset")],
            catalog_unreachable: catalog_unreachable
          )
        end
      end

      def create_checkout(input)
        # Payer-input validation only: once the wallet has minted, a parse
        # failure is the wallet's response violating the receive contract, not
        # a 400 the payer caused — so this rescue must not cover the wallet
        # call or its normalization.
        reference, expiry, required_expiry, fiat_quote, request = validating_input do
          data = stringify(input)
          reference = required_string(data["reference"], "reference")
          amount_msats, fiat_quote = resolve_amount(data.fetch("amount"))
          # A caller-supplied expiry_seconds is a FLOOR (only the swap path sets
          # it); the library default is a request the wallet may clamp.
          required_expiry = !data["expiry_seconds"].nil?
          expiry = Integer(data["expiry_seconds"] || INVOICE_EXPIRY_SECONDS)
          metadata = stringify(data["metadata"] || {}).merge("reference" => reference)
          # NIP-47 caps invoice metadata; reject before any wallet call with
          # the JS service's exact message instead of surfacing the wallet
          # client's own failure as a 502.
          if JSON.generate(metadata).bytesize > OpenReceive::NWC_METADATA_MAX_BYTES
            raise ValidationError, "metadata is too large for NIP-47."
          end
          request = {
            "amount_msats" => amount_msats,
            "expiry" => expiry,
            "metadata" => metadata
          }
          request["description"] = data["memo"] if data["memo"]
          request["description_hash"] = data["description_hash"] if data["description_hash"]
          [reference, expiry, required_expiry, fiat_quote, request]
        end
        response = call_nwc(:make_invoice, request)
        begin
          wallet = OpenReceive.normalize_make_invoice_response(response)
          created_at = wallet["created_at"] || @clock.call
          # The ledger row stores the wallet's OWN expires_at, so reuse
          # buffering, reconciliation, and the expiry+grace close rule all stay
          # consistent with the real invoice even when the wallet clamps expiry
          # to its own min/max. A deviation is therefore a warning on the plain
          # checkout path — refusing would lock every such wallet out entirely.
          #
          # A caller-supplied expiry is a FLOOR: only the swap path sets one,
          # because the shadow invoice must outlive the provider order. A short
          # invoice fails there. Mirrors the JS create_checkout ruling.
          requested_expires_at = created_at + expiry
          expires_at = wallet["expires_at"] || requested_expires_at
          shortfall = requested_expires_at - expires_at
          if (expires_at - requested_expires_at).abs > INVOICE_EXPIRY_TOLERANCE_SECONDS
            # The detailed diagnostic is logged, never sent: the wire carries
            # the same short form as the JS service.
            if required_expiry && shortfall > INVOICE_EXPIRY_TOLERANCE_SECONDS
              @logger&.error(
                "checkout.invoice_expiry.rejected: The wallet did not honor the " \
                "required invoice expiry (required #{expiry}s, got " \
                "#{expires_at - created_at}s). Use a wallet whose make_invoice honors expiry."
              )
              raise WalletContractError,
                    "Error with the backing NWC wallet: it did not honor the requested invoice expiry."
            end
            @logger&.warn(
              "checkout.invoice_expiry.adjusted: The wallet clamped the requested " \
              "invoice expiry (requested #{expiry}s, got #{expires_at - created_at}s); " \
              "the wallet's own expiry is recorded on the attempt."
            )
          end
          {
            "reference" => reference,
            "payment_hash" => wallet.fetch("payment_hash"),
            "bolt11" => wallet.fetch("invoice"),
            "amount_msats" => wallet.fetch("amount_msats"),
            "created_at" => created_at,
            "expires_at" => expires_at,
            "fiat_quote" => fiat_quote
          }
        rescue KeyError, ArgumentError, TypeError
          # Never blames the payer, and never puts the raw parse failure
          # (`key not found: "invoice"`) on the wire.
          raise WalletContractError
        end
      end

      # Optional bounds for request-path passes: "max_pages" caps each
      # wallet-history walk (the gated opportunistic pass sends 50, mirroring
      # the JS OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES; default MAX_PAGES), and
      # "deadline" is a monotonic-clock instant checked between page fetches —
      # never mid-request — so a slow wallet cannot hang user-facing requests.
      def reconcile_payments(input)
        data = stringify(input)
        attempts = Array(data.fetch("attempts"))
        return [] if attempts.empty?

        expected = attempts.to_h do |attempt|
          row = stringify(attempt)
          [normalize_payment_hash(row.fetch("payment_hash") { row.fetch("paymentHash") }),
           Integer(row.fetch("created_at") { row.fetch("createdAt") })]
        end
        overlap = Integer(data.fetch("overlap_seconds", 60))
        # A negative overlap would SHRINK both window ends instead of padding
        # them, hiding exactly the rows the padding exists to catch. Mirrors
        # the JS reconcilePaymentAttempts guard.
        raise ArgumentError, "overlap_seconds must be a non-negative integer" if overlap.negative?

        from = [expected.values.min - overlap, 0].max
        # Both ends of the window are padded: `from` against a wallet clock
        # that lags, `until` against one that runs ahead — an unpadded `until`
        # on the host clock hides an invoice the wallet just stamped into the
        # future.
        until_time = Integer(data["until"] || (@clock.call + overlap))
        bounds = { max_pages: data["max_pages"], deadline: data["deadline"] }.compact
        settled = scan_incoming_transactions(
          expected: expected.keys, from: from, until_time: until_time, **bounds
        )
        by_hash = settled.fetch(:rows).dup
        missing = expected.keys.reject { |hash| by_hash.key?(hash) }
        truncated = false
        unless missing.empty?
          inclusive = scan_incoming_transactions(
            expected: missing, from: from, until_time: until_time, unpaid: true, **bounds
          )
          truncated = settled.fetch(:truncated) || inclusive.fetch(:truncated)
          inclusive.fetch(:rows).each { |hash, row| by_hash[hash] ||= row }
        end
        # A hash the walk could not decide is OMITTED rather than reported
        # not_found: when the page cap, the pass deadline, or a wallet that
        # ignored `offset` cut the walk short, absence is unproven, and
        # reporting not_found would let a caller close a paid attempt. Omitted
        # hashes are simply retried next pass (mirrors the JS
        # reconcilePaymentAttempts).
        expected.keys.filter_map do |hash|
          if by_hash.key?(hash)
            payment_result(hash, by_hash.fetch(hash))
          elsif !truncated
            { "payment_hash" => hash, "status" => "not_found" }
          end
        end
      end

      def quote_swap(input)
        data = stringify(input)
        asset = parse_pay_in_asset(data["pay_in_asset"])
        amount_msats, = validating_input { resolve_amount(data.fetch("amount")) }
        provider = select_provider(asset)
        quote = stringify(call_provider(provider, :quote,
          "pay_in_asset" => asset, "invoice_amount_msats" => amount_msats))
        {
          "provider" => quote.fetch("provider"),
          "pay_asset" => quote.fetch("pay_asset"),
          "available" => quote.fetch("available"),
          "pay_amount" => quote["pay_amount"],
          "minimum_pay_amount" => quote["minimum_pay_amount"],
          "maximum_pay_amount" => quote["maximum_pay_amount"],
          "minimum_invoice_amount_msats" => quote["minimum_invoice_amount_msats"],
          "maximum_invoice_amount_msats" => quote["maximum_invoice_amount_msats"],
          "unavailable_reason" => quote["unavailable_reason"],
          "unavailable_message" => quote["unavailable_message"]
        }.compact
      end

      def create_swap(input)
        data = stringify(input)
        asset = parse_pay_in_asset(data["pay_in_asset"])
        amount = begin
          data.fetch("amount")
        rescue KeyError => e
          raise ValidationError, e.message
        end
        provider = select_provider(asset)
        expiry = provider.respond_to?(:invoice_expiry_seconds) ? provider.invoice_expiry_seconds(pay_in_asset: asset) : SWAP_INVOICE_EXPIRY_SECONDS
        # The shadow-invoice expiry is provider-mandated: build the checkout
        # input explicitly from validated fields so no payer-supplied key (e.g.
        # "expiry_seconds") can override it or smuggle a different order id.
        checkout = create_checkout(
          "reference" => data["reference"],
          "amount" => amount,
          "memo" => data["memo"],
          "metadata" => data["metadata"],
          "expiry_seconds" => expiry
        )
        order = stringify(call_provider(provider, :create_swap,
          "pay_in_asset" => asset,
          "bolt11" => checkout.fetch("bolt11"),
          "invoice_amount_msats" => checkout.fetch("amount_msats")))
        swap_data = {
          "version" => 1,
          "provider_order" => order.reject { |key, _| key == "raw" }
        }
        public_swap(order, checkout.fetch("payment_hash"), checkout.fetch("reference")).merge(
          "checkout" => checkout,
          "swap_data" => swap_data
        )
      end

      def get_swap(reference:, payment_hash:, swap_data:)
        recovery = normalize_swap_data(swap_data)
        provider_name = recovery.fetch("provider_order").fetch("provider")
        provider = provider_by_name(provider_name)
        current = stringify(call_provider(provider, :get_status, recovery.fetch("provider_order")))
        public_swap(current, normalize_payment_hash(payment_hash), required_string(reference, "reference"))
      rescue KeyError => e
        raise ValidationError, e.message
      end

      def refund_swap(reference:, payment_hash:, swap_data:, refund_address:)
        recovery = normalize_swap_data(swap_data)
        hash = normalize_payment_hash(payment_hash)
        host_reference = required_string(reference, "reference")
        address = normalize_refund_address(
          refund_address, recovery.dig("provider_order", "pay_in_asset")
        )
        provider_name = recovery.fetch("provider_order").fetch("provider")
        provider = provider_by_name(provider_name)
        current = stringify(call_provider(provider, :get_status, recovery.fetch("provider_order")))
        unless current["state"] == "refund_required"
          raise ConflictError, "Swap cannot be refunded from provider state #{current['state']}."
        end
        call_provider(provider, :request_refund, current, address)
        get_swap(reference: host_reference, payment_hash: hash, swap_data: recovery)
      rescue KeyError => e
        raise ValidationError, e.message
      end

      def list_rates(input = {})
        raise NotImplementedHttpError, "No price provider is configured for rates." if @price_provider.nil?
        currencies = Array(stringify(input)["currencies"] || @price_currencies).map { |value| value.to_s.strip.upcase }
        currencies.each do |currency|
          unless /\A[A-Z]{3}\z/.match?(currency)
            # Same message as the JS service's payer currencies path; the wire
            # shape check already fired in the request handler.
            raise ValidationError, "Invalid currencies entry: #{currency}."
          end
          unless @price_currencies.include?(currency)
            raise ValidationError,
                  "fiat.currency must be one of the configured priceCurrencies: " \
                  "#{@price_currencies.join(', ')}."
          end
        end
        { "bitcoin" => currencies.to_h { |currency| [currency.downcase, btc_fiat_price_or_unavailable(currency)] } }
      end

      private

      # EVERY feed-side failure (network, HTTP, malformed or incomplete
      # response) maps to the payer-facing retryable 503, exactly like the JS
      # service's ratesUnavailableError — the feed being unable to price a
      # configured currency is an outage, never payer input.
      def btc_fiat_price_or_unavailable(currency)
        @price_provider.btc_fiat_price(currency).to_s
      rescue ServiceError, ValidationError
        raise
      rescue StandardError
        raise ServiceError.new(
          503, "INTERNAL",
          "Exchange rates are temporarily unavailable — please try again in a moment.",
          retryable: true
        )
      end

      # Fail-closed boot preflight, mirroring the JS client preflight: a
      # connection that can report capabilities must be receive-ready and speak
      # an encryption mode we implement, and — unless the host overrides —
      # must not advertise spend methods.
      #
      # A read failure is NOT treated as transient. Booting blind only defers
      # the failure to the first customer checkout, where it costs a lost sale
      # instead of a loud boot error, so an info method that cannot answer
      # fails the boot.
      def wallet_preflight!(allow_spend_capable:)
        raw_info = read_wallet_info
        # The client exposes no info method at all: there is nothing to
        # preflight, so custom NWC adapters keep booting as before.
        return if raw_info.nil?

        summary = WalletInfo.summarize(raw_info)
        unless summary.fetch("receive_checkout_ready")
          raise WalletPreflightError,
                "the wallet does not advertise make_invoice and list_transactions."
        end
        if summary.fetch("encryption").nil?
          raise WalletPreflightError,
                "the wallet supports no encryption mode OpenReceive speaks (NIP-04 or NIP-44 v2)."
        end
        return if allow_spend_capable

        spend = summary.fetch("methods").select { |method| SPEND_METHODS.include?(method) }
        raise SpendCapableWalletError, spend unless spend.empty?
      end

      def read_wallet_info
        if @nwc.respond_to?(:preflight)
          @nwc.preflight
        elsif @nwc.respond_to?(:get_info)
          @nwc.get_info
        elsif @nwc.respond_to?(:getInfo)
          @nwc.getInfo
        elsif @nwc.respond_to?(:get_wallet_service_info)
          @nwc.get_wallet_service_info
        elsif @nwc.respond_to?(:getWalletServiceInfo)
          @nwc.getWalletServiceInfo
        end
      rescue OpenReceive::NwcUriParseError
        # A malformed connection string is a config error in its own right;
        # surface it as itself rather than as a preflight failure.
        raise
      rescue StandardError => e
        raise WalletPreflightError, "could not read wallet info (#{e.class}: #{e.message})."
      end

      def spend_override_from_env?
        raw = @env["OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC"].to_s.strip.downcase
        return false if raw.empty?
        return true if %w[1 true yes].include?(raw)
        unless %w[0 false no].include?(raw)
          # Fail closed (no override), but never silently: a typo like "truee"
          # must not read as "unset".
          warn "[openreceive] Unrecognized OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC value " \
               "#{raw.inspect}; treating it as disabled. Use 1/true/yes to enable."
        end
        false
      end

      def normalize_swap_data(value)
        data = stringify(value)
        unless data["version"] == 1 && data["provider_order"].is_a?(Hash) &&
               !data.dig("provider_order", "provider").to_s.empty? &&
               !data.dig("provider_order", "provider_order_id").to_s.empty?
          # Same wire message as the JS service's readSwapData.
          raise ValidationError, "swapData is invalid."
        end
        data
      end

      def parse_pay_in_asset(value)
        unless Swap::Assets.pay_in_asset?(value)
          raise ValidationError, "payInAsset is not supported."
        end
        value
      end

      # Mirrors the JS service's normalizeAmountMsats: Lightning invoices are
      # whole sats; round up so catalog limits match create.
      def normalize_swap_amount_msats(value)
        amount = begin
          Integer(value)
        rescue ArgumentError, TypeError
          nil
        end
        if amount.nil? || amount < 1000
          raise ValidationError, "amountMsats must be an integer >= 1000."
        end
        ((amount + 999) / 1000) * 1000
      end

      # Fiat pricing defaults to the LIVE feed with env URL overrides, exactly
      # like the JS createOpenReceive default (there is deliberately no
      # implicit static-mock fallback).
      def default_price_provider(env)
        overrides = OpenReceive::Rates.read_price_feed_url_overrides(env)
        OpenReceive::Rates.create_cached_live_price_feed(
          currencies: @price_currencies,
          clock: @clock,
          primary_url: overrides[:primary_url],
          fallback_url: overrides[:fallback_url]
        )
      end

      # Mirrors the JS createOpenReceive provider wiring: one shared transient
      # cache and one per-provider weight budget, attached to every provider
      # that supports them (host-supplied or auto-built).
      def attach_swap_provider_runtime!
        return if @swap_providers.empty?

        cache = Swap::TransientSwapCache.new(@clock)
        @swap_providers.each do |provider|
          provider.attach_swap_cache(cache) if provider.respond_to?(:attach_swap_cache)
          if provider.respond_to?(:attach_weight_budget)
            provider.attach_weight_budget(
              Swap::SwapProviderWeightBudget.new(provider.name, @clock)
            )
          end
        end
      end

      # Use exactly one live provider's catalog: primary when healthy,
      # otherwise the first backup that answers. Never merge catalogs.
      def resolve_swap_provider_catalog
        @swap_providers.each do |provider|
          begin
            catalog =
              if provider.respond_to?(:pay_in_asset_catalog)
                Array(call_provider(provider, :pay_in_asset_catalog))
              else
                Array(call_provider(provider, :supported_pay_in_assets)).map do |asset|
                  { "pay_asset" => asset.to_s }
                end
              end
          rescue StandardError
            # Catalog/rates feed down for this provider — try the next entry.
            next
          end
          by_asset = {}
          catalog.each do |item|
            row = stringify(item)
            by_asset[row["pay_asset"]] = row.merge("provider" => provider.name)
          end
          return by_asset
        end
        {}
      end

      # `catalog_unreachable` separates a transient provider outage from a
      # configuration gap. It matters because the unavailable label is cached
      # per amount for up to 60s: telling a payer "not configured" during a
      # provider blip outlasts the blip.
      def swap_catalog_option(asset, amount_msats, provider_asset, catalog_unreachable: false)
        if provider_asset.nil?
          reason, message =
            if catalog_unreachable
              ["provider_unreachable", "The swap provider is temporarily unreachable."]
            else
              ["provider_unconfigured", "Automated swaps are not configured for this asset."]
            end
          return {
            "pay_in_asset" => asset.fetch("pay_in_asset"),
            "label" => asset.fetch("label"),
            "network_label" => asset.fetch("network_label"),
            "provider" => "",
            "available" => false,
            "unavailable_reason" => reason,
            "unavailable_message" => message
          }
        end

        minimum_msats = provider_asset["minimum_invoice_amount_msats"]
        maximum_msats = provider_asset["maximum_invoice_amount_msats"]
        limit_reason =
          if amount_msats.positive? && !minimum_msats.nil? && amount_msats < minimum_msats
            "amount_too_small"
          elsif amount_msats.positive? && !maximum_msats.nil? && amount_msats > maximum_msats
            "amount_too_large"
          end
        unavailable_reason =
          limit_reason ||
          (provider_asset["available"] == false ? provider_asset["unavailable_reason"] : nil)
        unavailable_message =
          case limit_reason
          when "amount_too_small" then "This invoice is below the provider minimum."
          when "amount_too_large" then "This invoice is above the provider maximum."
          else
            provider_asset["available"] == false ? provider_asset["unavailable_message"] : nil
          end

        option = {
          "pay_in_asset" => asset.fetch("pay_in_asset"),
          "label" => asset.fetch("label"),
          "network_label" => asset.fetch("network_label"),
          "provider" => provider_asset.fetch("provider"),
          "available" => unavailable_reason.nil? && provider_asset["available"] != false
        }
        option["unavailable_reason"] = unavailable_reason unless unavailable_reason.nil?
        option["unavailable_message"] = unavailable_message unless unavailable_message.nil?
        unless provider_asset["minimum_pay_amount"].nil?
          option["minimum_pay_amount"] = provider_asset["minimum_pay_amount"]
        end
        unless provider_asset["maximum_pay_amount"].nil?
          option["maximum_pay_amount"] = provider_asset["maximum_pay_amount"]
        end
        option["minimum_invoice_amount_msats"] = minimum_msats unless minimum_msats.nil?
        option["maximum_invoice_amount_msats"] = maximum_msats unless maximum_msats.nil?
        option
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
        unless @price_currencies.include?(currency)
          raise ValidationError,
                "fiat.currency must be one of the configured priceCurrencies: " \
                "#{@price_currencies.join(', ')}."
        end
        price = btc_fiat_price_or_unavailable(currency)
        msats = OpenReceive.quote_fiat_to_msats(fiat_value: value, btc_fiat_price: price)
        [msats, { "fiat" => { "currency" => currency, "value" => value }, "btc_fiat_price" => price, "amount_msats" => msats, "as_of" => @clock.call }]
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

      # Adapts call_nwc to the shared core walk's client contract and enforces
      # the request-path deadline: checked only between page fetches, never
      # mid-request, so a slow wallet bounds the scan instead of interrupting
      # work already in flight. Once the monotonic deadline passes, the
      # previous page is replayed instead of fetching another — the core walk
      # recognizes the repeat and ends the scan marked truncated, so a
      # deadline-cut walk can never prove an invoice absent.
      class ScanClient
        def initialize(service, deadline)
          @service = service
          @deadline = deadline
          @previous = nil
        end

        def list_transactions(request)
          if @previous && @deadline &&
             Process.clock_gettime(Process::CLOCK_MONOTONIC) >= @deadline
            return @previous
          end
          @previous = @service.send(:call_nwc, :list_transactions, request)
        end
      end
      private_constant :ScanClient

      # One wallet-history walk through the shared core scan (the JS
      # listIncomingTransactions port): bounded like the JS scan, so a wallet
      # that keeps returning full pages must not hang payments/check, swap
      # creation, or reconciliation. Returns { rows:, truncated: }.
      def scan_incoming_transactions(expected:, from:, until_time:, unpaid: false, max_pages: nil, deadline: nil)
        OpenReceive.list_incoming_transactions(
          client: ScanClient.new(self, deadline),
          expected: expected,
          from: from,
          until_time: until_time,
          max_pages: max_pages || MAX_PAGES,
          include_unpaid: unpaid
        )
      end

      # A refund is the last chance to recover a mis-sent deposit, so the
      # address is checked against the order's own pay-in network with its
      # checksum — a false accept here sends the payer's money somewhere
      # unrecoverable. Mirrors the JS normalizeRefundAddress exactly.
      def normalize_refund_address(value, pay_in_asset)
        normalized = value.to_s.strip
        if normalized.empty? || normalized.length > 300
          raise ValidationError, "refundAddress is invalid."
        end
        if pay_in_asset.is_a?(String) &&
           !OpenReceive::SwapAddress.valid_for_pay_in_asset?(pay_in_asset, normalized)
          raise ValidationError, "refundAddress is not a valid #{pay_in_asset} address."
        end
        normalized
      end

      def select_provider(asset)
        # Primary-only while healthy. Backup is consulted only when primary is
        # down (raises), never to fill gaps for assets the primary simply does
        # not list. Status/code/message mirror the JS selectProvider exactly.
        @swap_providers.each do |provider|
          begin
            supported = call_provider(provider, :supported_pay_in_assets)
            return provider if Array(supported).include?(asset)

            # Healthy provider that omits this asset — do not fall through.
            raise unsupported_swap_asset_error(asset)
          rescue ServiceError
            raise
          rescue StandardError
            # Provider request failed — try the next configured LSC connection.
            next
          end
        end
        raise unsupported_swap_asset_error(asset)
      end

      def unsupported_swap_asset_error(asset)
        ServiceError.new(503, "INTERNAL", "No configured swap provider supports #{asset}.")
      end

      def provider_by_name(name)
        @swap_providers.find { |provider| provider.name == name } ||
          raise(ServiceError.new(503, "INTERNAL", "Swap provider #{name} is not configured."))
      end

      def public_swap(order, hash, reference)
        {
          "payment_hash" => hash,
          "reference" => reference,
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
          "attention" => order["attention"],
          # Everything below explains the attempt to the payer: why they send
          # more than the cart total, what actually landed on the deposit, and
          # why an attempt needs an operator. `provider_token` stays server-only.
          "attention_reason" => order["attention_reason"],
          "deposit_received_amount" => order["deposit_received_amount"],
          "emergency_repeat" => order["emergency_repeat"],
          "provider_order_id" => order["provider_order_id"],
          "fee" => order["fee"]
        }.compact
      end

      # Positional-vs-keyword dispatch is decided from Method#parameters, never
      # by rescuing ArgumentError and calling again: a retry after an
      # ArgumentError raised INSIDE a state-changing RPC (make_invoice,
      # create_swap) would invoke it a second time — two invoices for one
      # attempt. Wallet failures normalize to the shared error vocabulary.
      def call_nwc(method, input)
        if keyword_style?(@nwc.method(method))
          @nwc.public_send(method, **input.transform_keys(&:to_sym))
        else
          @nwc.public_send(method, input)
        end
      rescue ValidationError, WalletContractError, NotImplementedHttpError
        raise
      rescue StandardError => e
        raise WalletFailureError, OpenReceive::Nwc.normalize_wallet_error(e)
      end

      def call_provider(provider, method, *args)
        if args.length == 1 && args.first.is_a?(Hash) && keyword_style?(provider.method(method))
          provider.public_send(method, **args.first.transform_keys(&:to_sym))
        else
          provider.public_send(method, *args)
        end
      end

      def keyword_style?(callable)
        parameters = callable.parameters
        return false if parameters.any? { |type, _| %i[req opt rest].include?(type) }
        parameters.any? { |type, _| %i[keyreq key keyrest].include?(type) }
      rescue NameError
        false
      end

      def stringify(value)
        OpenReceive.stringify(value)
      end

      # The payer-input parse boundary: a missing field (KeyError) or a
      # malformed one (ArgumentError) inside the block is a 400, not a 500.
      # Wrap only the parse — a wallet or provider call that raises the same
      # classes is not the payer's fault and must stay outside the block.
      def validating_input
        yield
      rescue KeyError, ArgumentError => e
        raise ValidationError, e.message
      end

      # Same message as the JS service's requests.ts ("reference is required."),
      # trailing period included: a direct-service caller sees identical text on
      # both engines, not only through the handler (whose own `required` check
      # fires first on the mounted routes).
      def required_string(value, field)
        text = value.to_s.strip
        raise ValidationError, "#{field} is required." if text.empty?
        text
      end

      def normalize_payment_hash(value)
        hash = required_string(value, "payment_hash").downcase
        raise ValidationError, "payment_hash must be 64 hexadecimal characters" unless /\A[0-9a-f]{64}\z/.match?(hash)
        hash
      end
    end
  end
end
