# frozen_string_literal: true

require "json"

module OpenReceive
  module Server
    # Prepared-order amount-authority persistence — Ruby port of
    # packages/js/http/src/prepared-order-store.ts.
    #
    # POST /prepare persists `{ amount, summary?, metadata? }` under `host_order:<orderId>`.
    # POST /checkouts and GET /orders/{id}/summary read that row back.
    class PreparedOrderStore
      PREPARED_ORDER_META_PREFIX = "host_order:"

      def initialize(store, prefix: PREPARED_ORDER_META_PREFIX)
        raise ArgumentError, "PreparedOrderStore: prefix must be non-empty" if prefix.to_s.empty?

        @store = store
        @prefix = prefix.to_s
      end

      def meta_key(order_id)
        raise ArgumentError, "PreparedOrderStore: order_id must be a non-empty string" unless order_id.is_a?(String) && !order_id.empty?

        "#{@prefix}#{order_id}"
      end

      # Upsert: read current rev, cas, retry once on conflict (mirrors JS persist).
      def persist(order_id, stored)
        key = meta_key(order_id)
        payload = JSON.generate(stored)
        current = @store.get_meta(key)
        first = @store.cas_meta(key: key, value: payload, expected_rev: current.nil? ? nil : current["rev"])
        return if first["status"] == "ok"

        again = @store.get_meta(key)
        second = @store.cas_meta(key: key, value: payload, expected_rev: again.nil? ? nil : again["rev"])
        return if second["status"] == "ok"

        raise "PreparedOrderStore: failed to persist prepared order"
      end

      # Returns the stored hash or nil when missing / malformed.
      def read(order_id)
        row = @store.get_meta(meta_key(order_id))
        return nil if row.nil?

        begin
          parsed = JSON.parse(row["value"])
        rescue JSON::ParserError
          return nil
        end
        return nil unless stored_prepared_order?(parsed)

        parsed
      end

      private

      def stored_prepared_order?(value)
        return false unless value.is_a?(Hash)

        amount = value["amount"]
        return false unless amount.is_a?(Hash)

        sats = amount["sats"]
        return true if sats.is_a?(String) || sats.is_a?(Numeric)

        amount["currency"].is_a?(String) && amount["value"].is_a?(String)
      end
    end
  end
end
