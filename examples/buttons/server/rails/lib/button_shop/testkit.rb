# frozen_string_literal: true

require Rails.root.join("lib/button_shop/testkit/wallet")
require Rails.root.join("lib/button_shop/testkit/swap_provider")

module ButtonShop
  # Testkit wallet mode for the Rails stack (`DEMO_WALLET=testkit`).
  #
  # The three Node stacks have had this since they were written; Rails did not,
  # which meant the one stack with its own database idiom could not be driven
  # through a swap — or a refund — without a live wallet and live FixedFloat
  # keys. The fakes are ports of packages/js/testkit down to the fixtures, so
  # tests/e2e drives Rails with the same helpers and the same strings.
  #
  # WHAT IS FAKED IS THE WALLET, THE SWAP PROVIDER AND THE PRICE FEED, and
  # nothing else. The engine, the three hooks, the migrations, the controllers,
  # ActionCable and the SPA are the production paths — which is the property
  # that makes driving this worth anything.
  #
  # It is OFF unless `DEMO_WALLET=testkit` is set: the compose files never set
  # it, `Testkit.enabled?` is read once at boot, and the control surface hard
  # 404s in every other mode.
  module Testkit
    CONTROL_PREFIX = "/__testkit"

    SWAP_PROVIDER_STATES = %w[
      creating_provider_order awaiting_deposit confirming exchanging paying_invoice completed
      expired refund_required refund_pending refunded attention failed
    ].freeze

    class << self
      def enabled?
        ENV["DEMO_WALLET"].to_s.strip.downcase == "testkit"
      end

      # The fakes, built once per process.
      #
      # Memoized on the module rather than in the initializer because Rails
      # reloads initializers in development, and a second wallet mid-checkout
      # would mint into a store the running checkout cannot see. lib/button_shop
      # is excluded from `autoload_lib`, so this constant is required once and
      # never reloaded.
      def wallet
        @wallet ||= Wallet.new
      end

      def swap_provider
        @swap_provider ||= SwapProvider.new
      end

      # One control call, mirroring shared/server-node/testkit-controls.ts
      # action for action and payload for payload. Returns [status, body].
      #
      # Not enabled means 404 for EVERY action — probing the surface from any
      # other mode proves it is off.
      def control(action, params)
        return [404, error_body(404, "Not found.")] unless enabled?

        case action
        when "settle" then settle(params)
        when "expire" then expire(params)
        when "swap-step" then swap_step(params)
        when "state" then [200, state]
        else [404, error_body(404, "Not found.")]
        end
      end

      private

      # POST /__testkit/settle { payment_hash } — settle the invoice. The next
      # payments/check poll or reconcile pass observes it through the
      # production rules; nothing here touches an order row.
      def settle(params)
        payment_hash = read_string(params, "payment_hash")
        return [400, error_body(400, "payment_hash is required")] if payment_hash.nil?

        [200, { "ok" => true, "transaction" => wallet.settle_invoice(payment_hash) }]
      rescue KeyError => e
        [404, error_body(404, e.message)]
      end

      # POST /__testkit/expire { payment_hash } — force the invoice expired.
      def expire(params)
        payment_hash = read_string(params, "payment_hash")
        return [400, error_body(400, "payment_hash is required")] if payment_hash.nil?

        [200, { "ok" => true, "transaction" => wallet.expire_invoice(payment_hash) }]
      rescue KeyError => e
        [404, error_body(404, e.message)]
      end

      # POST /__testkit/swap-step { provider_order_id?, pay_in_asset?, state, attention_reason? }
      #
      # Selected by the PROVIDER-side keys, because the fake provider has no
      # notion of the host order id — the same reason the Node control surface
      # takes them.
      def swap_step(params)
        provider_order_id = read_string(params, "provider_order_id")
        pay_in_asset = read_string(params, "pay_in_asset")
        state = read_string(params, "state")
        if provider_order_id.nil? && pay_in_asset.nil?
          return [400, error_body(400, "provider_order_id or pay_in_asset is required")]
        end
        unless SWAP_PROVIDER_STATES.include?(state)
          return [400, error_body(400, "state must be one of: #{SWAP_PROVIDER_STATES.join(', ')}")]
        end

        selector = { "provider_order_id" => provider_order_id, "pay_in_asset" => pay_in_asset }.compact
        if state == "refund_required"
          swap_provider.force(selector, state)
        elsif state == "attention"
          swap_provider.force(
            selector, state,
            attention_reason: read_string(params, "attention_reason") || "provider_reported_emergency"
          )
        else
          swap_provider.script(selector, [state])
        end
        [200, { "ok" => true, "state" => state }]
      end

      # GET /__testkit/state — the wallet's invoices and the provider counters.
      def state
        { "wallet" => { "invoices" => wallet.invoices }, "swap" => swap_provider.counters }
      end

      def read_string(params, field)
        value = params[field]
        value.is_a?(String) && !value.empty? ? value : nil
      end

      def error_body(status, message)
        {
          "code" => status == 404 ? "NOT_FOUND" : "INVALID_REQUEST",
          "message" => message,
          "retryable" => false
        }
      end
    end
  end
end
