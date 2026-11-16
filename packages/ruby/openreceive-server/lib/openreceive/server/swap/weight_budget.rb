# frozen_string_literal: true

require "monitor"
require "uri"

module OpenReceive
  module Server
    module Swap
      # Raised when a reservation would exceed the process-local weight budget.
      # Marked (weight_budget?) so quote classification can map it to
      # provider_rate_limited, mirroring the JS weightBudget error tag.
      class WeightBudgetError < StandardError
        # The denial diagnostics (provider, path, reason, used/cost/gate,
        # window start, backoff, creates) ride the error itself.
        attr_reader :denial

        def initialize(message, denial = {})
          super(message)
          @denial = denial
        end

        def weight_budget?
          true
        end
      end

      LIGHTNING_SWAP_HOST = "lightning-swap.com"

      # What one provider allows an API key per window, as far as the request
      # guard needs to know it. The guard exists so a busy site stays inside
      # the provider's limits; the provider remains the authority and its 429
      # always wins. Twin of the JS SwapProviderLimits; the numbers are pinned
      # across engines by spec/test-vectors/swap-provider-limits.json.
      #
      # - profile: whose published limits these are.
      # - soft_cap: weight every call in one window may add up to.
      # - create_gate: weight a create may bring the window up to.
      # - create_limit: creates per window, for a provider that counts them on
      #   their own; nil for one that does not.
      # - backoff_seconds: stand-off after a 429 that names no wait.
      # - min_backoff_seconds, max_backoff_seconds: shortest and longest
      #   stand-off a 429's own wait is honored for.
      # - create_backoff_only: true when the provider counts new swaps apart
      #   from its other calls, so a 429 answering a create stops creates
      #   only. Status and refund calls for swaps that already exist keep
      #   working.
      SwapProviderLimits = Struct.new(
        :profile, :soft_cap, :create_gate, :create_weight, :default_weight, :create_limit,
        :backoff_seconds, :min_backoff_seconds, :max_backoff_seconds, :create_backoff_only,
        keyword_init: true
      ) do
        # The limits to guard a provider API with, chosen by its HTTPS host:
        # lightning-swap.com or a subdomain of it is Lightning Swap; every
        # other host, and a URL that does not parse, gets the FixedFloat ones.
        def self.for_base_url(base_url)
          host =
            begin
              URI.parse(base_url.to_s.strip).host.to_s.downcase
            rescue URI::InvalidURIError
              ""
            end
          if host == LIGHTNING_SWAP_HOST || host.end_with?(".#{LIGHTNING_SWAP_HOST}")
            LIGHTNING_SWAP_PROVIDER_LIMITS
          else
            FIXEDFLOAT_SWAP_PROVIDER_LIMITS
          end
        end
      end

      # FixedFloat: 250 weight a minute per key, a create costs 50, and going
      # over blocks the key for longer each time. The guard stops well short:
      # three creates a minute, 200 weight in all. Also the default for a
      # provider this library does not know, because it is the stricter of
      # the two.
      FIXEDFLOAT_SWAP_PROVIDER_LIMITS = SwapProviderLimits.new(
        profile: "fixedfloat",
        soft_cap: 200,
        create_gate: 150,
        create_weight: 50,
        default_weight: 1,
        create_limit: nil,
        backoff_seconds: 60,
        min_backoff_seconds: 60,
        max_backoff_seconds: 3_600,
        create_backoff_only: false
      ).freeze

      # Lightning Swap: per account, 30 new swaps and 400 API calls a minute
      # once the account has completed a swap, every call counting as one. It
      # refuses with a 429 that says how long to wait and never blocks a key
      # for going over, so the guard sits at the limit itself. An account on
      # lower limits (one that has not completed a swap yet) is held to them
      # by the provider's own 429, which this guard then obeys.
      LIGHTNING_SWAP_PROVIDER_LIMITS = SwapProviderLimits.new(
        profile: "lightning-swap",
        soft_cap: 400,
        create_gate: 400,
        create_weight: 1,
        default_weight: 1,
        create_limit: 30,
        backoff_seconds: 60,
        min_backoff_seconds: 1,
        max_backoff_seconds: 300,
        create_backoff_only: true
      ).freeze

      # Ruby port of packages/js/node/src/swap/weight-budget.ts: a disposable
      # per-process request guard, sized by the provider's limits; the
      # provider remains the global rate-limit authority.
      class SwapProviderWeightBudget
        WINDOW_SECONDS = 60
        # The FixedFloat numbers under the names they had before the guard
        # was sized by provider.
        SOFT_CAP = FIXEDFLOAT_SWAP_PROVIDER_LIMITS.soft_cap
        CREATE_GATE = FIXEDFLOAT_SWAP_PROVIDER_LIMITS.create_gate
        CREATE_WEIGHT = FIXEDFLOAT_SWAP_PROVIDER_LIMITS.create_weight
        DEFAULT_WEIGHT = FIXEDFLOAT_SWAP_PROVIDER_LIMITS.default_weight
        BACKOFF_SECONDS = FIXEDFLOAT_SWAP_PROVIDER_LIMITS.backoff_seconds

        def initialize(provider_id, clock, limits = FIXEDFLOAT_SWAP_PROVIDER_LIMITS)
          @provider_id = provider_id
          @clock = clock
          @limits = limits
          @window_start = clock.call
          @used = 0
          @creates = 0
          @backoff_until = nil
          @create_backoff_until = nil
          @monitor = Monitor.new
        end

        def weight_for_path(path)
          path == "create" ? @limits.create_weight : @limits.default_weight
        end

        # Raise the same denial reserve would, without using any budget. Lets
        # a caller refuse a new swap before it does any other work for it.
        def assert_available(path)
          @monitor.synchronize { check(path) }
          nil
        end

        def reserve(path)
          @monitor.synchronize do
            check(path)
            @used += weight_for_path(path)
            @creates += 1 if path == "create"
          end
          nil
        end

        # The provider answered 429. `path` is the API path it answered and
        # `retry_after_seconds` the provider's own wait, from Retry-After or
        # its response body; nil when it named none. A later, shorter 429
        # never shortens a stand-off already running.
        def mark_rate_limited(path: nil, retry_after_seconds: nil)
          @monitor.synchronize do
            standoff_end = @clock.call + backoff_seconds(retry_after_seconds)
            if @limits.create_backoff_only && path == "create"
              @create_backoff_until = [@create_backoff_until || 0, standoff_end].max
            else
              @backoff_until = [@backoff_until || 0, standoff_end].max
              # The provider's own window is spent until then and fresh after
              # it, so this guard's window restarts when the stand-off ends.
              # Keeping the old count would go on refusing calls the provider
              # has started accepting.
              @window_start = @backoff_until
              @used = 0
              @creates = 0
            end
          end
          nil
        end

        private

        def check(path)
          roll_window
          now = @clock.call
          cost = weight_for_path(path)
          limit = gate(path)
          backoff_until = active_backoff(path, now)
          unless backoff_until.nil?
            deny(path, "backoff", cost, limit,
                 "Swap provider API is in backoff until #{backoff_until}.", backoff_until)
          end
          if @used + cost > limit
            deny(path, "exhausted", cost, limit,
                 "Swap provider API weight budget exhausted (#{@used}+#{cost} > #{limit}).")
          end
          create_limit = @limits.create_limit
          return unless path == "create" && !create_limit.nil? && @creates + 1 > create_limit

          deny(path, "exhausted", cost, limit,
               "Swap provider create budget exhausted (#{@creates}+1 > #{create_limit}).")
        end

        def backoff_seconds(retry_after_seconds)
          named = retry_after_seconds
          unless (named.is_a?(Integer) || named.is_a?(Float)) && named.finite? && named.positive?
            return @limits.backoff_seconds
          end

          named.ceil.clamp(@limits.min_backoff_seconds, @limits.max_backoff_seconds)
        end

        def active_backoff(path, now)
          return @backoff_until if !@backoff_until.nil? && @backoff_until > now
          if path == "create" && !@create_backoff_until.nil? && @create_backoff_until > now
            return @create_backoff_until
          end

          nil
        end

        # The weight window rolls; the 429 backoff does NOT ride along with it.
        # Clearing it here cut a backoff arbitrarily short — mark_rate_limited
        # at second 59 of the window was forgiven one second later — so the
        # backoff expires on its own clock, checked in check. Mirrors JS.
        def roll_window
          now = @clock.call
          return if now - @window_start < WINDOW_SECONDS

          @window_start = now
          @used = 0
          @creates = 0
        end

        def gate(path)
          path == "create" ? @limits.create_gate : @limits.soft_cap
        end

        # The denial carries its own diagnostics on the raised error: there is
        # no observer hook, because there was never a caller for one. Mirrors JS.
        def deny(path, reason, cost, limit, message, backoff_until = nil)
          denial = {
            "provider" => @provider_id,
            "path" => path,
            "reason" => reason,
            "message" => message,
            "used" => @used,
            "cost" => cost,
            "gate" => limit,
            "window_start" => @window_start,
            "backoff_until" => backoff_until || @backoff_until,
            "creates" => @limits.create_limit.nil? ? nil : @creates,
            "create_limit" => @limits.create_limit
          }.compact
          raise WeightBudgetError.new(message, denial)
        end
      end
    end
  end
end
