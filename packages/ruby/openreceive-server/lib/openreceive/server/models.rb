# frozen_string_literal: true

module OpenReceive
  module Server
    # Wire snapshot builders — the Ruby port of the Node service `models.ts`. These turn stored
    # invoice rows (String-keyed Hashes, one per invoice) into the canonical wire shapes defined
    # in spec/openapi/openreceive-http.v1.yaml: Invoice, Checkout, Order.
    #
    # order_id / checkout_id live in row["metadata"] (matching the Node KV stores and
    # readInvoiceStorageOrderId); the normalized ActiveRecord store additionally mirrors them to
    # top-level columns, so these helpers fall back to the top-level fields when present.
    module Models
      module_function

      def stored_order_id(row)
        from_metadata = dig_metadata(row, "order_id")
        return from_metadata if non_empty_string?(from_metadata)

        top_level = row["order_id"]
        return top_level if non_empty_string?(top_level)

        row["idempotency_key"]
      end

      def stored_checkout_id(row)
        from_metadata = dig_metadata(row, "checkout_id")
        return from_metadata if non_empty_string?(from_metadata)

        top_level = row["checkout_id"]
        return top_level if non_empty_string?(top_level)

        raise "Stored invoice is missing checkout metadata."
      end

      def invoice_rail(row)
        dig_metadata(row, "rail") == "swap" ? "swap" : "lightning"
      end

      def derive_invoice_status(row, now)
        return "settled" if present?(row["settled_at"]) || row["transaction_state"] == "settled"
        return "expired" if row["transaction_state"] == "expired" || row["workflow_state"] == "expired_closed"
        return "failed" if row["transaction_state"] == "failed" || row["workflow_state"] == "failed_closed"
        return "expired" if integer(row["expires_at"]) <= now

        "pending"
      end

      def serialize_invoice(row, now)
        rail = invoice_rail(row)
        invoice = {
          "invoice_id" => row["invoice_id"],
          "type" => "incoming",
          "rail" => rail,
          "status" => derive_invoice_status(row, now),
          "transaction_state" => row["transaction_state"],
          "workflow_state" => row["workflow_state"],
          "invoice" => rail == "swap" ? nil : row["invoice"],
          "payment_hash" => row["payment_hash"],
          "amount_msats" => integer(row["amount_msats"]),
          "order_id" => stored_order_id(row),
          "created_at" => integer(row["created_at"]),
          "expires_at" => integer(row["expires_at"])
        }
        invoice["settled_at"] = integer(row["settled_at"]) if present?(row["settled_at"])
        if present?(row["settlement_action_completed_at"])
          invoice["settlement_action_completed_at"] = integer(row["settlement_action_completed_at"])
        end
        if non_empty_string?(row["refreshed_from_invoice_id"])
          invoice["refreshed_from_invoice_id"] = row["refreshed_from_invoice_id"]
        end
        invoice["fiat_quote"] = row["fiat_quote"] || nil
        invoice["settlement_action_state"] = row["settlement_action_state"]
        invoice
      end

      def group_checkouts(rows, now)
        groups = {}
        rows.each do |row|
          checkout_id = stored_checkout_id(row)
          (groups[checkout_id] ||= []) << row
        end

        groups
          .map { |checkout_id, group| build_checkout(checkout_id, group, now) }
          .sort do |left, right|
            if left["created_at"] == right["created_at"]
              right["checkout_id"] <=> left["checkout_id"]
            else
              right["created_at"] <=> left["created_at"]
            end
          end
      end

      def build_checkout(checkout_id, rows, now)
        sorted = rows.sort do |left, right|
          if integer(left["created_at"]) == integer(right["created_at"])
            right["invoice_id"] <=> left["invoice_id"]
          else
            integer(right["created_at"]) <=> integer(left["created_at"])
          end
        end

        invoices = sorted.map { |row| serialize_invoice(row, now) }
        paid_invoice = invoices.find { |invoice| invoice["status"] == "settled" }
        superseded = sorted.any? { |row| dig_metadata(row, "superseded") == true }
        status =
          if paid_invoice
            "paid"
          elsif superseded
            "superseded"
          elsif invoices.all? { |invoice| %w[expired failed].include?(invoice["status"]) }
            "expired"
          else
            "open"
          end
        active =
          if status == "open"
            invoices.find do |invoice|
              invoice["rail"] != "swap" && invoice["status"] == "pending" && invoice["expires_at"] > now
            end
          end
        amount_spec = dig_metadata(sorted.first, "amount_spec")
        base = active || paid_invoice || invoices.first

        checkout = {
          "checkout_id" => checkout_id,
          "order_id" => stored_order_id(sorted.first),
          "status" => status,
          "amount_msats" => base["amount_msats"]
        }
        if amount_spec.is_a?(Hash) && amount_spec["fiat"].is_a?(Hash)
          checkout["fiat"] = {
            "currency" => amount_spec["fiat"]["currency"],
            "value" => amount_spec["fiat"]["value"]
          }
        end
        checkout["active"] = active if active
        checkout["invoices"] = invoices
        checkout["paid_at"] = paid_invoice["settled_at"] if paid_invoice && paid_invoice["settled_at"]
        checkout["created_at"] = sorted.map { |row| integer(row["created_at"]) }.min
        checkout
      end

      def build_order(rows, scan_meta, now)
        raise "Order has no invoices." if rows.empty?

        checkouts = group_checkouts(rows, now)
        paid_checkout = checkouts.find { |checkout| checkout["status"] == "paid" }
        active_checkout = checkouts.find { |checkout| checkout["status"] == "open" }
        paid = !paid_checkout.nil?
        status = paid ? "paid" : (active_checkout ? "pending" : "expired")
        display_checkout = paid_checkout || active_checkout || checkouts.first

        order = {
          "order_id" => stored_order_id(rows.first),
          "status" => status,
          "paid" => paid
        }
        order["paid_at"] = paid_checkout["paid_at"] if paid_checkout && paid_checkout["paid_at"]
        order["display_checkout"] = display_checkout if display_checkout
        order["paid_checkout"] = paid_checkout if paid_checkout
        order["active_checkout"] = active_checkout if active_checkout
        order["checkouts"] = checkouts
        order["wallet_scan_performed"] = scan_meta[:wallet_scan_performed] ? true : false
        order["transactions_checked"] = integer(scan_meta[:transactions_checked] || 0)
        order
      end

      def dig_metadata(row, key)
        metadata = row["metadata"]
        metadata.is_a?(Hash) ? metadata[key] : nil
      end

      def non_empty_string?(value)
        value.is_a?(String) && !value.empty?
      end

      def present?(value)
        !value.nil? && value != ""
      end

      def integer(value)
        Integer(value)
      rescue ArgumentError, TypeError
        raise ArgumentError, "expected integer"
      end
    end
  end
end
