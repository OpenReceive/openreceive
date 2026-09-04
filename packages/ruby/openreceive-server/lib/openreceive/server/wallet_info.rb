# frozen_string_literal: true

require "openreceive"

module OpenReceive
  module Server
    # NIP-47 wallet service info normalization (the kind 13194 info payload),
    # ported from the JS summarizeWalletCapabilities and locked to the shared
    # spec/test-vectors/nwc-info.json vectors: method-name normalization,
    # encryption-mode choice, spend-capability detection, and receive
    # readiness must be identical in both engines.
    module WalletInfo
      # Kernel vocabulary (spec/data/kernel-tables.json), shared with the JS
      # engine and the BTCPay plugin.
      REQUIRED_RECEIVE_METHODS = OpenReceive::Generated::NWC_REQUIRED_RECEIVE_METHODS
      SPEND_METHODS = OpenReceive::Generated::NWC_SPEND_METHODS

      module_function

      def summarize(raw_info)
        unwrapped = OpenReceive::Nwc.unwrap(raw_info)
        info = OpenReceive.stringify(unwrapped)
        raw_methods = %w[methods capabilities supported_methods supportedMethods]
                      .map { |key| info[key] }
                      .find { |value| !value.nil? }
        raw_methods = unwrapped if raw_methods.nil? && unwrapped.is_a?(String)
        methods = string_list(raw_methods).map { |name| normalize_method_name(name) }
        encryption = choose_encryption_mode(
          string_list(info["encryption"].nil? ? info["encryptions"] : info["encryption"])
        )
        spend_methods = methods.select { |name| SPEND_METHODS.include?(name) }
        missing_methods = REQUIRED_RECEIVE_METHODS.reject { |name| methods.include?(name) }
        {
          "methods" => methods,
          "encryption" => encryption,
          "spend_capability_advertised" => !spend_methods.empty?,
          "receive_checkout_ready" => missing_methods.empty?,
          "warnings" => spend_methods.map do |name|
            "Wallet advertises spend method '#{name}'; OpenReceive checkout will not expose it."
          end
        }
      end

      def choose_encryption_mode(encryption_modes)
        normalized = encryption_modes.map { |mode| mode.downcase.gsub(/[- ]/, "_") }
        if (normalized & %w[nip44_v2 nip44 nip_44]).any?
          "nip44_v2"
        elsif normalized.empty? || normalized.include?("nip04") || normalized.include?("nip_04")
          # No advertised list at all: assume the NIP-47 baseline (NIP-04).
          "nip04"
        end
        # An advertised list containing no mode we speak returns nil so
        # preflight can fail loudly instead of failing cryptically at RPC time.
      end

      def string_list(value)
        if value.is_a?(Array)
          value.select { |item| item.is_a?(String) }.map(&:strip).reject(&:empty?)
        elsif value.is_a?(String)
          value.split(/[,\s]+/).map(&:strip).reject(&:empty?)
        else
          []
        end
      end

      def normalize_method_name(value)
        value.strip.gsub(/([a-z0-9])([A-Z])/, '\1_\2').gsub(/[-\s]+/, "_").downcase
      end
    end
  end
end
