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

  # The durable global scan gate returns a token/scheduler claim or nil.
  # Checkpoints require that token and an unexpired lease; failed scans retain
  # the interval and pre-scan queue so another worker can retry fairly.
  def self.claim_reconcile_gate(now:, interval_seconds:, lease_seconds: 10)
    assert_supported_schema!
    now = Integer(now)
    CAS_RETRIES.times do
      row = find_by(key: RECONCILE_GATE_KEY)
      current = parse_gate(row&.value)
      claimed = current["claimed_at"]
      return nil if claimed && fresh_timestamp?(now, claimed, interval_seconds)
      return nil if current.fetch("lease_until", 0) > now && current.fetch("claimed_at", 0) <= now + 60

      gate = {
        "version" => 1, "claimed_at" => now, "token" => SecureRandom.uuid,
        "lease_until" => now + lease_seconds, "interval_seconds" => interval_seconds,
        "scheduler" => current.fetch("scheduler", { "cursor" => nil, "windows" => [] })
      }
      next unless cas(RECONCILE_GATE_KEY, JSON.generate(gate), row&.rev)

      return { "token" => gate.fetch("token"), "scheduler" => gate.fetch("scheduler") }
    end
    nil
  end

  def self.checkpoint_reconcile_gate(claim, scheduler, now:, release: false)
    assert_supported_schema!
    row = find_by(key: RECONCILE_GATE_KEY)
    return false if row.nil?

    gate = parse_gate(row.value)
    return false unless gate["token"] == claim.fetch("token") && gate.fetch("lease_until", 0) > now

    windows = scheduler.fetch("windows")
    raise ArgumentError, "Reconciliation checkpoint exceeded bounded cohorts" if windows.length > 2 || windows.any? { |w| w.fetch("attempts").length > 200 }

    gate["scheduler"] = scheduler
    gate["lease_until"] = 0 if release
    encoded = JSON.generate(gate)
    raise ArgumentError, "Reconciliation checkpoint exceeded 128 KiB" if encoded.bytesize > 128 * 1024

    cas(RECONCILE_GATE_KEY, encoded, row.rev)
  end

  def self.parse_gate(value)
    gate = value.nil? ? {} : JSON.parse(value.to_s)
    gate = {} unless gate.is_a?(Hash)
    raise OpenReceive::ConfigurationError, "Unsupported reconciliation checkpoint version; upgrade OpenReceive." if gate.fetch("version", 0) > 1

    gate["version"] == 1 ? gate : { "scheduler" => { "cursor" => nil, "windows" => [] } }
  rescue JSON::ParserError
    { "scheduler" => { "cursor" => nil, "windows" => [] } }
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

  private_class_method :stored_schema_version, :fresh_timestamp?
end
