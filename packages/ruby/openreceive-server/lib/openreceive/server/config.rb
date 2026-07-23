# frozen_string_literal: true

require "yaml"
require "openreceive/server/tokens"

module OpenReceive
  module Server
    class Config
      attr_reader :nwc, :token_keys, :price_currencies, :swap, :logging

      def self.load(path: "openreceive.yml", env: ENV)
        file = path && File.exist?(path) ? YAML.safe_load(File.read(path)) || {} : {}
        new(file: file.transform_keys(&:to_s), env: env)
      end

      def initialize(file: {}, env: ENV)
        removed = %w[store storage database_url redis_url namespace].find { |key| file.key?(key) }
        raise ArgumentError, "#{removed} is not supported; OpenReceive has no storage configuration" unless removed.nil?
        @nwc = clean(env["OPENRECEIVE_NWC"]) || clean(file["nwc"])
        raw_keys = clean(env["OPENRECEIVE_TOKEN_KEYS"])
        @token_keys = raw_keys.nil? ? [] : Tokens.parse_keyring(raw_keys)
        raw_currencies = file["price_currencies"] || ["USD"]
        @price_currencies = (raw_currencies.is_a?(String) ? raw_currencies.split(",") : Array(raw_currencies)).map { |item| item.to_s.strip.upcase }.reject(&:empty?).uniq
        @swap = file["swap"].is_a?(Hash) ? file["swap"] : {}
        @logging = file["logging"].is_a?(Hash) ? file["logging"] : {}
        freeze
      end

      def to_h
        {
          "nwc" => @nwc.nil? ? nil : "[REDACTED]",
          "token_keys" => @token_keys.empty? ? "missing" : "#{@token_keys.length} configured",
          "price_currencies" => @price_currencies,
          "swap" => @swap,
          "logging" => @logging
        }
      end

      def inspect
        "#<OpenReceive::Server::Config storage=none nwc=#{@nwc.nil? ? 'missing' : '[REDACTED]'} token_keys=#{@token_keys.length}>"
      end

      private

      def clean(value)
        text = value.to_s.strip
        text.empty? ? nil : text
      end
    end
  end
end
