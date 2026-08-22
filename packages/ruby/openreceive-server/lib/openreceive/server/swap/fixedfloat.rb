# frozen_string_literal: true

require "json"
require "openssl"
require "openreceive"
require "openreceive/server/swap/assets"
require "openreceive/server/swap/rates_feed"
require "openreceive/server/swap/transient_cache"
require "openreceive/server/swap/weight_budget"

module OpenReceive
  module Server
    module Swap
      # Ruby port of the FixedFloatApiError from
      # packages/js/node/src/swap/fixedfloat.ts. Deliberately does NOT expose
      # #status/#code: the request handler duck-types those for wire mapping,
      # and a provider failure must reach the payer as the redacted 500
      # "Internal server error." exactly like the JS engine.
      class FixedFloatApiError < StandardError
        KINDS = %w[api http invalid_json network rate_limited timeout].freeze

        attr_reader :path, :kind, :http_status, :fixedfloat_code, :fixedfloat_message

        def initialize(path:, kind:, message:, http_status: nil, fixedfloat_code: nil,
                       fixedfloat_message: nil)
          super(message)
          @path = path
          @kind = kind
          @http_status = http_status
          @fixedfloat_code = fixedfloat_code
          @fixedfloat_message = fixedfloat_message
        end

        def self.from_transport_error(path, error)
          aborted = Swap.timeout_error?(error)
          new(
            path: path,
            kind: aborted ? "timeout" : "network",
            message: aborted ? "FixedFloat #{path} request timed out."
                             : "FixedFloat #{path} request failed before a response was received."
          )
        end
      end

      # Ruby port of packages/js/node/src/swap/fixedfloat.ts: the production
      # FixedFloat(-compatible) swap provider. HMAC-signed API calls over an
      # injectable HTTP transport, quote/create/status/refund flows, and the
      # same order/state normalization as the JS engine.
      #
      # Orders are plain string-keyed hashes with the JS SwapOrder field names
      # (provider, provider_order_id, provider_token, pay_in_asset,
      # deposit_address, deposit_amount, expires_at, state, ...).
      class FixedFloatProvider
        DEFAULT_BASE_URL = "https://ff.io"
        DEFAULT_CCIES_CACHE_SECONDS = 24 * 60 * 60
        DEFAULT_RATES_CACHE_SECONDS = FixedFloatRates::REFRESH_SECONDS
        DEFAULT_REQUEST_TIMEOUT_MS = 10_000
        DEFAULT_DEPOSIT_WINDOW_SECONDS = 10 * 60
        DEFAULT_SETTLEMENT_SLA_SECONDS = 15 * 60
        # Margin above deposit_window + settlement_sla. Five minutes keeps the
        # shadow invoice alive through a plausible 30-minute provider order.
        DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS = 5 * 60
        PROVIDER_ID_PATTERN = /\A[a-z0-9][a-z0-9_-]{0,63}\z/

        attr_reader :name

        def initialize(key:, secret:, id: "fixedfloat", base_url: nil, lightning_ccy: nil,
                       http: nil, now: nil, cache_seconds: nil, rates_cache_seconds: nil,
                       request_timeout_ms: nil, invoice_expiry_seconds: nil,
                       deposit_window_seconds: nil, settlement_sla_seconds: nil,
                       invoice_expiry_margin_seconds: nil)
          @name = self.class.read_provider_id(id)
          raise ArgumentError, "FixedFloat-compatible API key must not be empty." if key.to_s.strip.empty?
          if secret.to_s.strip.empty?
            raise ArgumentError, "FixedFloat-compatible API secret must not be empty."
          end
          @key = key
          @secret = secret
          @base_url = (base_url || DEFAULT_BASE_URL).sub(%r{/+\z}, "")
          normalized_lightning = lightning_ccy.to_s.strip
          @lightning_ccy = normalized_lightning.empty? ? nil : normalized_lightning
          @http = http || Swap.method(:default_http_request)
          @now = now || -> { Time.now.to_i }
          @cache_seconds = cache_seconds || DEFAULT_CCIES_CACHE_SECONDS
          @rates_cache_seconds = rates_cache_seconds || DEFAULT_RATES_CACHE_SECONDS
          unless @rates_cache_seconds.is_a?(Integer) && @rates_cache_seconds.positive?
            raise ArgumentError, "FixedFloat rates_cache_seconds must be a positive safe integer."
          end
          @request_timeout_ms = request_timeout_ms || DEFAULT_REQUEST_TIMEOUT_MS
          unless @request_timeout_ms.is_a?(Integer) && @request_timeout_ms.positive?
            raise ArgumentError, "FixedFloat request_timeout_ms must be a positive safe integer."
          end
          deposit_window = deposit_window_seconds || DEFAULT_DEPOSIT_WINDOW_SECONDS
          settlement_sla = settlement_sla_seconds || DEFAULT_SETTLEMENT_SLA_SECONDS
          expiry_margin = invoice_expiry_margin_seconds || DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS
          {
            "FixedFloat deposit_window_seconds" => deposit_window,
            "FixedFloat settlement_sla_seconds" => settlement_sla,
            "FixedFloat invoice_expiry_margin_seconds" => expiry_margin
          }.each do |label, value|
            unless value.is_a?(Integer) && value >= 0
              raise ArgumentError, "#{label} must be a non-negative safe integer."
            end
          end
          minimum_expiry = deposit_window + settlement_sla + expiry_margin
          @invoice_expiry_seconds = invoice_expiry_seconds || minimum_expiry
          unless @invoice_expiry_seconds.is_a?(Integer) && @invoice_expiry_seconds >= minimum_expiry
            raise ArgumentError,
                  "FixedFloat provider #{@name.inspect}: invoice_expiry_seconds " \
                  "(#{@invoice_expiry_seconds}) must be at least #{minimum_expiry} = " \
                  "deposit_window(#{deposit_window}) + settlement_sla(#{settlement_sla}) + " \
                  "margin(#{expiry_margin}). Omit invoice_expiry_seconds to auto-derive it, " \
                  "or raise it above that floor."
          end
          @cache = nil
          @weight_budget = nil
          @api_request_logger = nil
          @api_response_logger = nil
        end

        def self.read_provider_id(id)
          normalized = id.to_s.strip
          unless PROVIDER_ID_PATTERN.match?(normalized)
            raise ArgumentError,
                  "FixedFloat-compatible provider id must use lowercase letters, numbers, " \
                  "underscores, or hyphens."
          end
          normalized
        end

        # Attach a disposable process-local cache for provider catalogs/rates.
        def attach_swap_cache(cache)
          @cache = cache
          nil
        end

        # Sinks for outbound API requests/responses. The caller is responsible
        # for sanitizing nested secrets (e.g. the order token on status/refund
        # bodies); the API key and HMAC signature live in headers and are
        # deliberately never logged.
        def attach_api_request_logger(logger)
          @api_request_logger = logger
          nil
        end

        def attach_api_response_logger(logger)
          @api_response_logger = logger
          nil
        end

        def attach_weight_budget(budget)
          @weight_budget = budget
          nil
        end

        def can_accept_request(path)
          return true if @weight_budget.nil?

          @weight_budget.can_reserve?(path)
        end

        def supported_pay_in_assets
          resolve_currencies.fetch("pay_in").keys
        end

        def pay_in_asset_catalog
          resolution = resolve_currencies
          # /ccies reports only availability and display metadata per currency
          # — it carries no amount limits. Per-pair min/max come from the
          # public XML rates export, cached in this process so the
          # payment-method screen never hits /price.
          rates = resolve_rates_index(resolution)
          resolution.fetch("pay_in").map do |pay_in_asset, currency|
            pair = rates.fetch("pairs")[
              FixedFloatRates.pair_key(currency.fetch("code"), resolution.fetch("lightning").fetch("code"))
            ]
            if pair.nil?
              {
                "pay_asset" => pay_in_asset,
                "available" => false,
                "unavailable_reason" => "pair_temporarily_unavailable",
                "unavailable_message" => Swap.availability_message("pair_temporarily_unavailable")
              }
            else
              { "pay_asset" => pay_in_asset }.merge(FixedFloatRates.invoice_limits(pair))
            end
          end
        end

        def invoice_expiry_seconds(pay_in_asset: nil)
          @invoice_expiry_seconds
        end

        def quote(pay_in_asset:, invoice_amount_msats:)
          # Indicative quote from the process-local XML rates cache. /create is
          # still the binding rate. Rates refresh failures raise (fail closed)
          # so the service can skip this provider and try the next configured
          # LSC connection.
          resolution = resolve_currencies
          from_ccy = required_currency(resolution, pay_in_asset)
          rates = resolve_rates_index(resolution)
          begin
            pair = rates.fetch("pairs")[
              FixedFloatRates.pair_key(from_ccy, resolution.fetch("lightning").fetch("code"))
            ]
            if pair.nil?
              return unavailable_quote(pay_in_asset, "pair_temporarily_unavailable")
            end
            limits = FixedFloatRates.invoice_limits(pair)
            pay_amount = FixedFloatRates.quote_pay_amount(
              pair: pair, invoice_amount_msats: invoice_amount_msats
            )
            if pay_amount.nil?
              return unavailable_quote(pay_in_asset, "pair_temporarily_unavailable", limits)
            end
            # Prefer invoice-side limits when conversion succeeded; also
            # compare the indicative pay amount to XML min/max so padded <out>
            # decimals cannot leave a below-min asset selectable.
            pay_below_min =
              FixedFloatRates.compare_decimal_amounts(pay_amount, limits.fetch("minimum_pay_amount")) == -1
            pay_above_max =
              FixedFloatRates.compare_decimal_amounts(pay_amount, limits.fetch("maximum_pay_amount")) == 1
            minimum_msats = limits["minimum_invoice_amount_msats"]
            maximum_msats = limits["maximum_invoice_amount_msats"]
            amount_too_small = pay_below_min || (!minimum_msats.nil? && invoice_amount_msats < minimum_msats)
            amount_too_large = pay_above_max || (!maximum_msats.nil? && invoice_amount_msats > maximum_msats)
            if amount_too_small || amount_too_large
              reason = amount_too_small ? "amount_too_small" : "amount_too_large"
              return unavailable_quote(pay_in_asset, reason, limits)
            end
            {
              "pay_amount" => pay_amount,
              "pay_asset" => pay_in_asset,
              "available" => true,
              "provider" => @name
            }.merge(limits)
          rescue StandardError => e
            # Pair-math / limit errors stay as unavailable quotes. Rates and
            # network failures already raised above from resolve_rates_index
            # and must not be swallowed here.
            reason = Swap.classify_fixedfloat_quote_error(e)
            unavailable_quote(pay_in_asset, reason)
          end
        end

        def create_swap(pay_in_asset:, bolt11:, invoice_amount_msats:)
          resolution = resolve_currencies
          from_ccy = required_currency(resolution, pay_in_asset)
          to_ccy = resolution.fetch("lightning").fetch("code")
          data = post("create",
                      "type" => "fixed",
                      "fromCcy" => from_ccy,
                      "toCcy" => to_ccy,
                      "direction" => "to",
                      "amount" => self.class.amount_msats_to_btc_string(invoice_amount_msats),
                      "toAddress" => bolt11)
          order = normalize_order(data, pay_in_asset: pay_in_asset)
          # FixedFloat order objects do not always carry the USD equivalents
          # (from.usd / to.usd) that explain the swap fee, so backfill them
          # from a best-effort /price lookup for the same trade. A failure
          # just leaves the fee off the deposit panel.
          return order unless order["fee"].nil?

          fee = fetch_order_fee(from_ccy, to_ccy, invoice_amount_msats)
          fee.nil? ? order : order.merge("fee" => fee)
        end

        def get_status(order)
          stored = OpenReceive.stringify(order)
          data = post("order",
                      "id" => stored.fetch("provider_order_id"),
                      "token" => stored.fetch("provider_token"))
          stored.merge(
            normalize_order(data, pay_in_asset: stored["pay_in_asset"], fallback: stored)
          )
        end

        def request_refund(order, refund_address)
          stored = OpenReceive.stringify(order)
          post("emergency",
               "id" => stored.fetch("provider_order_id"),
               "token" => stored.fetch("provider_token"),
               "choice" => "REFUND",
               "address" => refund_address)
          nil
        end

        private

        def unavailable_quote(pay_in_asset, reason, limits = {})
          {
            "pay_asset" => pay_in_asset,
            "available" => false,
            "unavailable_reason" => reason,
            "unavailable_message" => Swap.availability_message(reason),
            "provider" => @name
          }.merge(limits)
        end

        def fetch_order_fee(from_ccy, to_ccy, invoice_amount_msats)
          data = post("price",
                      "type" => "fixed",
                      "fromCcy" => from_ccy,
                      "toCcy" => to_ccy,
                      "direction" => "to",
                      "amount" => self.class.amount_msats_to_btc_string(invoice_amount_msats))
          self.class.read_order_fee(self.class.as_record(data))
        rescue StandardError
          nil
        end

        def post(path, body)
          @weight_budget&.reserve(path)
          body_string = JSON.generate(body)
          # Surface every outbound request before the call. The host sink is
          # responsible for sanitizing nested secrets; the API key and HMAC
          # signature live in headers and are deliberately never logged.
          log_api_request(path, body)
          begin
            response = @http.call(
              method: "POST",
              url: "#{@base_url}/api/v2/#{path}",
              headers: {
                "Content-Type" => "application/json; charset=UTF-8",
                "X-API-KEY" => @key,
                "X-API-SIGN" => OpenSSL::HMAC.hexdigest("SHA256", @secret, body_string)
              },
              body: body_string,
              timeout_ms: @request_timeout_ms
            )
          rescue StandardError => e
            api_error = FixedFloatApiError.from_transport_error(path, e)
            log_api_response(path: path, status: 0, ok: false, msg: api_error.message)
            raise api_error
          end
          status = Integer(response[:status] || response["status"])
          text = (response[:body] || response["body"]).to_s
          ok = (200..299).cover?(status)
          begin
            parsed = text.strip.empty? ? {} : JSON.parse(text)
            parsed = {} unless parsed.is_a?(Hash)
          rescue JSON::ParserError
            log_api_response(path: path, status: status, ok: false,
                             msg: "FixedFloat #{path} returned invalid JSON.")
            raise FixedFloatApiError.new(
              path: path, kind: "invalid_json", http_status: status,
              message: "FixedFloat #{path} returned invalid JSON."
            )
          end
          # Surface every response (including API-error envelopes) before any
          # raise. The host sink sanitizes nested secrets — notably the order
          # token in a create/order response — so this must not pre-redact.
          log_api_response(path: path, status: status, ok: ok,
                           code: parsed["code"], msg: parsed["msg"], data: parsed["data"])
          unless ok
            @weight_budget&.mark_rate_limited if status == 429
            raise FixedFloatApiError.new(
              path: path,
              kind: status == 429 ? "rate_limited" : "http",
              http_status: status,
              fixedfloat_message: self.class.read_string(parsed["msg"]),
              message: self.class.format_api_error_message(path, status, parsed["msg"])
            )
          end
          if parsed["code"] != 0
            raise FixedFloatApiError.new(
              path: path,
              kind: "api",
              fixedfloat_code: parsed["code"],
              fixedfloat_message: self.class.read_string(parsed["msg"]),
              message: parsed["msg"].is_a?(String) ? parsed["msg"] : "FixedFloat #{path} failed."
            )
          end
          parsed["data"]
        end

        def log_api_request(path, body = {})
          @api_request_logger&.call("provider" => @name, "path" => path, "body" => body)
        rescue StandardError
          nil
        end

        def log_api_response(path:, status:, ok:, code: nil, msg: nil, data: nil)
          @api_response_logger&.call(
            "provider" => @name, "path" => path, "status" => status, "ok" => ok,
            "code" => code, "msg" => msg, "data" => data
          )
        rescue StandardError
          nil
        end

        def resolve_currencies
          cache = @cache
          if cache.nil?
            # No transient cache attached (e.g. tests / standalone use):
            # fetch fresh each call.
            return fetch_currency_resolution
          end
          cache.resolve(
            TransientSwapCache.limits_meta_key(@name),
            refresh_seconds: @cache_seconds,
            max_stale_seconds: [TransientSwapCache::MAX_STALE_SECONDS, @cache_seconds].max,
            fetch: -> { fetch_currency_resolution },
            serialize: ->(resolution) { self.class.serialize_currency_resolution(resolution) },
            deserialize: ->(value) { self.class.deserialize_currency_resolution(value) }
          )
        end

        def resolve_rates_index(resolution)
          cache = @cache
          return fetch_rates_index(resolution) if cache.nil?

          cache.resolve(
            FixedFloatRates.rates_meta_key(@name, "fixed"),
            refresh_seconds: @rates_cache_seconds,
            max_stale_seconds: [FixedFloatRates::MAX_STALE_SECONDS, @rates_cache_seconds].max,
            # Crypto rates must not linger after a failed refresh — fail
            # closed so the service can skip this provider and try the next
            # configured LSC connection.
            serve_stale_on_failure: false,
            fetch: -> { fetch_rates_index(resolution) },
            serialize: ->(index) { FixedFloatRates.serialize_index(index) },
            deserialize: ->(value) { FixedFloatRates.deserialize_index(value) }
          )
        end

        def fetch_rates_index(resolution)
          path = FixedFloatRates.xml_path("fixed").sub(%r{\A/}, "")
          log_api_request(path)
          begin
            fetched = FixedFloatRates.fetch_index(
              base_url: @base_url,
              rate_type: "fixed",
              http: @http,
              now: @now,
              request_timeout_ms: @request_timeout_ms
            )
            index = FixedFloatRates.retain_pairs_for_keys(
              fetched,
              self.class.rate_pair_keys(resolution)
            )
            log_api_response(path: path, status: 200, ok: true,
                             data: { "pair_count" => index.fetch("pairs").length })
            index
          rescue StandardError => e
            log_api_response(path: path, status: 0, ok: false, msg: e.message)
            raise
          end
        end

        def fetch_currency_resolution
          now = @now.call
          data = post("ccies", {})
          currencies = self.class.read_currencies(data)
          pay_in = {}
          Assets.list_info.each do |asset|
            found = currencies.find do |currency|
              currency.fetch("coin").upcase == asset.fetch("coin") &&
                Assets.network_matches?(asset.fetch("network"), currency.fetch("network")) &&
                # /ccies recv=false means the provider will not accept deposits
                # for this currency — omit it rather than failing at /create.
                currency["recv"] != false
            end
            pay_in[asset.fetch("pay_in_asset")] = found unless found.nil?
          end

          lightning =
            if @lightning_ccy.nil?
              currencies.find do |currency|
                currency.fetch("coin").upcase == "BTC" &&
                  Assets.lightning_network?(currency.fetch("network")) &&
                  # Payout side must be sendable to the merchant's bolt11.
                  currency["send"] != false
              end
            else
              currencies.find do |currency|
                currency.fetch("code") == @lightning_ccy && currency["send"] != false
              end
            end
          if lightning.nil?
            raise "FixedFloat /ccies did not include a BTC Lightning payout currency."
          end

          { "fetched_at" => now, "pay_in" => pay_in, "lightning" => lightning }
        end

        def required_currency(resolution, pay_in_asset)
          currency = resolution.fetch("pay_in")[pay_in_asset]
          if currency.nil?
            label = Assets.pay_in_asset?(pay_in_asset) ? Assets.info(pay_in_asset).fetch("pay_in_asset") : pay_in_asset
            raise "FixedFloat does not currently support #{label}."
          end
          currency.fetch("code")
        end

        def normalize_order(data, pay_in_asset:, fallback: nil)
          fallback ||= {}
          record = self.class.as_record(data)
          from = self.class.as_record(record["from"])
          time = self.class.as_record(record["time"])
          refund_tx_id =
            self.class.read_nested_string(record, %w[back tx id]) ||
            self.class.read_nested_string(record, %w[refund tx id]) ||
            fallback["refund_tx_id"]
          normalized_status = self.class.normalize_status(
            self.class.read_string(record["status"]) || fallback["state"] || "NEW",
            self.class.as_record(record["emergency"]),
            refund_tx_id
          )
          # Read and validate the deposit address BEFORE anything else can
          # raise: a response that is both missing `id` and carrying a
          # wrong-network address must still fail with the address error, the
          # way it did before this method was split.
          deposit_address = validated_deposit_address(from, pay_in_asset, fallback)
          order = {
            "provider" => @name,
            "provider_order_id" =>
              self.class.read_string(record["id"]) ||
              fallback["provider_order_id"] ||
              self.class.required_string(record["id"], "id"),
            "provider_token" =>
              self.class.read_string(record["token"]) ||
              fallback["provider_token"] ||
              self.class.required_string(record["token"], "token"),
            "pay_in_asset" => pay_in_asset,
            "deposit_address" => deposit_address,
            "deposit_amount" =>
              self.class.read_string(from["amount"]) ||
              fallback["deposit_amount"] ||
              self.class.required_string(from["amount"], "from.amount"),
            "expires_at" =>
              self.class.read_unix_seconds(time["expiration"]) ||
              fallback["expires_at"] ||
              (@now.call + 600),
            "state" => normalized_status.fetch("state")
          }
          order.merge!(optional_order_fields(record, normalized_status, refund_tx_id, fallback))
          order["raw"] = data
          order
        end

        # The only producer of a deposit address. Reading it and checking it
        # against the pay-in asset's network must never come apart: an address
        # accepted for the wrong chain sends the payer's funds somewhere
        # nobody can recover them from.
        def validated_deposit_address(from, pay_in_asset, fallback)
          address =
            self.class.read_string(from["address"]) ||
            fallback["deposit_address"] ||
            self.class.required_string(from["address"], "from.address")
          unless Assets.valid_swap_address_for_network?(pay_in_asset, address)
            raise "FixedFloat deposit address is not valid for this asset."
          end
          address
        end

        # Every order field that is OMITTED rather than sent as null when the
        # provider did not report it — on the payer-facing wire body and in the
        # persisted recovery payload alike. Compacted in one place so a new
        # optional field cannot accidentally ship as an explicit null.
        def optional_order_fields(record, normalized_status, refund_tx_id, fallback)
          from = self.class.as_record(record["from"])
          emergency_repeat =
            self.class.read_emergency_repeat(self.class.as_record(record["emergency"]))
          {
            "deposit_memo" => self.class.read_string(from["tag"]) || fallback["deposit_memo"],
            "deposit_tx_id" =>
              self.class.read_nested_string(record, %w[from tx id]) || fallback["deposit_tx_id"],
            "payout_tx_id" =>
              self.class.read_nested_string(record, %w[to tx id]) || fallback["payout_tx_id"],
            "refund_tx_id" => refund_tx_id,
            "attention" => normalized_status["attention"],
            "attention_reason" => normalized_status["attention_reason"],
            "refund_reason" =>
              normalized_status["refund_reason"] ||
              (self.class.refund_path_state?(normalized_status.fetch("state")) ? fallback["refund_reason"] : nil),
            "deposit_received_amount" =>
              self.class.read_decimal_amount(self.class.read_nested_string(record, %w[from tx amount])) ||
              fallback["deposit_received_amount"],
            "refund_amount" =>
              self.class.read_decimal_amount(self.class.read_nested_string(record, %w[back amount])) ||
              fallback["refund_amount"],
            "emergency_repeat" =>
              emergency_repeat.nil? ? fallback["emergency_repeat"] : emergency_repeat,
            "fee" => self.class.read_order_fee(record) || fallback["fee"]
          }.compact
        end

        class << self
          def amount_msats_to_btc_string(amount_msats)
            unless amount_msats.is_a?(Integer) && amount_msats.positive?
              raise ArgumentError, "invoice_amount_msats must be a positive safe integer."
            end
            sats = (amount_msats + 999) / 1000
            whole_btc = sats / 100_000_000
            fractional = (sats % 100_000_000).to_s.rjust(8, "0").sub(/0+\z/, "")
            fractional.empty? ? whole_btc.to_s : "#{whole_btc}.#{fractional}"
          end

          def format_api_error_message(path, status, msg)
            fixedfloat_message = read_string(msg)
            if fixedfloat_message.nil?
              "FixedFloat #{path} failed with HTTP #{status}."
            else
              "FixedFloat #{path} failed with HTTP #{status}: #{fixedfloat_message}"
            end
          end

          # FixedFloat reports the USD equivalents of both sides of the
          # exchange; their gap is the swap fee the payer absorbs, so both are
          # surfaced to explain the price.
          def read_order_fee(record)
            pay_in_fiat = read_nested_string(record, %w[from usd])
            payout_fiat = read_nested_string(record, %w[to usd])
            return nil if pay_in_fiat.nil? || payout_fiat.nil?

            { "currency" => "USD", "pay_in_fiat" => pay_in_fiat, "payout_fiat" => payout_fiat }
          end

          def normalize_status(status, emergency, refund_tx_id)
            normalized = status.to_s.upcase
            if !refund_tx_id.nil? && %w[DONE FINISHED].include?(normalized)
              return { "state" => "refunded" }
            end
            case normalized
            when "NEW" then return { "state" => "awaiting_deposit" }
            when "PENDING" then return { "state" => "confirming" }
            when "EXCHANGE" then return { "state" => "exchanging" }
            when "WITHDRAW" then return { "state" => "paying_invoice" }
            when "DONE" then return { "state" => "completed" }
            when "EXPIRED" then return { "state" => "expired" }
            end
            if normalized == "EMERGENCY"
              choice = read_string(emergency["choice"])&.upcase
              statuses = read_string_array(emergency["status"]).map(&:upcase)
              refund_reason = refund_reason_from_emergency_statuses(statuses)
              if choice == "REFUND" && !refund_tx_id.nil?
                result = { "state" => "refunded" }
                result["refund_reason"] = refund_reason unless refund_reason.nil?
                return result
              end
              if choice == "REFUND"
                result = { "state" => "refund_pending" }
                result["refund_reason"] = refund_reason unless refund_reason.nil?
                return result
              end
              if choice == "EXCHANGE"
                return {
                  "state" => "attention", "attention" => true,
                  "attention_reason" => "provider_reported_emergency"
                }
              end
              if (statuses & %w[MORE OVER OVERPAID]).any?
                return {
                  "state" => "attention", "attention" => true,
                  "attention_reason" => "provider_reported_emergency"
                }
              end
              result = { "state" => "refund_required" }
              result["refund_reason"] = refund_reason unless refund_reason.nil?
              return result
            end
            return { "state" => "failed" } if normalized.include?("FAIL")

            # An unrecognized status is NOT a provider-reported emergency:
            # label it as unknown so operators land on the right runbook section.
            {
              "state" => "attention", "attention" => true,
              "attention_reason" => "provider_status_unrecognized"
            }
          end

          def refund_reason_from_emergency_statuses(statuses)
            less = statuses.include?("LESS")
            expired = statuses.include?("EXPIRED")
            return "underpaid_and_late" if less && expired
            return "underpaid" if less
            return "late_deposit" if expired

            nil
          end

          def refund_path_state?(state)
            %w[refund_required refund_pending refunded].include?(state)
          end

          def read_decimal_amount(value)
            return nil if value.nil?

            /\A[0-9]+(\.[0-9]+)?\z/.match?(value) ? value : nil
          end

          def read_currencies(data)
            record = as_record(data)
            items =
              if data.is_a?(Array)
                data
              elsif record["ccies"].is_a?(Array)
                record["ccies"]
              elsif record["currencies"].is_a?(Array)
                record["currencies"]
              else
                []
              end
            currencies = []
            items.each do |item|
              row = as_record(item)
              code = read_string(row["code"]) || read_string(row["ticker"])
              coin = read_string(row["coin"]) || read_string(row["currency"]) || read_string(row["symbol"])
              network =
                read_string(row["network"]) || read_string(row["chain"]) ||
                read_string(row["networkName"]) || read_string(row["name"])
              next if code.nil? || coin.nil? || network.nil?

              currency = { "code" => code, "coin" => coin.upcase, "network" => network }
              currency["recv"] = row["recv"] if [true, false].include?(row["recv"])
              currency["send"] = row["send"] if [true, false].include?(row["send"])
              currencies << currency
            end
            currencies
          end

          def read_emergency_repeat(emergency)
            value = emergency["repeat"]
            return value if [true, false].include?(value)
            return false if value == 0 || value == "0" # rubocop:disable Style/NumericPredicate
            return true if value == 1 || value == "1"

            nil
          end

          def serialize_currency_resolution(resolution)
            JSON.generate(
              "fetched_at" => resolution.fetch("fetched_at"),
              "pay_in" => resolution.fetch("pay_in").to_a,
              "lightning" => resolution.fetch("lightning")
            )
          end

          def deserialize_currency_resolution(value)
            parsed = JSON.parse(value)
            {
              "fetched_at" => parsed.fetch("fetched_at"),
              "pay_in" => parsed.fetch("pay_in").to_h,
              "lightning" => parsed.fetch("lightning")
            }
          end

          def rate_pair_keys(resolution)
            lightning_code = resolution.fetch("lightning").fetch("code")
            resolution.fetch("pay_in").values.map do |currency|
              FixedFloatRates.pair_key(currency.fetch("code"), lightning_code)
            end.uniq
          end

          def as_record(value)
            value.is_a?(Hash) ? value : {}
          end

          def read_nested_string(value, path)
            current = value
            path.each do |key|
              current = as_record(current)[key]
            end
            read_string(current)
          end

          def read_string(value)
            return value if value.is_a?(String) && !value.empty?
            if value.is_a?(Numeric) && (!value.respond_to?(:finite?) || value.finite?)
              return OpenReceive::Rates.number_to_plain_decimal_string(value)
            end

            nil
          end

          def read_string_array(value)
            if value.is_a?(Array)
              return value.filter_map { |item| read_string(item) }
            end
            string = read_string(value)
            string.nil? ? [] : [string]
          end

          def required_string(value, field)
            string = read_string(value)
            raise "FixedFloat response missing #{field}." if string.nil?

            string
          end

          def read_unix_seconds(value)
            numeric =
              if value.is_a?(String)
                begin
                  Integer(value, 10)
                rescue ArgumentError
                  begin
                    rational = Rational(value)
                    rational.denominator == 1 ? rational.numerator : nil
                  rescue ArgumentError, ZeroDivisionError
                    nil
                  end
                end
              else
                value
              end
            return nil unless numeric.is_a?(Numeric)
            return nil unless numeric == numeric.to_i && numeric >= 0
            return nil if numeric.to_i > FixedFloatRates::MAX_SAFE_INTEGER

            numeric.to_i
          end
        end
      end
    end
  end
end
