# frozen_string_literal: true

# require_relative (not `require "openreceive"`): the gemspec loads version.rb only,
# and a load-path require here could resolve to an installed copy of the gem
# instead of this working tree.
require_relative "../openreceive"

module OpenReceive
  class NwcRubyReceiveClient
    # nwc-ruby names its listener `subscribe_to_notifications`; a host-supplied
    # client may use either OpenReceive spelling. A client with none of these
    # is not an error here — notifications are optional (see #respond_to?).
    NOTIFICATION_SUBSCRIBE_METHODS = %i[
      subscribe_to_notifications
      subscribe_notifications
      subscribeNotifications
    ].freeze

    # NIP-47 spells the list_transactions window `until`, which cannot be a
    # Ruby keyword-argument name; nwc-ruby declares it as `until_ts`. Aliases
    # are tried in order against the names the client's method accepts.
    KEYWORD_ALIASES = { until: %i[until_ts] }.freeze

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

    def list_transactions(request)
      params = OpenReceive.list_transactions_nip47_request(request)
      response = call_receive_method(
        :list_transactions,
        :listTransactions,
        params,
        keyword_params: symbolize_keys(params)
      )
      OpenReceive.normalize_list_transactions_response(response)
    end

    def preflight
      return nil unless @client.respond_to?(:get_info) || @client.respond_to?(:getInfo)

      response = call_receive_method(:get_info, :getInfo)
      stringify_keys(response)
    end

    # Opt-in NWC-02 notifications, forwarded from the wrapped client.
    #
    # nwc-ruby yields a NwcRuby::NIP47::Notification value object, while every
    # other method in that gem returns the NIP-47 payload as a hash and
    # OpenReceive.listen_for_notifications! consumes the NWC-02 wire shape
    # (`notification_type` plus the transaction-shaped `notification`). This
    # translates the object back to that shape, so the shared settlement rule
    # reads the same fields it reads on a list_transactions row —
    # `state`/`settled_at`, never a preimage alone. Clients that already yield
    # the wire hash pass through untouched.
    #
    # Returns whatever the wrapped subscription returns; nwc-ruby's blocks
    # until the subscription ends, which is the contract
    # listen_for_notifications! documents for blocking clients.
    def subscribe_notifications(notification_types = nil, &handler)
      method_name = notification_subscribe_method
      if method_name.nil?
        raise NoMethodError, "NWC client does not expose subscribe_to_notifications"
      end

      wanted = notification_types.nil? ? nil : Array(notification_types).map(&:to_s)
      @client.public_send(method_name) do |notification|
        payload = notification_wire_payload(notification)
        # Defense in depth: NWC-02 has no per-type subscription filter (the
        # relay filters by kind), so the wallet decides what it publishes.
        handler.call(payload) if wanted_notification?(payload, wanted)
      end
    end

    # OpenReceive.listen_for_notifications! duck-types this method to tell an
    # operator plainly that a client cannot notify ("notifications are
    # optional; keep polling") instead of failing mid-subscription. Answering
    # for a client with no listener would trade that message for an obscure
    # one, so the adapter reports the capability of the client it wraps.
    def respond_to?(name, include_private = false)
      return !notification_subscribe_method.nil? if name.to_sym == :subscribe_notifications

      super
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

      accepted = accepted_keywords(method_name)
      return @client.public_send(method_name, params) if accepted.nil?

      @client.public_send(method_name, **keyword_arguments(keyword_params, accepted))
    end

    # How this client takes NIP-47 params: nil for one positional hash (the
    # OpenReceive request shape), :any for a **rest client, or the exact
    # keyword names it declares. Introspection beats trial and error — a
    # keyword call naming a parameter the client does not declare raises
    # ArgumentError from inside the client, and retrying positionally then
    # fails with an opaque "wrong number of arguments (given 1, expected 0)"
    # that names neither the method nor the parameter.
    def accepted_keywords(method_name)
      parameters = @client.method(method_name).parameters
      return nil if parameters.any? { |kind, _| %i[req opt rest].include?(kind) }
      return :any if parameters.any? { |kind, _| kind == :keyrest }

      parameters.filter_map { |kind, name| name if %i[key keyreq].include?(kind) }
    rescue NameError
      # No Method object to introspect (a method_missing-based client).
      nil
    end

    # Maps NIP-47 param names onto the names the client declares. A param the
    # client cannot express raises rather than being dropped: `from`/`until`
    # bound the scan window that reconciliation reasons about, and a silently
    # widened window is a settlement decision made on different data than the
    # engine asked for.
    def keyword_arguments(keyword_params, accepted)
      return keyword_params if accepted == :any

      keyword_params.each_with_object({}) do |(name, value), mapped|
        target = ([name] + KEYWORD_ALIASES.fetch(name, [])).find { |candidate| accepted.include?(candidate) }
        raise ArgumentError, "NWC client does not accept the NIP-47 `#{name}` parameter" if target.nil?

        mapped[target] = value
      end
    end

    def notification_subscribe_method
      NOTIFICATION_SUBSCRIBE_METHODS.find { |name| @client.respond_to?(name) }
    end

    # nwc-ruby's Notification exposes the type as `type` and the raw NWC-02
    # `notification` object as `data`. A Hash answers to neither, so a
    # wire-shaped payload — and anything unrecognized, which the engine drops
    # rather than mistaking for settlement — passes through unchanged.
    def notification_wire_payload(notification)
      return notification unless notification.respond_to?(:type) && notification.respond_to?(:data)

      {
        "notification_type" => notification.type.to_s,
        "notification" => stringify_keys(notification.data)
      }
    end

    def wanted_notification?(payload, wanted)
      return true if wanted.nil?
      return false unless payload.respond_to?(:[])

      type = payload["notification_type"] || payload[:notification_type] ||
             payload["type"] || payload[:type]
      wanted.include?(type.to_s)
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
