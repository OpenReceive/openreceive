# frozen_string_literal: true

require "openreceive"

module OpenReceive
  module Server
    module Swap
      # Ruby twin of packages/js/node/src/swap/assets.ts: the OpenReceive
      # pay-in asset catalog (labels, network labels, provider matching) and
      # the network helpers the FixedFloat provider uses to map /ccies rows.
      module Assets
        # The asset table is kernel vocabulary (spec/data/kernel-tables.json),
        # generated into every engine; this module adds the lookups and the
        # provider network matching on top of it.
        PAY_IN_ASSETS = OpenReceive::Generated::SWAP_PAY_IN_ASSETS
        ASSET_INFO = OpenReceive::Generated::SWAP_ASSET_INFO

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
      end
    end
  end
end
