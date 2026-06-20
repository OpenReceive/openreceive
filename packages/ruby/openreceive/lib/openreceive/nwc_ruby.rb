# frozen_string_literal: true

require "openreceive"

module OpenReceive
  class NwcRubyReceiveClient
    attr_reader :redacted_connection_uri

    def initialize(client:, connection_uri: nil)
      @client = client
      @redacted_connection_uri = connection_uri.nil? ? nil : OpenReceive.redact_nwc_uri(connection_uri)
      OpenReceive.parse_nwc_uri(connection_uri) unless connection_uri.nil?
    end

    def make_invoice(request)
      params = OpenReceive.make_invoice_nip47_request(request)
      response = call_receive_method(
        :make_invoice,
        :makeInvoice,
        params,
        keyword_params: symbolize_keys(params)
      )
      OpenReceive.normalize_make_invoice_response(response)
    end

    def lookup_invoice(request)
      params = OpenReceive.lookup_invoice_nip47_request(request)
      response = call_receive_method(
        :lookup_invoice,
        :lookupInvoice,
        params,
        keyword_params: symbolize_keys(params)
      )
      OpenReceive.normalize_lookup_invoice_response(response)
    end

    def preflight
      return {} unless @client.respond_to?(:get_info) || @client.respond_to?(:getInfo)

      response = call_receive_method(:get_info, :getInfo)
      stringify_keys(response)
    end

    private

    def call_receive_method(snake_name, camel_name, params = nil, keyword_params: nil)
      method_name =
        if @client.respond_to?(snake_name)
          snake_name
        elsif @client.respond_to?(camel_name)
          camel_name
        else
          raise NoMethodError, "NWC client does not expose #{snake_name}"
        end

      return @client.public_send(method_name) if params.nil?

      begin
        @client.public_send(method_name, **keyword_params)
      rescue ArgumentError, KeyError
        @client.public_send(method_name, params)
      end
    end

    def stringify_keys(value)
      return {} unless value.respond_to?(:each_pair)

      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_s] = item
      end
    end

    def symbolize_keys(value)
      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_sym] = item
      end
    end
  end
end
