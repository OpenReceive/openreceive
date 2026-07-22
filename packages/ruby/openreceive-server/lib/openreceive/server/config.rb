# frozen_string_literal: true

require "yaml"

module OpenReceive
  module Server
    # Configuration loader — reads the SAME keys as the Node config (packages/js/node/config.ts):
    # lowercase YAML keys `nwc` / `namespace` / `store` / `price_currencies` plus nested
    # `operation`, `swap`, `logging`, and `sentry` blocks. YAML file first, then optional
    # OPENRECEIVE_* env-var overrides.
    #
    # The NWC connection string is a secret: it is stored but NEVER exposed by #inspect / #to_s.
    class Config
      OPERATION_KEYS = {
        "action_lease_ttl_seconds" => "OPENRECEIVE_ACTION_LEASE_TTL_SEC",
        "transaction_scan_interval_seconds" => "OPENRECEIVE_TRANSACTION_SCAN_INTERVAL_SEC",
        "transaction_scan_page_limit" => "OPENRECEIVE_TRANSACTION_SCAN_PAGE_LIMIT",
        "transaction_scan_window_padding_seconds" => "OPENRECEIVE_TRANSACTION_SCAN_WINDOW_PADDING_SEC",
        "transaction_scan_overlap_seconds" => "OPENRECEIVE_TRANSACTION_SCAN_OVERLAP_SEC",
        "sweep_open_invoice_cap" => "OPENRECEIVE_SWEEP_OPEN_INVOICE_CAP",
        "transaction_scan_timeout_ms" => "OPENRECEIVE_TRANSACTION_SCAN_TIMEOUT_MS"
      }.freeze

      attr_reader :nwc, :namespace, :store, :price_currencies, :operation, :swap, :logging, :sentry

      def self.load(path: "openreceive.yml", env: ENV)
        file = read_yaml(path)
        new(file: file, env: env)
      end

      def self.read_yaml(path)
        return {} if path.nil? || path.to_s.empty? || !File.exist?(path)

        parsed = YAML.safe_load(File.read(path)) || {}
        raise ArgumentError, "#{path} must be a YAML mapping." unless parsed.is_a?(Hash)

        stringify(parsed)
      end

      def self.stringify(value)
        case value
        when Hash then value.each_with_object({}) { |(k, v), acc| acc[k.to_s] = stringify(v) }
        when Array then value.map { |item| stringify(item) }
        else value
        end
      end

      def initialize(file: {}, env: ENV)
        @nwc = pick_string(file, env, %w[nwc], "OPENRECEIVE_NWC")
        @namespace = pick_string(file, env, %w[namespace], "OPENRECEIVE_NAMESPACE")
        @store = pick_string(file, env, %w[store], "OPENRECEIVE_STORE")
        @price_currencies = read_price_currencies(file, env)
        @operation = read_operation(file, env)
        @swap = read_record(file["swap"])
        @logging = read_record(file["logging"])
        @sentry = read_record(file["sentry"])
        freeze
      end

      def to_h
        {
          "nwc" => @nwc.nil? ? nil : "[REDACTED]",
          "namespace" => @namespace,
          "store" => @store,
          "price_currencies" => @price_currencies,
          "operation" => @operation,
          "swap" => @swap,
          "logging" => @logging,
          "sentry" => redacted_sentry
        }
      end

      # Never leak the NWC secret through inspection or logging.
      def redacted_nwc
        return nil if @nwc.nil?

        begin
          OpenReceive.redact_nwc_uri(@nwc)
        rescue StandardError
          "[REDACTED]"
        end
      end

      def inspect
        "#<OpenReceive::Server::Config namespace=#{@namespace.inspect} store=#{@store.inspect} " \
          "nwc=#{redacted_nwc.inspect} price_currencies=#{@price_currencies.inspect}>"
      end

      def to_s
        inspect
      end

      private

      def pick_string(file, env, keys, env_key)
        env_value = clean_string(env[env_key]) if env.respond_to?(:[])
        return env_value unless env_value.nil?

        keys.each do |key|
          value = clean_string(file[key])
          return value unless value.nil?
        end
        nil
      end

      def read_price_currencies(file, env)
        raw = env_value(env, "OPENRECEIVE_PRICE_CURRENCIES") || file["price_currencies"]
        list =
          case raw
          when nil then nil
          when String then raw.split(",")
          when Array then raw
          else raise ArgumentError, "price_currencies must be a comma string or array."
          end
        return nil if list.nil?

        normalized = list.map { |item| item.to_s.strip.upcase }.reject(&:empty?).uniq
        normalized.empty? ? nil : normalized
      end

      def read_operation(file, env)
        nested = read_record(file["operation"])
        result = {}
        OPERATION_KEYS.each do |file_key, env_key|
          value = env_value(env, env_key) || nested[file_key] || file[file_key]
          next if value.nil? || value.to_s.strip.empty?

          result[file_key] = Integer(value.to_s.strip)
        rescue ArgumentError
          raise ArgumentError, "#{file_key} must be an integer."
        end
        result
      end

      def read_record(value)
        value.is_a?(Hash) ? value : {}
      end

      def redacted_sentry
        return @sentry if @sentry.nil? || @sentry.empty?
        return @sentry unless @sentry.key?("dsn")

        @sentry.merge("dsn" => "[REDACTED]")
      end

      def env_value(env, key)
        return nil unless env.respond_to?(:[])

        clean_string(env[key])
      end

      def clean_string(value)
        return nil unless value.is_a?(String)

        trimmed = value.strip
        trimmed.empty? ? nil : trimmed
      end
    end
  end
end
