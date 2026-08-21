# frozen_string_literal: true

require "openreceive/server/swap"

module OpenReceive
  module Server
    class Config
      attr_reader :nwc, :lsc_connections

      def self.load(env: ENV)
        new(env: env)
      end

      def initialize(env: ENV)
        @nwc = clean(env["NWC_URI"])
        @lsc_connections = OpenReceive::Server::LscUri.read_environment(env)
        freeze
      end

      # FixedFloat-compatible providers for the parsed LSC connections, in
      # env order (primary first, backup second) — the same providers the
      # Service auto-builds when constructed without swap_providers.
      def swap_providers(http: nil, now: nil)
        OpenReceive::Server::Swap.providers_from_connections(@lsc_connections, http: http, now: now)
      end

      def to_h
        {
          "NWC_URI" => @nwc.nil? ? nil : "[REDACTED]",
          "LSC_URI_connections" => @lsc_connections.length
        }
      end

      def inspect
        "#<OpenReceive::Server::Config storage=none nwc=#{@nwc.nil? ? 'missing' : '[REDACTED]'}>"
      end

      private

      def clean(value)
        text = value.to_s.strip
        text.empty? ? nil : text
      end
    end
  end
end
