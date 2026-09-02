# frozen_string_literal: true

require "securerandom"

# Engine-owned key/value/rev rows in the host database (the install generator
# emits the openreceive_meta table next to openreceive_payments). It holds the
# durable reconcile gate every Puma worker and process on this database shares,
# so rapid OpenReceive calls collapse to one real wallet scan per interval, and
# the installed schema-version marker the engine refuses to run past. Mirrors
# the JS SQL repository's claimReconcileGate and assertSupportedSchema.
class OpenReceiveMeta < ActiveRecord::Base
  self.table_name = "openreceive_meta"
  self.primary_key = "key"

  RECONCILE_GATE_KEY = "transaction_scan_gate"
  SCHEMA_VERSION_KEY = "schema_version"
  CAS_RETRIES = 6
  # Tolerance when reading a timestamp another worker wrote. Beyond it a claim
  # stamped in the future is a backwards clock step, not a fresh claim: without
  # this clamp the gate would read as busy until wall-clock time caught up.
  META_CLOCK_SKEW_SECONDS = 60

  # One probe per process, on the engine's first database touch: a database
  # written by a NEWER library must not be operated by this one (columns or
  # state transitions it does not know about). An unreadable or absent marker
  # means "not versioned" — the pre-versioned migrations could not seed a row —
  # and is not a refusal. A missing TABLE is different: that is diagnosable as
  # "the install migration never ran here", and saying so beats the raw
  # StatementInvalid the first payments query would raise a moment later.
  # Mirrors the JS repository's assertSupportedSchema.
  #
  # Reached only from the request-serving paths (every OpenReceivePayment
  # entry point and the reconcile gate) — never unconditionally at boot — so
  # `db:migrate`, `db:prepare`, the install generator, and asset builds still
  # run against an unmigrated database. A raise is not memoized: once the host
  # runs the migration, the same process starts serving.
  def self.assert_supported_schema!
    @schema_version_checked ||= begin
      unless table_exists?
        raise OpenReceive::ConfigurationError,
              "The openreceive_meta table does not exist — the OpenReceive tables have not been " \
              "migrated in this database. Run `bin/rails generate openreceive:install`, then " \
              "`bin/rails db:migrate`. https://openreceive.org/guides/storage.md"
      end
      stored = stored_schema_version
      if !stored.nil? && stored > OpenReceive::Server::PAYMENTS_SCHEMA_VERSION
        raise OpenReceive::ConfigurationError,
              "openreceive_meta reports openreceive schema version #{stored}, newer than this " \
              "library's #{OpenReceive::Server::PAYMENTS_SCHEMA_VERSION}. Upgrade openreceive-rails " \
              "before serving this database."
      end
      true
    end
  end

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
  # interval_seconds. The winner is identified by reading back its own token —
  # the portable equivalent of an affected-row count, matching the JS
  # claimReconcileGate. A failed scan leaves claimed_at in place on purpose —
  # the next interval retries without a stampede.
  def self.claim_reconcile_gate(now:, interval_seconds:)
    assert_supported_schema!
    claim = JSON.generate("claimed_at" => Integer(now), "token" => SecureRandom.uuid)
    CAS_RETRIES.times do
      row = find_by(key: RECONCILE_GATE_KEY)
      if row.nil?
        cas(RECONCILE_GATE_KEY, claim, nil)
      else
        claimed_at = parse_claimed_at(row.value)
        if claimed_at && fresh_timestamp?(Integer(now), claimed_at, Integer(interval_seconds))
          return false
        end
        cas(RECONCILE_GATE_KEY, claim, row.rev)
      end
      return true if where(key: RECONCILE_GATE_KEY).pick(:value) == claim
    end
    false
  end

  def self.stored_schema_version
    value = where(key: SCHEMA_VERSION_KEY).pick(:value)
    return nil if value.nil?

    Integer(value.to_s, 10, exception: false)
  rescue ActiveRecord::ActiveRecordError
    nil
  end

  # True when `timestamp` is within `window_seconds` of `now`. A stamp far in
  # the future is a clock that stepped backwards, not a fresh claim: clamping
  # it to stale keeps a rewound clock from parking the gate busy until
  # wall-clock time catches up. Mirrors the JS isFreshTimestamp.
  def self.fresh_timestamp?(now, timestamp, window_seconds)
    age = now - timestamp
    return false if age < -META_CLOCK_SKEW_SECONDS

    age < window_seconds
  end

  def self.parse_claimed_at(value)
    parsed = JSON.parse(value.to_s)
    claimed_at = parsed["claimed_at"]
    claimed_at.is_a?(Numeric) ? Integer(claimed_at) : nil
  rescue JSON::ParserError
    nil
  end

  private_class_method :stored_schema_version, :fresh_timestamp?, :parse_claimed_at
end
