# frozen_string_literal: true

require "json"
require "openreceive/server/swap/assets"

module OpenReceive
  module Server
    module Swap
      # Ruby port of packages/js/node/src/swap/fixedfloat-rates.ts (plus the
      # rates-cache key/TTL constants from rates-cache.ts): the FixedFloat
      # public XML rates export — the bulk feed for all pairs.
      #
      # GET https://ff.io/rates/fixed.xml (and float.xml). No API key, no
      # weight budget. OpenReceive keeps only Lightning-payout pairs that match
      # its small pay-in asset list in disposable process memory and derives
      # indicative quotes / min-max locally. /create remains authoritative.
      #
      # All amount math is exact integer fixed-point (Ruby Integers are
      # arbitrary precision), mirroring the JS BigInt implementation digit for
      # digit — never binary floats.
      module FixedFloatRates
        DECIMAL_PATTERN = /\A[0-9]+(\.[0-9]+)?\z/
        SATS_PER_BTC = 100_000_000
        MAX_SAFE_INTEGER = 9_007_199_254_740_991

        # How often a warm rates blob is refreshed from the provider bulk feed
        # (mirrors SWAP_RATES_REFRESH_SECONDS / SWAP_RATES_MAX_STALE_SECONDS).
        REFRESH_SECONDS = 15
        MAX_STALE_SECONDS = REFRESH_SECONDS

        module_function

        def pair_key(from, to)
          "#{from.to_s.strip.upcase}:#{to.to_s.strip.upcase}"
        end

        def xml_path(rate_type = "fixed")
          "/rates/#{rate_type}.xml"
        end

        # Process-local key for a provider's bulk rates snapshot,
        # e.g. "swap_rates:fixedfloat:fixed".
        def rates_meta_key(provider_name, rate_type = "fixed")
          "swap_rates:#{provider_name}:#{rate_type}"
        end

        # Fetch and parse the XML export. `http` is the injectable transport
        # (see Swap.default_http_request); `now` is a callable returning unix
        # seconds. Raises on transport/HTTP failures with the same messages as
        # the JS fetchFixedFloatRatesIndex.
        def fetch_index(base_url:, now:, http: nil, rate_type: "fixed", request_timeout_ms: 10_000)
          url = "#{base_url.to_s.sub(%r{/+\z}, '')}#{xml_path(rate_type)}"
          transport = http || Swap.method(:default_http_request)
          begin
            response = transport.call(
              method: "GET",
              url: url,
              headers: { "Accept" => "application/xml, text/xml, */*" },
              body: nil,
              timeout_ms: request_timeout_ms
            )
          rescue StandardError => e
            raise "FixedFloat rates #{rate_type}.xml request timed out." if Swap.timeout_error?(e)

            raise "FixedFloat rates #{rate_type}.xml request failed before a response was received."
          end
          status = response[:status] || response["status"]
          unless (200..299).cover?(status)
            raise "FixedFloat rates #{rate_type}.xml failed with HTTP #{status}."
          end
          xml = (response[:body] || response["body"]).to_s
          {
            # Provider dumps include thousands of non-LN market pairs;
            # OpenReceive only ever pays out over Lightning, so drop everything
            # else before caching.
            "fetched_at" => now.call,
            "pairs" => retain_lightning_payout_pairs(parse_xml(xml))
          }
        end

        # Keep only pairs whose `to` side is a Lightning BTC payout code.
        def retain_lightning_payout_pairs(pairs)
          pairs.select { |_key, pair| Assets.lightning_network?(pair.fetch("to")) }
        end

        # Keep only the from→Lightning keys that match resolved OpenReceive
        # pay-in currencies. Typically a handful of pairs out of the dump.
        def retain_pairs_for_keys(index, pair_keys)
          return { "fetched_at" => index.fetch("fetched_at"), "pairs" => {} } if pair_keys.empty?

          pairs = {}
          pair_keys.each do |key|
            pair = index.fetch("pairs")[key]
            pairs[key] = pair unless pair.nil?
          end
          { "fetched_at" => index.fetch("fetched_at"), "pairs" => pairs }
        end

        def parse_xml(xml)
          pairs = {}
          match_tags(xml, "item").each do |item_xml|
            from = read_tag_text(item_xml, "from")
            to = read_tag_text(item_xml, "to")
            in_amount = read_tag_text(item_xml, "in")
            out_amount = read_tag_text(item_xml, "out")
            amount = read_tag_text(item_xml, "amount")
            minamount = read_tag_text(item_xml, "minamount")
            maxamount = read_tag_text(item_xml, "maxamount")
            next if [from, to, in_amount, out_amount, amount, minamount, maxamount].any?(&:nil?)

            tofee = read_tag_text(item_xml, "tofee")
            pair = {
              "from" => from.strip,
              "to" => to.strip,
              "in" => strip_currency_suffix(in_amount),
              "out" => strip_currency_suffix(out_amount),
              "amount" => strip_currency_suffix(amount),
              "minamount" => strip_currency_suffix(minamount),
              "maxamount" => strip_currency_suffix(maxamount)
            }
            pair["tofee"] = tofee.strip unless tofee.nil?
            pairs[pair_key(pair.fetch("from"), pair.fetch("to"))] = pair
          end
          pairs
        end

        def serialize_index(index)
          JSON.generate("fetched_at" => index.fetch("fetched_at"), "pairs" => index.fetch("pairs"))
        end

        def deserialize_index(value)
          parsed = JSON.parse(value)
          fetched_at = parsed.is_a?(Hash) ? parsed["fetched_at"] : nil
          raw_pairs = parsed.is_a?(Hash) ? parsed["pairs"] : nil
          unless fetched_at.is_a?(Integer) && raw_pairs.is_a?(Hash)
            raise "Invalid FixedFloat rates cache blob."
          end
          pairs = {}
          raw_pairs.each do |key, raw|
            pair = read_stored_pair(raw)
            pairs[key] = pair unless pair.nil?
          end
          { "fetched_at" => fetched_at, "pairs" => pairs }
        end

        # Indicative pay-in amount for a Lightning payout of
        # invoice_amount_msats, using the XML reference rate (in/out) and
        # optional BTC tofee.
        #
        # Formula (direction=to): pay_from = (invoice_btc + tofee_btc) × (in / out).
        # Rounds the pay-in amount up at 8 decimal places so the UI never
        # understates what /create is likely to require.
        def quote_pay_amount(pair:, invoice_amount_msats:)
          return nil unless invoice_amount_msats.is_a?(Integer) && invoice_amount_msats.positive?

          rate_in = parse_positive_decimal(pair["in"])
          rate_out = parse_positive_decimal(pair["out"])
          return nil if rate_in.nil? || rate_out.nil?

          invoice_sats = (invoice_amount_msats + 999) / 1000
          tofee_sats = parse_tofee_btc_sats(pair["tofee"]) || 0
          total_sats = invoice_sats + tofee_sats
          return nil unless rate_out[0].positive?

          # pay_from = total_btc * (in/out) = total_sats * in / (out * 1e8).
          # Compute ceil(total_sats * in / out) as an 8-decimal fixed-point
          # integer of the from currency (units of 1e-8), then format.
          pay_at_8dp = ceil_div(
            total_sats * rate_in[0] * rate_out[1],
            rate_in[1] * rate_out[0]
          )
          format_decimal(pay_at_8dp, SATS_PER_BTC, 8)
        end

        # Maps XML from-side min/max into invoice-side msats using the pair's
        # reference rate. Minimum rounds up, maximum rounds down, so borderline
        # invoices are never reported as inside a range the provider rejects.
        def invoice_limits(pair)
          minimum_pay_amount = pair.fetch("minamount")
          maximum_pay_amount = pair.fetch("maxamount")
          limits = {
            "minimum_pay_amount" => minimum_pay_amount,
            "maximum_pay_amount" => maximum_pay_amount
          }
          minimum = pay_amount_to_invoice_msats(pair, minimum_pay_amount, :ceil)
          maximum = pay_amount_to_invoice_msats(pair, maximum_pay_amount, :floor)
          limits["minimum_invoice_amount_msats"] = minimum unless minimum.nil?
          limits["maximum_invoice_amount_msats"] = maximum unless maximum.nil?
          limits
        end

        # Compare two positive decimal strings. Returns -1/0/1, or nil when
        # either is not a positive decimal (caller treats that as "cannot
        # compare").
        def compare_decimal_amounts(left, right)
          a = parse_positive_decimal(left)
          b = parse_positive_decimal(right)
          return nil if a.nil? || b.nil?

          (a[0] * b[1]) <=> (b[0] * a[1])
        end

        # Inverse of the direction=to quote (ignoring tofee so the reported
        # invoice floor is conservative): invoice_sats = pay_from × out × 1e8 / in.
        def pay_amount_to_invoice_msats(pair, pay_amount, rounding)
          pay = parse_positive_decimal(pay_amount)
          rate_in = parse_positive_decimal(pair["in"])
          rate_out = parse_positive_decimal(pair["out"])
          return nil if pay.nil? || rate_in.nil? || rate_out.nil?
          return nil unless rate_in[0].positive?

          numerator = pay[0] * rate_out[0] * SATS_PER_BTC * rate_in[1]
          denominator = pay[1] * rate_out[1] * rate_in[0]
          return nil unless denominator.positive?

          invoice_sats = rounding == :ceil ? ceil_div(numerator, denominator) : numerator / denominator
          return nil unless invoice_sats.positive?
          return nil if invoice_sats > MAX_SAFE_INTEGER

          msats = invoice_sats * 1000
          msats > MAX_SAFE_INTEGER ? nil : msats
        end

        def parse_tofee_btc_sats(tofee)
          return nil if tofee.nil?

          # Examples: "0.0004967000 BTC", "0.0005 BTCLN". Non-BTC fees are
          # ignored — payout is always Lightning BTC, so only BTC network fees
          # fold into pay-in.
          match = tofee.to_s.strip.match(/\A([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?\z/)
          return nil if match.nil?

          unit = (match[2] || "BTC").upcase
          return nil unless %w[BTC BTCLN].include?(unit)

          parsed = parse_positive_decimal(match[1])
          return nil if parsed.nil?

          # Fees carrying more than 8 decimals are reduced to whole sats with
          # ceil rounding — rejecting them would silently treat a real network
          # fee as zero and understate the indicative pay amount.
          ceil_div(parsed[0] * SATS_PER_BTC, parsed[1])
        end

        # Returns [integer, scale] for a positive decimal string, else nil.
        def parse_positive_decimal(value)
          return nil unless value.is_a?(String) && DECIMAL_PATTERN.match?(value)

          whole, fraction = value.split(".")
          fraction ||= ""
          integer = "#{whole}#{fraction}".to_i
          return nil unless integer.positive?

          [integer, 10**fraction.length]
        end

        def format_decimal(integer, scale, max_fraction_digits)
          whole = integer / scale
          fraction = integer % scale
          # Truncate/pad to max_fraction_digits, rounding up any discarded remainder.
          target_scale = 10**max_fraction_digits
          if scale > target_scale
            divisor = scale / target_scale
            remainder = fraction % divisor
            fraction /= divisor
            fraction += 1 if remainder.positive?
            if fraction >= target_scale
              return format_decimal(whole * target_scale + fraction, target_scale, max_fraction_digits)
            end
          elsif scale < target_scale
            fraction *= target_scale / scale
          end
          fraction_text = fraction.to_s.rjust(max_fraction_digits, "0").sub(/0+\z/, "")
          fraction_text.empty? ? whole.to_s : "#{whole}.#{fraction_text}"
        end

        def ceil_div(numerator, denominator)
          (numerator + denominator - 1) / denominator
        end

        def strip_currency_suffix(value)
          match = value.strip.match(/\A([0-9]+(?:\.[0-9]+)?)/)
          match.nil? ? value.strip : match[1]
        end

        def match_tags(xml, tag)
          xml.scan(%r{<#{tag}\b[^>]*>(.*?)</#{tag}>}im).map { |captures| captures[0] || "" }
        end

        def read_tag_text(xml, tag)
          match = xml.match(%r{<#{tag}\b[^>]*>(.*?)</#{tag}>}im)
          return nil if match.nil?

          text = (match[1] || "").strip
          text.empty? ? nil : text
        end

        def read_stored_pair(value)
          return nil unless value.is_a?(Hash)

          required = %w[from to in out amount minamount maxamount]
          return nil unless required.all? { |key| value[key].is_a?(String) }

          pair = required.to_h { |key| [key, value.fetch(key)] }
          pair["tofee"] = value["tofee"] if value["tofee"].is_a?(String)
          pair
        end
      end
    end
  end
end
