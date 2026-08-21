# frozen_string_literal: true

require "net/http"
require "timeout"
require "uri"

require "openreceive/server/lsc_uri"
require "openreceive/server/swap/assets"
require "openreceive/server/swap/rates_feed"
require "openreceive/server/swap/transient_cache"
require "openreceive/server/swap/weight_budget"
require "openreceive/server/swap/fixedfloat"

module OpenReceive
  module Server
    # Automated swaps: the FixedFloat(-compatible) provider, the asset
    # catalog, rates/limits caching, and the LSC connection factories.
    # Ruby port of packages/js/node/src/swap/ plus the LSC provider factory
    # from packages/js/node/src/lsc-uri.ts.
    module Swap
      module_function

      def fixedfloat_provider(**options)
        FixedFloatProvider.new(**options)
      end

      # Build one provider per parsed LSC connection (the hashes produced by
      # OpenReceive::Server::LscUri.parse / read_environment).
      def providers_from_connections(connections, http: nil, now: nil)
        Array(connections).map do |connection|
          FixedFloatProvider.new(
            id: connection.fetch("provider_id"),
            base_url: connection.fetch("base_url"),
            key: connection.fetch("key"),
            secret: connection.fetch("secret"),
            http: http,
            now: now
          )
        end
      end

      # Mirror of createLscSwapProvidersFromEnvironment: LSC_URI_PRIMARY first,
      # LSC_URI_BACKUP second — the order the service fails over in.
      def providers_from_environment(env = ENV, http: nil, now: nil)
        providers_from_connections(LscUri.read_environment(env), http: http, now: now)
      end

      # Default HTTP transport on stdlib Net::HTTP. Injectable replacements
      # must be callable as call(method:, url:, headers:, body:, timeout_ms:)
      # and return a Hash with :status (Integer) and :body (String).
      def default_http_request(method:, url:, headers:, body: nil, timeout_ms: nil)
        uri = URI.parse(url)
        http = Net::HTTP.new(uri.host, uri.port)
        http.use_ssl = uri.scheme == "https"
        unless timeout_ms.nil?
          seconds = timeout_ms / 1000.0
          http.open_timeout = seconds
          http.read_timeout = seconds
          http.write_timeout = seconds if http.respond_to?(:write_timeout=)
        end
        request =
          if method.to_s.upcase == "POST"
            Net::HTTP::Post.new(uri.request_uri)
          else
            Net::HTTP::Get.new(uri.request_uri)
          end
        headers.each { |key, value| request[key] = value }
        request.body = body unless body.nil?
        response = http.start { |connection| connection.request(request) }
        { status: Integer(response.code), body: response.body.to_s }
      end

      # Timeout classification shared by the API client and the rates feed
      # (the Ruby analogue of the JS AbortError check).
      def timeout_error?(error)
        return true if defined?(Net::OpenTimeout) && error.is_a?(Net::OpenTimeout)
        return true if defined?(Net::ReadTimeout) && error.is_a?(Net::ReadTimeout)
        return true if error.is_a?(Timeout::Error)

        error.is_a?(StandardError) && error.message.to_s.downcase.include?("abort")
      end

      def weight_budget_error?(error)
        error.respond_to?(:weight_budget?) && error.weight_budget? == true
      end

      # Payer-facing copy per availability reason (mirrors
      # fixedFloatAvailabilityMessage).
      def availability_message(reason)
        return "This invoice is below the provider minimum." if reason == "amount_too_small"
        return "This invoice is above the provider maximum." if reason == "amount_too_large"
        return "The swap provider is rate limited." if reason == "provider_rate_limited"
        return "The swap provider is temporarily unreachable." if reason == "provider_unreachable"

        "This payment route is temporarily unavailable."
      end

      # Mirrors classifyFixedFloatQuoteError: map a quote-path failure to a
      # SwapAvailabilityReason.
      def classify_fixedfloat_quote_error(error)
        return "provider_rate_limited" if weight_budget_error?(error)

        if error.is_a?(FixedFloatApiError)
          return "provider_rate_limited" if error.kind == "rate_limited" || error.http_status == 429
          if %w[timeout network invalid_json].include?(error.kind) ||
             (!error.http_status.nil? && error.http_status >= 500)
            return "provider_unreachable"
          end
          message = (error.fixedfloat_message || error.message).downcase
          return "amount_too_small" if amount_too_small_message?(message)
          return "amount_too_large" if amount_too_large_message?(message)

          return "pair_temporarily_unavailable"
        end

        message = (error.is_a?(StandardError) ? error.message : error.to_s).downcase
        if message.include?("rate") || message.include?("429") || message.include?("weight budget")
          return "provider_rate_limited"
        end
        if message.include?("fetch") || message.include?("network") || message.include?("timeout")
          return "provider_unreachable"
        end
        return "amount_too_small" if amount_too_small_message?(message)
        return "amount_too_large" if amount_too_large_message?(message)

        "pair_temporarily_unavailable"
      end

      def amount_too_small_message?(message)
        message.include?("min") || message.include?("small") ||
          message.include?("out of limits") || message.include?("limit_min")
      end

      def amount_too_large_message?(message)
        message.include?("max") || message.include?("large") || message.include?("limit_max")
      end
    end
  end
end
