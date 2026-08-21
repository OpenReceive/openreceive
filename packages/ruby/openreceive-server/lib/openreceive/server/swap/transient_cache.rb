# frozen_string_literal: true

require "monitor"

module OpenReceive
  module Server
    module Swap
      # Ruby port of packages/js/node/src/swap/limits-cache.ts: a disposable,
      # process-local provider catalog/rate cache. It has no storage adapter.
      #
      # Simplification vs JS: Node de-duplicates concurrent refreshes with an
      # in-flight promise map; Ruby serializes resolve calls per cache with a
      # monitor instead (same observable behavior: one fetch per fresh window,
      # claim window after a failure).
      class TransientSwapCache
        MAX_STALE_SECONDS = 48 * 60 * 60
        REFRESH_CLAIM_SECONDS = 60

        def self.limits_meta_key(provider_name)
          "swap_limits:#{provider_name}"
        end

        def initialize(clock, warn: nil)
          @clock = clock
          @warn = warn
          @states = {}
          @monitor = Monitor.new
        end

        def resolve(key, refresh_seconds:, max_stale_seconds:, fetch:, serialize:, deserialize:,
                    claim_seconds: REFRESH_CLAIM_SECONDS, serve_stale_on_failure: true)
          @monitor.synchronize do
            now = @clock.call
            state = @states[key]
            if state && state[:value] && state[:fetched_at] && now - state[:fetched_at] < refresh_seconds
              return deserialize.call(state[:value])
            end
            if state && state[:failed_at] && now - state[:failed_at] < claim_seconds
              return stale_or_raise(key, state, now, max_stale_seconds, serve_stale_on_failure, deserialize)
            end

            begin
              value = fetch.call
              @states[key] = { value: serialize.call(value), fetched_at: now }
              value
            rescue StandardError => e
              failed = {
                failed_at: now,
                error: e.message
              }
              failed[:value] = state[:value] if state && state[:value]
              failed[:fetched_at] = state[:fetched_at] if state && state[:fetched_at]
              @states[key] = failed
              stale_or_raise(key, failed, now, max_stale_seconds, serve_stale_on_failure, deserialize, cause: e)
            end
          end
        end

        private

        def stale_or_raise(key, state, now, max_stale_seconds, serve_stale_on_failure, deserialize, cause: nil)
          if serve_stale_on_failure && state[:value] && state[:fetched_at] &&
             now - state[:fetched_at] < max_stale_seconds
            @warn&.call("Serving stale swap provider data after refresh failed.",
                        "key" => key, "error" => state[:error])
            return deserialize.call(state[:value])
          end
          raise cause unless cause.nil?

          raise state[:error] || "Swap provider cache refresh failed."
        end
      end
    end
  end
end
