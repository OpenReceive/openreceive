# frozen_string_literal: true

# Engine-owned key/value/rev rows in the host database (the install generator
# emits the openreceive_meta table next to openreceive_payments). Today it
# holds one row: the durable reconcile gate every Puma worker and process on
# this database shares, so rapid OpenReceive calls collapse to one real
# wallet scan per interval. Mirrors the JS SQL repository's claimReconcileGate.
class OpenReceiveMeta < ActiveRecord::Base
  self.table_name = "openreceive_meta"
  self.primary_key = "key"

  RECONCILE_GATE_KEY = "transaction_scan_gate"
  CAS_RETRIES = 6

  # Optimistic compare-and-set: INSERT-if-absent at rev 0, or
  # UPDATE ... WHERE rev = expected. Returns true when this caller's write won.
  def self.cas(key, value, expected_rev)
    if expected_rev.nil?
      begin
        create!(key: key, value: value, rev: 0)
        true
      rescue ActiveRecord::RecordNotUnique
        false
      end
    else
      where(key: key, rev: expected_rev).update_all(value: value, rev: expected_rev + 1) == 1
    end
  end

  # Claim the durable global reconcile gate. Returns true when this caller may
  # run a wallet scan now; false (gate_busy) when another worker scanned within
  # interval_seconds. A failed scan leaves claimed_at in place on purpose — the
  # next interval retries without a stampede.
  def self.claim_reconcile_gate(now:, interval_seconds:)
    CAS_RETRIES.times do
      row = find_by(key: RECONCILE_GATE_KEY)
      claim = JSON.generate("claimed_at" => Integer(now))
      if row.nil?
        return true if cas(RECONCILE_GATE_KEY, claim, nil)
      else
        claimed_at = parse_claimed_at(row.value)
        return false if claimed_at && Integer(now) - claimed_at < Integer(interval_seconds)
        return true if cas(RECONCILE_GATE_KEY, claim, row.rev)
      end
    end
    false
  end

  def self.parse_claimed_at(value)
    parsed = JSON.parse(value.to_s)
    claimed_at = parsed["claimed_at"]
    claimed_at.is_a?(Numeric) ? Integer(claimed_at) : nil
  rescue JSON::ParserError
    nil
  end

  private_class_method :parse_claimed_at
end
