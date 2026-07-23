# frozen_string_literal: true

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
