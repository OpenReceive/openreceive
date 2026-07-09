# frozen_string_literal: true

module OpenReceive
  module Server
    # In-memory invoice store used by tests and single-process hosts.
    #
    # The core `OpenReceive::InMemoryInvoiceKvStore` provides the full idempotency / uniqueness /
    # meta-CAS / state-machine surface but intentionally does NOT index by order_id / checkout_id
    # and has no list_by_* / list_open / ensure_schema (those belong to the durable store). The
    # Service needs them to group checkouts and to run the pending-invoice sweep, so this subclass
    # adds them by scanning the inherited in-memory index. It also adds `mark_superseded`, the
    # metadata mutation the create path uses when replacing an open checkout.
    #
    # It reuses the parent's `@by_invoice_id` index and private `deep_copy` directly, so all of the
    # idempotency, uniqueness, CAS, and mark_* semantics come straight from the core store.
    class InMemoryInvoiceStore < OpenReceive::InMemoryInvoiceKvStore
      TERMINAL_WORKFLOW_STATES = %w[
        settlement_action_completed
        expired_closed
        failed_closed
        cancelled
      ].freeze

      # No-op: the in-memory store has no schema to create. Present for API parity with the
      # durable store so the Service can call it unconditionally.
      def ensure_schema
        self
      end

      def list_by_order_id(order_id)
        all_rows.select { |row| Models.stored_order_id(row) == order_id }
      end

      def list_by_checkout_id(checkout_id)
        all_rows.select { |row| safe_checkout_id(row) == checkout_id }
      end

      # Open = not terminal and not past its wallet-reported expiry, oldest first (mirrors the
      # Node memory store's listOpen ordering used by the transaction-scan window).
      def list_open(now:, limit: 1000)
        threshold = Integer(now)
        open = all_rows.reject { |row| terminal?(row) }
        open.select! { |row| Integer(row["expires_at"]) > threshold }
        open.sort! do |left, right|
          if Integer(left["created_at"]) == Integer(right["created_at"])
            left["invoice_id"] <=> right["invoice_id"]
          else
            Integer(left["created_at"]) <=> Integer(right["created_at"])
          end
        end
        open.first(Integer(limit))
      end

      # Mark a checkout's invoices superseded (write metadata.superseded = true). Returns the
      # updated row copy, or nil when the invoice is unknown.
      def mark_superseded(invoice_id:)
        row = @by_invoice_id[invoice_id]
        return nil if row.nil?

        row["metadata"] ||= {}
        row["metadata"]["superseded"] = true
        deep_copy(row)
      end

      private

      def all_rows
        @by_invoice_id.values.map { |row| deep_copy(row) }
      end

      def safe_checkout_id(row)
        Models.stored_checkout_id(row)
      rescue StandardError
        nil
      end

      def terminal?(row)
        TERMINAL_WORKFLOW_STATES.include?(row["workflow_state"])
      end
    end
  end
end
