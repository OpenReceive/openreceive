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
        # The denial diagnostics (provider, path, reason, backoff, and
        # used/cost/gate and the window start for a guard that counts) ride
        # the error itself.
        attr_reader :denial

        def initialize(message, denial = {})
          super(message)
          @denial = denial
        end

        def weight_budget?
          true
        end
      end

      FIXEDFLOAT_HOST = "ff.io"

      # The per-window count the guard keeps for a provider that needs one.
      # Every call adds its weight to the window; a create may bring the
      # window up to the whole soft cap, and the calls that are not creates
      # (status, refund, catalog) may use only non_create_cap of it between
      # them, so open swap screens polling their status never starve new
      # swaps.
      #
      # - soft_cap: weight every call in one window may add up to.
      # - non_create_cap: weight the calls that are not creates may use
      #   between them in one window.
      SwapProviderLocalBudget = Struct.new(
        :soft_cap, :non_create_cap, :create_weight, :default_weight,
        keyword_init: true
      )

      # How the request guard treats one provider. The provider remains the
      # authority: its 429 always starts a stand-off. Only FixedFloat's own
      # host also gets a local count. Twin of the JS SwapProviderLimits; the
      # numbers are pinned across engines by
      # spec/test-vectors/swap-provider-limits.json.
      #
      # - profile: "fixedfloat" for FixedFloat's own host; "provider-only"
      #   for every other.
      # - local_budget: the per-window count (a SwapProviderLocalBudget), or
      #   nil when the guard keeps none and only obeys the provider's 429.
      # - backoff_seconds: stand-off after a 429 that names no wait.
      # - min_backoff_seconds, max_backoff_seconds: shortest and longest
      #   stand-off a 429's own wait is honored for.
      # - create_backoff_only: true when the provider counts new swaps apart
      #   from its other calls, so a 429 answering a create stops creates
      #   only. Status and refund calls for swaps that already exist keep
      #   working.
      SwapProviderLimits = Struct.new(
        :profile, :local_budget,
        :backoff_seconds, :min_backoff_seconds, :max_backoff_seconds, :create_backoff_only,
        keyword_init: true
      ) do
        # The limits to guard a provider API with, chosen by its HTTPS host:
        # ff.io or a subdomain of it is FixedFloat's and is counted locally;
        # every other host, and a URL that does not parse, only obeys the
        # provider's 429.
        def self.for_base_url(base_url)
          host =
            begin
              URI.parse(base_url.to_s.strip).host.to_s.downcase
            rescue URI::InvalidURIError
              ""
            end
          if host == FIXEDFLOAT_HOST || host.end_with?(".#{FIXEDFLOAT_HOST}")
            FIXEDFLOAT_SWAP_PROVIDER_LIMITS
          else
            PROVIDER_ONLY_SWAP_PROVIDER_LIMITS
          end
        end
      end

      # FixedFloat: 250 weight a minute per key, a create costs 50, and going
      # over blocks the key for longer each time. So the guard counts: 200
      # weight a minute in all, of which the calls that are not creates may
      # use 50. At least three creates a minute always fit, four when nothing
      # else ran. A 429 stops every call for at least a minute.
      FIXEDFLOAT_SWAP_PROVIDER_LIMITS = SwapProviderLimits.new(
        profile: "fixedfloat",
        local_budget: SwapProviderLocalBudget.new(
          soft_cap: 200,
          non_create_cap: 50,
          create_weight: 50,
          default_weight: 1
        ).freeze,
        backoff_seconds: 60,
        min_backoff_seconds: 60,
        max_backoff_seconds: 3_600,
        create_backoff_only: false
      ).freeze

      # Every other provider (Lightning Swap, one this library does not know,
      # a test fake): no local count. The provider limits its own accounts
      # and says so with a 429; a count of this library's own could only
      # refuse payers the provider would have accepted. A 429 that answered a
      # create stops creates only, for the wait it names (1 to 300 seconds; a
      # minute when it names none). Lightning Swap answers this way: it
      # counts new swaps apart from its other calls, per account, and names
      # the wait in Retry-After.
      PROVIDER_ONLY_SWAP_PROVIDER_LIMITS = SwapProviderLimits.new(
        profile: "provider-only",
        local_budget: nil,
        backoff_seconds: 60,
        min_backoff_seconds: 1,
        max_backoff_seconds: 300,
        create_backoff_only: true
      ).freeze

      # Ruby port of packages/js/node/src/swap/weight-budget.ts: a disposable
      # per-process request guard that follows the provider's limits; the
      # provider remains the global rate-limit authority.
      class SwapProviderWeightBudget
        WINDOW_SECONDS = 60

        def initialize(provider_id, clock, limits = PROVIDER_ONLY_SWAP_PROVIDER_LIMITS)
          @provider_id = provider_id
          @clock = clock
          @limits = limits
          @window_start = clock.call
          @used = 0
          @non_create_used = 0
          @backoff_until = nil
          @create_backoff_until = nil
          @monitor = Monitor.new
        end

        attr_reader :limits

        # Raise the same denial reserve would, without using any budget. Lets
        # a caller refuse a new swap before it does any other work for it.
        def assert_available(path)
          @monitor.synchronize { check(path) }
          nil
        end

        def reserve(path)
          @monitor.synchronize do
            cost = check(path)
            unless cost.nil?
              @used += cost
              @non_create_used += cost unless path == "create"
            end
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
              @non_create_used = 0
            end
          end
          nil
        end

        private

        # Deny `path`, or return what reserving it costs (nil: nothing is
        # counted). Under the monitor.
        def check(path)
          roll_window
          budget = @limits.local_budget
          backoff_until = active_backoff(path, @clock.call)
          unless backoff_until.nil?
            deny(path, "backoff", "Swap provider API is in backoff until #{backoff_until}.",
                 budget.nil? ? nil : weigh(path, budget), backoff_until)
          end
          return nil if budget.nil?

          cost = path == "create" ? budget.create_weight : budget.default_weight
          if @used + cost > budget.soft_cap
            deny(path, "exhausted",
                 "Swap provider API weight budget exhausted (#{@used}+#{cost} > #{budget.soft_cap}).",
                 [@used, cost, budget.soft_cap])
          end
          if path != "create" && @non_create_used + cost > budget.non_create_cap
            deny(path, "exhausted",
                 "Swap provider API weight budget for calls other than creates exhausted " \
                 "(#{@non_create_used}+#{cost} > #{budget.non_create_cap}).",
                 [@non_create_used, cost, budget.non_create_cap])
          end
          cost
        end

        # [used, cost, gate] for the cap `path` is counted against.
        def weigh(path, budget)
          if path == "create"
            [@used, budget.create_weight, budget.soft_cap]
          else
            [@non_create_used, budget.default_weight, budget.non_create_cap]
          end
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
          @non_create_used = 0
        end

        # The denial carries its own diagnostics on the raised error: there is
        # no observer hook, because there was never a caller for one. Mirrors JS.
        def deny(path, reason, message, weight = nil, backoff_until = nil)
          used, cost, gate = weight
          denial = {
            "provider" => @provider_id,
            "path" => path,
            "reason" => reason,
            "message" => message,
            "used" => used,
            "cost" => cost,
            "gate" => gate,
            "window_start" => @limits.local_budget.nil? ? nil : @window_start,
            "backoff_until" => backoff_until || @backoff_until
          }.compact
          raise WeightBudgetError.new(message, denial)
        end
      end
    end
  end
end
