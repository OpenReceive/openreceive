# frozen_string_literal: true

# require_relative (not `require "openreceive/core"`): the gemspec loads
# version.rb only, and a load-path require here could resolve to an installed
# copy of the gem instead of this working tree. The core file — never the
# `openreceive` umbrella, which loads this adapter — carries everything the
# adapter calls, so requiring this file directly keeps working.
require_relative "core"

module OpenReceive
  # Thin adapter binding the engine to the nwc-ruby gem (NwcRuby::Client).
  # The engine speaks NIP-47 wire names in string-keyed hashes; nwc-ruby
  # declares snake_case keyword arguments, and spells the list_transactions
  # window `until_ts` because `until` is a Ruby keyword.
  class NwcRubyReceiveClient
    attr_reader :redacted_connection_uri

    def initialize(client:, connection_uri: nil)
      @client = client
      @redacted_connection_uri = connection_uri.nil? ? nil : OpenReceive.redact_nwc_uri(connection_uri)
      OpenReceive.parse_nwc_uri(connection_uri) unless connection_uri.nil?
    end

    def make_invoice(request)
      params = symbolize_keys(OpenReceive.make_invoice_nip47_request(request))
      OpenReceive.normalize_make_invoice_response(@client.make_invoice(**params))
    end

    def list_transactions(request)
      params = symbolize_keys(OpenReceive.list_transactions_nip47_request(request))
      params[:until_ts] = params.delete(:until) if params.key?(:until)
      OpenReceive.normalize_list_transactions_response(@client.list_transactions(**params))
    end

    def preflight
      OpenReceive.stringify(@client.get_info)
    end

    # Opt-in NWC-02 notifications, forwarded from the wrapped client.
    #
    # nwc-ruby yields a NwcRuby::NIP47::Notification value object, while every
    # other method in that gem returns the NIP-47 payload as a hash and
    # OpenReceive.listen_for_notifications! consumes the NWC-02 wire shape
    # (`notification_type` plus the transaction-shaped `notification`). This
    # translates the object back to that shape, so the shared settlement rule
    # reads the same fields it reads on a list_transactions row —
    # `state`/`settled_at`, never a preimage alone. Every notification type is
    # forwarded; the engine filters `payment_received` itself, because an
    # NWC-02 subscription is not type-filtered — the wallet decides what it
    # publishes.
    #
    # Returns whatever subscribe_to_notifications returns; nwc-ruby's blocks
    # until the subscription ends, which is the contract
    # listen_for_notifications! documents for blocking clients.
    def subscribe_notifications(&handler)
      @client.subscribe_to_notifications do |notification|
        handler.call(
          "notification_type" => notification.type.to_s,
          "notification" => OpenReceive.stringify(notification.data)
        )
      end
    end

    private

    def symbolize_keys(value)
      value.each_pair.each_with_object({}) do |(key, item), result|
        result[key.to_sym] = item
      end
    end
  end
end
