# frozen_string_literal: true

require "uri"

module OpenReceive
  module Server
    module LscUri
      SCHEME = "lightning+swapconnect"
      ENV_NAMES = %w[LSC_URI_PRIMARY LSC_URI_BACKUP].freeze
      QUERY_PARAMETERS = %w[key secret].freeze
      MAX_URI_LENGTH = 8192
      MAX_CREDENTIAL_LENGTH = 2048

      module_function

      def parse(value)
        input = credential(value, "LSC URI", MAX_URI_LENGTH)
        uri = URI.parse(input)
        raise ArgumentError, "LSC URI must use #{SCHEME}://." unless uri.scheme == SCHEME
        raise ArgumentError, "LSC URI must not use URI userinfo." unless uri.userinfo.nil?
        raise ArgumentError, "LSC URI requires a provider hostname." if uri.host.to_s.empty?
        raise ArgumentError, "LSC URI must not contain a fragment." unless uri.fragment.nil?
        raise ArgumentError, "LSC URI query encoding is invalid." if uri.query.to_s.match?(/%(?![0-9a-f]{2})/i)

        begin
          pairs = URI.decode_www_form(uri.query.to_s)
        rescue ArgumentError
          raise ArgumentError, "LSC URI query encoding is invalid."
        end
        unsupported = pairs.map(&:first).find { |name| !QUERY_PARAMETERS.include?(name) }
        raise ArgumentError, "LSC URI contains an unsupported query parameter." unless unsupported.nil?

        key = credential(single_parameter(pairs, "key"), "LSC URI key", MAX_CREDENTIAL_LENGTH)
        secret = credential(single_parameter(pairs, "secret"), "LSC URI secret", MAX_CREDENTIAL_LENGTH)
        path = normalize_path(uri.path)
        port = uri.port.nil? ? "" : ":#{uri.port}"

        {
          "uri_protocol" => "#{SCHEME}:",
          "base_url" => "https://#{uri.host}#{port}#{path}",
          "provider_id" => provider_id(uri),
          "key" => key,
          "secret" => secret
        }.freeze
      rescue URI::InvalidURIError
        raise ArgumentError, "LSC URI is not a valid absolute URI."
      end

      def read_environment(env = ENV)
        provider_ids = {}
        ENV_NAMES.each_with_object([]) do |name, connections|
          value = env[name].to_s.strip
          next if value.empty?

          connection = parse(value)
          id = connection.fetch("provider_id")
          raise ArgumentError, "#{name} duplicates another LSC provider id." if provider_ids[id]

          provider_ids[id] = true
          connections << connection
        rescue ArgumentError => e
          raise ArgumentError, "#{name} is invalid: #{e.message}"
        end.freeze
      end

      def single_parameter(pairs, name)
        values = pairs.each_with_object([]) do |(key, value), matches|
          matches << value if key == name
        end
        raise ArgumentError, "LSC URI requires exactly one #{name} parameter." unless values.length == 1

        values.first
      end
      private_class_method :single_parameter

      def credential(value, label, maximum_length)
        normalized = value.to_s.strip
        raise ArgumentError, "#{label} must not be empty." if normalized.empty?
        raise ArgumentError, "#{label} is too long." if normalized.length > maximum_length

        normalized
      end
      private_class_method :credential

      def normalize_path(path)
        return "/" if path.to_s.empty? || path == "/"

        path.end_with?("/") ? path : "#{path}/"
      end
      private_class_method :normalize_path

      def provider_id(uri)
        path = uri.path.to_s.split("/").reject(&:empty?).join("-")
        port = uri.port.nil? ? "" : "-#{uri.port}"
        raw = "#{uri.host}#{port}#{path.empty? ? '' : "-#{path}"}"
              .downcase.gsub(/[^a-z0-9_-]+/, "-").gsub(/\A-+|-+\z/, "")[0, 64]
        raise ArgumentError, "LSC URI could not derive a provider id." if raw.to_s.empty?

        raw
      end
      private_class_method :provider_id
    end
  end
end
