# frozen_string_literal: true

require "yaml"

module OpenReceive
  module Server
    class Config
      attr_reader :nwc, :price_currencies, :swap, :logging

      def self.load(path: "openreceive.yml", env: ENV)
        file = path && File.exist?(path) ? YAML.safe_load(File.read(path)) || {} : {}
        new(file: file.transform_keys(&:to_s), env: env)
      end

      def initialize(file: {}, env: ENV)
        obsolete_token_key = %w[token_keys tokenKeys].find { |key| file.key?(key) }
        unless obsolete_token_key.nil?
          raise ArgumentError, "#{obsolete_token_key} is obsolete; the host stores server-only swap_data directly"
        end
        removed = %w[store storage database_url redis_url namespace].find { |key| file.key?(key) }
        raise ArgumentError, "#{removed} is not supported; OpenReceive has no storage configuration" unless removed.nil?
        @nwc = clean(env["OPENRECEIVE_NWC"]) || clean(file["nwc"])
        raw_currencies = file["price_currencies"] || ["USD"]
        @price_currencies = (raw_currencies.is_a?(String) ? raw_currencies.split(",") : Array(raw_currencies)).map { |item| item.to_s.strip.upcase }.reject(&:empty?).uniq
        @swap = file["swap"].is_a?(Hash) ? file["swap"] : {}
        @logging = file["logging"].is_a?(Hash) ? file["logging"] : {}
        freeze
      end

      def to_h
        {
          "nwc" => @nwc.nil? ? nil : "[REDACTED]",
          "price_currencies" => @price_currencies,
          "swap" => @swap,
          "logging" => @logging
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
