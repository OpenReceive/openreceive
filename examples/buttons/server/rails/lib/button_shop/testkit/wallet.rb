# frozen_string_literal: true

module ButtonShop
  module Testkit
    # An in-memory NWC wallet, and a PORT of packages/js/testkit's
    # TestkitReceiveClient rather than a second invention.
    #
    # The fixtures are identical on purpose — payment hashes are the mint
    # counter in 64 hex characters, invoices are `lnbcopenreceive000001` — so
    # one Playwright suite can drive the Rails stack and the three Node stacks
    # and assert the same strings. A fake that agreed with the contract but not
    # with its JS twin would need a second harness, and the second harness is
    # where stacks drift.
    #
    # The client contract is duck-typed by OpenReceive::Server::Service:
    # `make_invoice`, `list_transactions`, and one of the info methods. Hashes
    # in, hashes out, string keys — this is the wire, not a Ruby API.
    class Wallet
      # Matches the JS testkit. Never a real preimage; nothing verifies it.
      PREIMAGE = "1" * 64

      def initialize(clock: -> { Time.now.to_i }, default_expiry_seconds: 600)
        @clock = clock
        @default_expiry_seconds = default_expiry_seconds
        @counter = 0
        @by_payment_hash = {}
        # Every mutation crosses a Puma thread boundary: the control route
        # settles an invoice while a payments/check poll is reading the same
        # store on another thread.
        @lock = Mutex.new
      end

      # NIP-47 kind 13194 info, as WalletInfo.summarize reads it. Receive-only:
      # advertising a spend method here would trip the service's own refusal,
      # which is the behaviour under test in other suites.
      def get_info
        {
          "methods" => %w[make_invoice list_transactions],
          "encryption" => ["nip04"]
        }
      end

      def make_invoice(request)
        input = stringify(request)
        amount_msats = Integer(input.fetch("amount_msats"))
        raise ArgumentError, "amount_msats must be at least 1000" if amount_msats < 1_000

        @lock.synchronize do
          @counter += 1
          created_at = @clock.call
          # The requested expiry is HONOURED exactly. The service compares the
          # invoice's real payable window against the request and rejects a
          # deviation over 60s on the swap path, where the shadow invoice must
          # outlive the provider order — a fake that clamped would fail every
          # swap for reasons that look nothing like the cause.
          expires_at = created_at + Integer(input["expiry"] || @default_expiry_seconds)
          record = {
            "type" => "incoming",
            "invoice" => format("lnbcopenreceive%06d", @counter),
            "payment_hash" => @counter.to_s(16).rjust(64, "0"),
            "amount_msats" => amount_msats,
            "created_at" => created_at,
            "expires_at" => expires_at,
            "transaction_state" => "pending"
          }
          @by_payment_hash[record.fetch("payment_hash")] = record
          invoice_fields(record)
        end
      end

      # Settlement is read from HISTORY, exactly as the real reconcile pass
      # reads it: unpaid rows are excluded unless the caller asks for them, so
      # a pending invoice is simply absent rather than present-and-unsettled.
      def list_transactions(request = {})
        input = stringify(request)
        return { "transactions" => [] } if input["type"] == "outgoing"

        from = input["from"]
        until_ = input["until"]
        include_unpaid = input["unpaid"] == true
        rows = @lock.synchronize { @by_payment_hash.values.map(&:dup) }
        rows = rows.reject { |row| !from.nil? && row.fetch("created_at") < Integer(from) }
        rows = rows.reject { |row| !until_.nil? && row.fetch("created_at") > Integer(until_) }
        rows = rows.select { |row| include_unpaid || row["transaction_state"] == "settled" }
        rows = rows.sort_by { |row| [-row.fetch("created_at"), row.fetch("payment_hash")] }
        offset = Integer(input["offset"] || 0)
        limit = input["limit"].nil? ? rows.length : Integer(input["limit"])
        { "transactions" => rows.slice(offset, limit) || [] }
      end

      # ------------------------------------------------------------- controls

      def settle_invoice(payment_hash, settled_at: nil)
        mutate(payment_hash) do |record|
          record["transaction_state"] = "settled"
          record["state"] = "settled"
          record["settled_at"] = settled_at || @clock.call
          record["preimage"] = PREIMAGE
        end
      end

      def expire_invoice(payment_hash)
        mutate(payment_hash) do |record|
          record["transaction_state"] = "expired"
          record["state"] = "expired"
        end
      end

      def invoices
        @lock.synchronize { @by_payment_hash.values.map(&:dup) }
      end

      private

      def mutate(payment_hash)
        @lock.synchronize do
          record = @by_payment_hash[payment_hash]
          raise KeyError, "testkit invoice not found" if record.nil?

          yield record
          record.dup
        end
      end

      def invoice_fields(record)
        record.slice("invoice", "payment_hash", "amount_msats", "created_at", "expires_at")
      end

      def stringify(value)
        return {} if value.nil?

        value.each_with_object({}) { |(key, entry), out| out[key.to_s] = entry }
      end
    end
  end
end
