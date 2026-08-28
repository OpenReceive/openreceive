# frozen_string_literal: true

module ButtonShop
  module Testkit
    # An in-memory swap provider, and a PORT of packages/js/testkit's
    # TestkitSwapProvider — same deposit addresses, same `testkit-swap-N` order
    # ids, same "1.05" pay amount — so the same Playwright assertions hold
    # against Rails and against the Node stacks.
    #
    # The contract is duck-typed by OpenReceive::Server::Service, and it is the
    # FixedFloat provider's public surface: `name`, `supported_pay_in_assets`,
    # `pay_in_asset_catalog`, `invoice_expiry_seconds`, `quote`, `create_swap`,
    # `get_status`, `request_refund`. The runtime attachments the real provider
    # takes (`attach_swap_cache` and friends) are all `respond_to?`-guarded by
    # the service, so a fake that has none of them is simply left alone.
    class SwapProvider
      # One address per NETWORK, not per asset: USDT_TRON and a hypothetical
      # second Tron token share a Tron address, which is exactly the ambiguity
      # the deposit panel's warning is about.
      NETWORK_DEPOSIT_ADDRESS = {
        "TRX" => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        "SOL" => "So11111111111111111111111111111111111111112",
        "ETH" => "0x1111111111111111111111111111111111111111"
      }.freeze

      PAY_AMOUNT = "1.05"
      # The shadow invoice must outlive the provider order; the service takes
      # this as a FLOOR when it mints.
      INVOICE_EXPIRY_SECONDS = 1_800
      DEPOSIT_EXPIRY_SECONDS = 900

      PROGRESS_ORDER = %w[
        creating_provider_order awaiting_deposit confirming exchanging paying_invoice completed
      ].freeze

      attr_reader :name

      def initialize(name: "fixedfloat", clock: -> { Time.now.to_i })
        @name = name
        @clock = clock
        @orders = {}
        # An asset scripted BEFORE any attempt exists arms the next attempt for
        # it — the harness advances a swap it has not created yet.
        @pending = {}
        @create_calls = 0
        @quote_calls = 0
        @status_calls = 0
        @refund_calls = []
        @lock = Mutex.new
      end

      def supported_pay_in_assets
        OpenReceive::Server::Swap::Assets::PAY_IN_ASSETS.dup
      end

      def pay_in_asset_catalog
        supported_pay_in_assets.map do |pay_in_asset|
          {
            "pay_asset" => pay_in_asset,
            "available" => true,
            "minimum_pay_amount" => "1",
            "maximum_pay_amount" => "5000"
          }
        end
      end

      def invoice_expiry_seconds(pay_in_asset: nil)
        INVOICE_EXPIRY_SECONDS
      end

      def quote(pay_in_asset:, invoice_amount_msats:)
        @lock.synchronize { @quote_calls += 1 }
        {
          "pay_amount" => PAY_AMOUNT,
          "pay_asset" => pay_in_asset,
          "available" => true,
          "provider" => @name,
          "minimum_pay_amount" => "1",
          "maximum_pay_amount" => "5000"
        }
      end

      def create_swap(pay_in_asset:, bolt11:, invoice_amount_msats:)
        @lock.synchronize do
          @create_calls += 1
          provider_order_id = "testkit-swap-#{@create_calls}"
          order = {
            "provider" => @name,
            "provider_order_id" => provider_order_id,
            "provider_token" => "testkit-token-#{@create_calls}",
            "pay_in_asset" => pay_in_asset,
            "deposit_address" => deposit_address_for(pay_in_asset),
            "deposit_amount" => PAY_AMOUNT,
            "expires_at" => @clock.call + DEPOSIT_EXPIRY_SECONDS,
            "state" => "awaiting_deposit"
          }
          armed = @pending.delete(pay_in_asset)
          @orders[provider_order_id] = {
            "order" => order,
            "steps" => armed.nil? ? [] : armed.fetch("steps").dup,
            "next" => 0,
            "attention_reason" => armed&.dig("attention_reason")
          }
          order
        end
      end

      # One step per poll, then hold on the last state — the harness advances a
      # swap by letting the page poll, which is how a payer experiences it.
      def get_status(order)
        stored_id = OpenReceive.stringify(order).fetch("provider_order_id")
        @lock.synchronize do
          @status_calls += 1
          entry = @orders[stored_id]
          return order if entry.nil?

          if entry.fetch("next") < entry.fetch("steps").length
            state = entry.fetch("steps")[entry.fetch("next")]
            entry["next"] += 1
            entry["order"] = apply_state(entry.fetch("order"), state, entry["attention_reason"])
          end
          entry.fetch("order")
        end
      end

      def request_refund(order, refund_address)
        stored_id = OpenReceive.stringify(order).fetch("provider_order_id")
        @lock.synchronize do
          @refund_calls << { "provider_order_id" => stored_id, "refund_address" => refund_address }
          entry = @orders[stored_id]
          entry["order"] = apply_state(entry.fetch("order"), "refund_pending", nil) unless entry.nil?
        end
        nil
      end

      # ------------------------------------------------------------- controls

      # Queue states for the selected attempts, and arm the asset so an attempt
      # created later gets them too.
      def script(selector, states, attention_reason: nil)
        raise ArgumentError, "swap script must include at least one state" if states.empty?

        @lock.synchronize do
          match(selector).each do |entry|
            entry["steps"] = states.dup
            entry["next"] = 0
            entry["attention_reason"] = attention_reason
          end
          asset = selector["pay_in_asset"]
          @pending[asset] = { "steps" => states.dup, "attention_reason" => attention_reason } if asset
        end
      end

      # `refund_required` and `attention` land IMMEDIATELY rather than on the
      # next poll: they are the states a test jumps to, and waiting a poll for
      # them only makes the harness flakier.
      def force(selector, state, attention_reason: nil)
        @lock.synchronize do
          match(selector).each do |entry|
            entry["steps"] = []
            entry["next"] = 0
            entry["attention_reason"] = attention_reason
            entry["order"] = apply_state(entry.fetch("order"), state, attention_reason)
          end
          asset = selector["pay_in_asset"]
          @pending[asset] = { "steps" => [state], "attention_reason" => attention_reason } if asset
        end
      end

      def counters
        @lock.synchronize do
          {
            "create_calls" => @create_calls,
            "quote_calls" => @quote_calls,
            "status_calls" => @status_calls,
            "refund_calls" => @refund_calls.map(&:dup)
          }
        end
      end

      private

      def match(selector)
        provider_order_id = selector["provider_order_id"]
        asset = selector["pay_in_asset"]
        @orders.values.select do |entry|
          order = entry.fetch("order")
          next false if provider_order_id && order.fetch("provider_order_id") != provider_order_id
          next false if asset && order.fetch("pay_in_asset") != asset

          true
        end
      end

      def apply_state(order, state, attention_reason)
        next_order = order.merge("state" => state)
        next_order["deposit_tx_id"] = "testkit-deposit-tx" if at_or_after?(state, "confirming")
        next_order["payout_tx_id"] = "testkit-payout-tx" if state == "completed"
        next_order["refund_tx_id"] = "testkit-refund-tx" if state == "refunded"
        if state == "attention"
          next_order["attention"] = true
          next_order["attention_reason"] = attention_reason unless attention_reason.nil?
        end
        next_order
      end

      def at_or_after?(state, floor)
        state_index = PROGRESS_ORDER.index(state)
        floor_index = PROGRESS_ORDER.index(floor)
        !state_index.nil? && !floor_index.nil? && state_index >= floor_index
      end

      def deposit_address_for(pay_in_asset)
        network = OpenReceive::Server::Swap::Assets::ASSET_INFO
                  .fetch(pay_in_asset).fetch("network")
        NETWORK_DEPOSIT_ADDRESS.fetch(network)
      end
    end
  end
end
