# frozen_string_literal: true

require "monitor"

module OpenReceive
  module Server
    module Swap
      # Raised when a reservation would exceed the process-local weight budget.
      # Marked (weight_budget?) so quote classification can map it to
      # provider_rate_limited, mirroring the JS weightBudget error tag.
      class WeightBudgetError < StandardError
        # The denial diagnostics (provider, path, reason, used/cost/gate,
        # window start, backoff) ride the error itself.
        attr_reader :denial

        def initialize(message, denial = {})
          super(message)
          @denial = denial
        end

        def weight_budget?
          true
        end
      end

      # Ruby port of packages/js/node/src/swap/weight-budget.ts: a disposable
      # per-process request guard; the provider remains the global rate-limit
      # authority.
      class SwapProviderWeightBudget
        WINDOW_SECONDS = 60
        SOFT_CAP = 200
        CREATE_GATE = 150
        CREATE_WEIGHT = 50
        DEFAULT_WEIGHT = 1
        BACKOFF_SECONDS = 60

        def initialize(provider_id, clock)
          @provider_id = provider_id
          @clock = clock
          @window_start = clock.call
          @used = 0
          @backoff_until = nil
          @monitor = Monitor.new
        end

        def weight_for_path(path)
          path == "create" ? CREATE_WEIGHT : DEFAULT_WEIGHT
        end

        def reserve(path)
          @monitor.synchronize do
            roll_window
            now = @clock.call
            cost = weight_for_path(path)
            limit = gate(path)
            if !@backoff_until.nil? && @backoff_until > now
              deny(path, "backoff", cost, limit,
                   "Swap provider API is in backoff until #{@backoff_until}.")
            end
            if @used + cost > limit
              deny(path, "exhausted", cost, limit,
                   "Swap provider API weight budget exhausted (#{@used}+#{cost} > #{limit}).")
            end
            @used += cost
          end
          nil
        end

        def mark_rate_limited
          @monitor.synchronize do
            now = @clock.call
            @used = [@used, SOFT_CAP].max
            @backoff_until = now + BACKOFF_SECONDS
          end
          nil
        end

        private

        # The weight window rolls; the 429 backoff does NOT ride along with it.
        # Clearing it here cut a backoff arbitrarily short — mark_rate_limited
        # at second 59 of the window was forgiven one second later — so the
        # backoff expires on its own clock, checked in reserve. Mirrors JS.
        def roll_window
          now = @clock.call
          return if now - @window_start < WINDOW_SECONDS

          @window_start = now
          @used = 0
        end

        def gate(path)
          path == "create" ? CREATE_GATE : SOFT_CAP
        end

        # The denial carries its own diagnostics on the raised error: there is
        # no observer hook, because there was never a caller for one. Mirrors JS.
        def deny(path, reason, cost, limit, message)
          denial = {
            "provider" => @provider_id,
            "path" => path,
            "reason" => reason,
            "message" => message,
            "used" => @used,
            "cost" => cost,
            "gate" => limit,
            "window_start" => @window_start,
            **(@backoff_until.nil? ? {} : { "backoff_until" => @backoff_until })
          }
          raise WeightBudgetError.new(message, denial)
        end
      end
    end
  end
end
