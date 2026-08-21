# frozen_string_literal: true

require "openreceive"

module OpenReceive
  module Server
    module Swap
      # Ruby port of packages/js/node/src/swap/assets.ts: the OpenReceive
      # pay-in asset catalog (labels, network labels, provider matching) and
      # the network helpers the FixedFloat provider uses to map /ccies rows.
      module Assets
        PAY_IN_ASSETS = %w[
          SOL_SOL USDT_TRON USDT_SOL USDC_SOL ETH_ETH USDT_ETH USDC_ETH
        ].freeze

        ASSET_INFO = {
          "SOL_SOL" => {
            "pay_in_asset" => "SOL_SOL", "label" => "SOL", "network_label" => "Solana",
            "coin" => "SOL", "network" => "SOL", "expiry_seconds" => 900
          }.freeze,
          "USDT_TRON" => {
            "pay_in_asset" => "USDT_TRON", "label" => "USDT", "network_label" => "Tron",
            "coin" => "USDT", "network" => "TRX", "expiry_seconds" => 900
          }.freeze,
          "USDT_SOL" => {
            "pay_in_asset" => "USDT_SOL", "label" => "USDT", "network_label" => "Solana",
            "coin" => "USDT", "network" => "SOL", "expiry_seconds" => 900
          }.freeze,
          "USDC_SOL" => {
            "pay_in_asset" => "USDC_SOL", "label" => "USDC", "network_label" => "Solana",
            "coin" => "USDC", "network" => "SOL", "expiry_seconds" => 900
          }.freeze,
          "ETH_ETH" => {
            "pay_in_asset" => "ETH_ETH", "label" => "ETH", "network_label" => "Ethereum",
            "coin" => "ETH", "network" => "ETH", "expiry_seconds" => 1800
          }.freeze,
          "USDT_ETH" => {
            "pay_in_asset" => "USDT_ETH", "label" => "USDT", "network_label" => "Ethereum",
            "coin" => "USDT", "network" => "ETH", "expiry_seconds" => 1800
          }.freeze,
          "USDC_ETH" => {
            "pay_in_asset" => "USDC_ETH", "label" => "USDC", "network_label" => "Ethereum",
            "coin" => "USDC", "network" => "ETH", "expiry_seconds" => 1800
          }.freeze
        }.freeze

        module_function

        def pay_in_asset?(value)
          value.is_a?(String) && PAY_IN_ASSETS.include?(value)
        end

        def info(pay_in_asset)
          ASSET_INFO.fetch(pay_in_asset)
        end

        def list_info
          PAY_IN_ASSETS.map { |asset| ASSET_INFO.fetch(asset) }
        end

        def normalize_network(value)
          value.to_s.upcase.gsub(/[^A-Z0-9]+/, "")
        end

        def network_matches?(expected, actual)
          normalized_expected = normalize_network(expected)
          normalized_actual = normalize_network(actual)
          return true if normalized_actual == normalized_expected

          case normalized_expected
          when "TRX"
            %w[TRON TRC20 TRC].include?(normalized_actual)
          when "ETH"
            %w[ETHEREUM ERC20 ERC].include?(normalized_actual)
          when "SOL"
            normalized_actual == "SOLANA"
          else
            false
          end
        end

        def lightning_network?(value)
          %w[LN LIGHTNING LIGHTNINGNETWORK BTCLN BTCBOLT11].include?(normalize_network(value))
        end

        # Coarse shape-check of a deposit/refund address against the pay-in
        # asset's network. Delegates to the core gem's SwapAddress so both
        # engines share one rule set; callers raise their own error.
        def valid_swap_address_for_network?(pay_in_asset, address)
          OpenReceive::SwapAddress.valid_for_network?(info(pay_in_asset).fetch("network"), address)
        end
      end
    end
  end
end
