# frozen_string_literal: true

require "monitor"

module OpenReceive
  module Server
    module Swap
      # Ruby port of packages/js/node/src/swap/limits-cache.ts: a disposable,
      # process-local provider catalog/rate cache. It has no storage adapter.
      #
      # Like the Node in-flight promise map, concurrent resolves of the same
      # key join one fetch: the first caller claims the key under the monitor,
      # runs fetch outside it, and writes back under the monitor; joiners wait
      # on a per-key condition. Different keys never block each other.
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
          @inflight = {}
          @monitor = Monitor.new
        end

        def resolve(key, refresh_seconds:, max_stale_seconds:, fetch:, serialize:, deserialize:,
                    claim_seconds: REFRESH_CLAIM_SECONDS, serve_stale_on_failure: true)
          now = nil
          state = nil
          claim = nil
          @monitor.synchronize do
            now = @clock.call
            state = @states[key]
            if state && state[:value] && state[:fetched_at] && now - state[:fetched_at] < refresh_seconds
              return deserialize.call(state[:value])
            end
            if state && state[:failed_at] && now - state[:failed_at] < claim_seconds
              return stale_or_raise(key, state, now, max_stale_seconds, serve_stale_on_failure, deserialize)
            end

            active = @inflight[key]
            if active
              active[:cond].wait_until { active[:settled] }
              raise active[:error] unless active[:error].nil?

              return active[:value]
            end
            claim = { settled: false, cond: @monitor.new_cond }
            @inflight[key] = claim
          end

          begin
            result = begin
              value = fetch.call
              @monitor.synchronize { @states[key] = { value: serialize.call(value), fetched_at: now } }
              value
            rescue StandardError => e
              failed = {
                failed_at: now,
                error: e.message
              }
              failed[:value] = state[:value] if state && state[:value]
              failed[:fetched_at] = state[:fetched_at] if state && state[:fetched_at]
              @monitor.synchronize { @states[key] = failed }
              stale_or_raise(key, failed, now, max_stale_seconds, serve_stale_on_failure, deserialize, cause: e)
            end
            settle(key, claim, value: result)
            result
          rescue StandardError => e
            settle(key, claim, error: e)
            raise
          end
        end

        private

        def settle(key, claim, value: nil, error: nil)
          @monitor.synchronize do
            claim[:value] = value
            claim[:error] = error
            claim[:settled] = true
            claim[:cond].broadcast
            @inflight.delete(key) if @inflight[key].equal?(claim)
          end
        end

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
