# frozen_string_literal: true

module OpenReceive
  module Server
    # Terminal-transition decisions for one non-settled reconciliation result.
    # Mirrors spec/test-vectors/attempt-reconciliation.json exactly: closure of
    # an unpaid attempt requires a successful wallet scan observed at or after
    # expiry plus the grace window — a local clock alone never closes a row.
    module Reconciliation
      # Seconds past an attempt's expiry during which reconciliation still scans
      # for a settlement before closing the attempt. Covers clock skew and
      # wallets that accept a payment moments after nominal invoice expiry.
      # The value comes from spec/data/kernel-tables.json (generated into
      # OpenReceive::Generated), is pinned by spec/test-vectors/attempt-
      # reconciliation.json, and is the JS OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS.
      EXPIRY_GRACE_SECONDS = OpenReceive::Generated::ATTEMPT_EXPIRY_GRACE_SECONDS

      module_function

      # Returns { "status" =>, "reason" => } to persist, or nil to keep the
      # attempt pending. Settled results never reach this decision; they deliver
      # settlement instead. transaction_state is the explicit state field on the
      # wallet's transaction record, when the scan found one; it decides whether
      # a pending result past expiry plus grace is an operator-attention case or
      # just an abandoned invoice.
      def transition(expires_at:, status:, observed_at:, transaction_state: nil)
        case status.to_s
        when "failed"
          { "status" => "failed", "reason" => "wallet_reported_failed" }
        when "expired"
          { "status" => "expired", "reason" => "wallet_reported_expired" }
        when "not_found", "pending"
          # The invoice may outlive the requested expiry, so closure waits for a
          # scan past expiry plus grace instead of trusting the local clock alone.
          return nil if Integer(observed_at) < Integer(expires_at) + EXPIRY_GRACE_SECONDS

          if status.to_s == "not_found"
            { "status" => "expired", "reason" => "not_found_after_expiry" }
          elsif %w[pending accepted].include?(transaction_state.to_s)
            # `attention` requires the wallet's EXPLICIT claim that the
            # transaction is still in flight long after expiry.
            { "status" => "attention", "reason" => "unsettled_after_expiry" }
          else
            # NIP-47 state fields are optional and the unpaid scan lists unpaid
            # invoices, so a state-less record is indistinguishable from an
            # ordinary abandoned invoice — close it as expired.
            { "status" => "expired", "reason" => "no_finality_after_expiry" }
          end
        else
          raise ArgumentError, "unexpected reconciliation status: #{status}"
        end
      end
    end
  end
end
