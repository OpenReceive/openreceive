# frozen_string_literal: true

require "json"
require "openreceive/server"
require "openreceive/reconcile_scan"

module OpenReceive
  # Floor for the durable reconcile-gate interval (seconds); stretched by
  # invoice age (2s while any pending invoice is under 2 minutes old, 6s under
  # 5 minutes, else 12s). Mirrors the JS OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS.
  MIN_RECONCILE_INTERVAL_SECONDS = 2
  # The deadline reaches the wallet adapter, which bounds only network I/O.
  # Never interrupt the whole pass: it also runs host/database transactions.
  RECONCILE_SCAN_TIMEOUT_SECONDS = 9
  # Wallet-history pages a request-path pass may walk, mirroring the JS
  # OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES.
  RECONCILE_SCAN_MAX_PAGES = 50
  # Cap on the `openreceive:notifications` worker's resubscribe backoff, and
  # the subscription lifetime past which the ramp resets to 1s.
  NOTIFICATIONS_MAX_BACKOFF_SECONDS = 60

  class << self
    # One bounded reconciliation pass over the engine-owned payment ledger:
    # scan the wallet for every pending attempt, deliver settlements through the
    # settlement hook (write-once + on_paid), and persist terminal transitions
    # so closed attempts leave the scan set. Attempt closure only ever happens
    # from a successful wallet scan result observed at or after expiry plus
    # OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS — a local clock
    # alone never closes a row, because a payment could have settled while the
    # application was offline. A later wallet failure preserves already committed
    # finality and leaves unresolved rows pending. A hash absent from pass results (a
    # truncated scan never proved it absent) is no information — the attempt
    # stays untouched.
    #
    # Runs on any OpenReceive call via maybe_reconcile! (default), from the
    # optional `bin/rails openreceive:notifications` worker, or one-shot from
    # OpenReceive::ReconcileJob / `bin/rails openreceive:reconcile`.
    # Returns the per-hash check results of the pass (an array of
    # { "payment_hash", "status", "paid_at"?, "details"? } hashes) so callers —
    # notably payments/check — can serve a requested hash straight from the
    # pass instead of adding a second per-invoice wallet walk.
    # Opportunistic settlement discovery, piggybacked on any OpenReceive call
    # (the engine's around_action runs it before every mounted route): skip
    # without a wallet call when nothing is pending, try the durable
    # openreceive_meta gate shared by every Puma worker ("gate_busy" means
    # another worker just scanned — skip the wallet), otherwise AWAIT one
    # bounded reconcile! pass and return its per-hash results. Never raises: a
    # failed or timed-out scan warns and returns "scan_failed" — the caller's
    # own request must not fail because a settlement sweep did, and claimed_at
    # stays in place so a broken wallet cannot stampede.
    #
    # Returns { "reason" => "ran", "checks" => [...] } or
    # { "reason" => "disabled" | "no_pending" | "gate_busy" | "scan_failed" }.
    # Exported for host code too: host-only routes (e.g. an app's own POST
    # /orders) never auto-run it, but may call OpenReceive.maybe_reconcile!.
    def maybe_reconcile!(now: nil)
      setting = config.opportunistic_reconcile
      return { "reason" => "disabled" } if setting == false

      gated_reconcile!(now: now)
    end

    def reconcile!(overlap_seconds: 60, now: nil)
      gated_reconcile!(overlap_seconds: overlap_seconds, now: now).fetch("checks", [])
    end

    def gated_reconcile!(overlap_seconds: 60, now: nil)
      attempts = OpenReceivePayment.reconcilable_attempts
      return { "reason" => "no_pending" } if attempts.empty?

      observed_at = Integer(now || Time.now.to_i)
      interval = reconcile_gate_interval_seconds(attempts, observed_at, config.opportunistic_reconcile)
      claim = OpenReceiveMeta.claim_reconcile_gate(now: observed_at, interval_seconds: interval)
      return { "reason" => "gate_busy" } if claim.nil?

      scheduler = claim.fetch("scheduler")
      windows = scheduler.fetch("windows")
      if windows.length < 2
        candidates = OpenReceivePayment.reconcilable_attempts(after: scheduler["cursor"])
        if candidates.empty?
          scheduler["cursor"] = nil
          candidates = OpenReceivePayment.reconcilable_attempts
        end
        unless candidates.empty?
          last = candidates.last
          scheduler["cursor"] = candidates.length < Server::RECONCILE_BATCH_SIZE ? nil : last.slice("created_at", "payment_hash")
          queued = windows.flat_map { |w| w.fetch("attempts").map { |a| a.fetch("payment_hash") } }
          cohort = candidates.reject { |a| queued.include?(a.fetch("payment_hash")) }
          windows << ReconcileScan.new_window(cohort, observed_at, overlap_seconds) unless cohort.empty?
        end
      end
      window = windows.shift
      # Checkpoint without the active window, so failures and process loss free
      # its slot. Pending rows return on cursor wrap; successful slices resume.
      checkpoint_now = now.nil? ? Time.now.to_i : observed_at
      return { "reason" => "gate_busy" } unless OpenReceiveMeta.checkpoint_reconcile_gate(claim, scheduler, now: checkpoint_now)
      if window.nil?
        OpenReceiveMeta.checkpoint_reconcile_gate(claim, scheduler, now: checkpoint_now, release: true)
        return { "reason" => "no_pending" }
      end

      by_hash = window.fetch("attempts").to_h { |a| [a.fetch("payment_hash"), a] }
      delivered = {}
      before_scan = JSON.parse(JSON.generate(scheduler))
      deliver_finality = lambda do |checked|
        hash = checked.fetch("payment_hash")
        current = now.nil? ? Time.now.to_i : observed_at
        unless OpenReceiveMeta.checkpoint_reconcile_gate(claim, before_scan, now: current)
          delivered[hash] = false
          next
        end
        if checked["status"] == "settled" && checked["paid_at"]
          delivered[hash] = settle_attempt(checked)
        else
          record_attempt_transition(by_hash.fetch(hash), checked, observed_at)
          delivered[hash] = true
        end
      end
      checks, complete, stalled = ReconcileScan.slice(config.service, window,
        max_pages: RECONCILE_SCAN_MAX_PAGES,
        deadline: Process.clock_gettime(Process::CLOCK_MONOTONIC) + RECONCILE_SCAN_TIMEOUT_SECONDS, on_finality: deliver_finality)
      lease_owned = OpenReceiveMeta.checkpoint_reconcile_gate(claim, before_scan, now: now.nil? ? Time.now.to_i : observed_at)
      committed = checks.filter_map do |checked|
        if delivered.key?(checked.fetch("payment_hash"))
          next unless delivered.fetch(checked.fetch("payment_hash"))
        elsif checked["status"] == "settled" && checked["paid_at"]
          next
        else
          next unless lease_owned

          record_attempt_transition(by_hash.fetch(checked.fetch("payment_hash")), checked,
            checked.fetch("_coverage_started_at", observed_at))
        end
        checked.reject { |key, _| key.start_with?("_") }
      end
      unless complete || stalled
        times = window.fetch("attempts").map { |a| a.fetch("created_at") }.uniq.sort
        if windows.empty? && times.length > 1 && window.fetch("attempts").all? { |a| a["created_at_source"] == "wallet" }
          middle = times[times.length / 2]
          window.fetch("attempts").partition { |a| a.fetch("created_at") < middle }.each do |half|
            windows << ReconcileScan.new_window(half, observed_at, overlap_seconds)
          end
        else
          windows << window
        end
      end
      checkpoint_now = now.nil? ? Time.now.to_i : observed_at
      OpenReceiveMeta.checkpoint_reconcile_gate(claim, scheduler, now: checkpoint_now, release: true)
      log_reconcile_pass(window.fetch("attempts"), committed, window)
      { "reason" => "ran", "checks" => committed }
    rescue StandardError => e
      openreceive_logger&.warn("[openreceive] reconciliation failed (will retry): #{sanitize_failure_message(e)}")
      { "reason" => "scan_failed" }
    end

    # Opt-in NWC-02 notifications: subscribe to the configured NWC client's
    # `payment_received` notifications. Notifications are authenticated wallet
    # data — a payload that satisfies the shared settlement rule (`settled_at`
    # or a settled transaction state; never a preimage alone) and matches a
    # pending attempt settles that attempt directly through the engine's
    # write-once settlement path (mark_paid_once! + on_paid), with no redundant
    # wallet scan for that invoice. Anything less — no finality signal, an
    # unknown hash, or a direct-settlement failure — falls back to one bounded
    # OpenReceive.reconcile! pass. Polling (OpenReceive::ReconcileJob /
    # `bin/rails openreceive:reconcile`) remains the safety net for
    # notifications missed while offline. Direct settlement assumes the NWC
    # client binds notification decryption to the connection's wallet pubkey;
    # a client that skips author verification must not be granted it.
    #
    # The client contract is one method, `subscribe_notifications(&handler)`,
    # yielding NWC-02 wire payloads (`notification_type` plus the
    # transaction-shaped `notification`) — the shape NwcRubyReceiveClient
    # adapts nwc-ruby's notification object to. The handler filters
    # `payment_received` itself, like the Node listener: an NWC-02
    # subscription is not type-filtered, the wallet decides what it publishes.
    # Returns whatever the client's subscribe call returns; blocking clients
    # simply do not return until the subscription ends. Raises
    # OpenReceive::ConfigurationError when the client does not support
    # notifications.
    def listen_for_notifications!(overlap_seconds: 60)
      client = config.send(:resolved_nwc_client)
      unless client.respond_to?(:subscribe_notifications)
        raise ConfigurationError,
              "The configured NWC client does not support NWC-02 notifications " \
              "(no subscribe_notifications method). Notifications are optional; " \
              "keep polling with OpenReceive::ReconcileJob or " \
              "`bin/rails openreceive:reconcile`."
      end

      client.subscribe_notifications do |notification|
        next unless payment_received_notification?(notification)

        reconcile!(overlap_seconds: overlap_seconds) unless settle_from_notification!(notification)
      end
    end

    # Retry delay for the `openreceive:notifications` worker's subscribe loop:
    # doubles per consecutive failure up to NOTIFICATIONS_MAX_BACKOFF_SECONDS,
    # and a subscription that stayed up at least that long was healthy, so the
    # next drop starts the ramp from scratch (mirrors the JS notifications
    # worker, which reconnects fresh per subscription).
    def notifications_retry_delay(previous_delay, subscribed_seconds)
      return 1 if previous_delay.nil? || subscribed_seconds >= NOTIFICATIONS_MAX_BACKOFF_SECONDS

      [previous_delay * 2, NOTIFICATIONS_MAX_BACKOFF_SECONDS].min
    end

    # Failure text can embed wallet credentials (an NWC URI inside a connect
    # error); redact them before the message reaches the host log, mirroring
    # the JS redactSecrets URI patterns. Public because the long-lived
    # `openreceive:notifications` worker — the process most likely to see a
    # connect error — logs failures of its own.
    def sanitize_failure_message(error)
      OpenReceive::Nwc.redact_error_text("#{error.class}: #{error.message}")
    end

    private


    # Rails.logger when the engine runs inside Rails; nil in bare-gem tests.
    # Settlement behavior never depends on logging.
    def openreceive_logger
      return nil unless defined?(::Rails) && ::Rails.respond_to?(:logger)

      ::Rails.logger
    end

    # One failing settlement (a raising on_paid, a host data problem)
    # must not abort the rest of the pass: every later attempt would
    # otherwise never settle and never close, on every pass.
    def settle_attempt(checked)
      config.settlement_hook.call(
        "payment_hash" => checked.fetch("payment_hash"),
        "paid_at" => checked.fetch("paid_at"),
        "details" => checked["details"]
      )
      OpenReceivePayment.where(payment_hash: checked.fetch("payment_hash"), status: "settled").exists?
    rescue StandardError => e
      openreceive_logger&.warn(
        "[openreceive] settlement for #{checked.fetch('payment_hash')} failed " \
        "(will retry next pass): #{sanitize_failure_message(e)}"
      )
      false
    end

    # Closure is decided by the shared reconciliation rules from a scan result
    # the wallet actually returned; a nil transition means keep waiting.
    def record_attempt_transition(attempt, checked, observed_at)
      wallet_transaction = checked.dig("details", "transaction") || {}
      transition = OpenReceive::Server::Reconciliation.transition(
        expires_at: attempt.fetch("expires_at"),
        status: checked.fetch("status"),
        observed_at: observed_at,
        # The row here is the service's NORMALIZED output, which carries
        # "transaction_state" only — the raw wallet's "state" spelling was
        # already resolved at the client boundary.
        transaction_state: wallet_transaction["transaction_state"]
      )
      return if transition.nil?

      OpenReceivePayment.record_reconciliation!(
        payment_hash: checked.fetch("payment_hash"),
        status: transition.fetch("status"),
        observed_at: observed_at,
        reason: transition.fetch("reason")
      )
    end

    # Info, not debug: passes are durably gated (min 2s apart, and only while
    # attempts are pending), so operators can watch settlement discovery and
    # the batched list_transactions window without raising the log level. All
    # pending attempts share one creation-time window walked at most twice —
    # never one wallet call per invoice. One short line per poll: this fires
    # on every status poll while a payer waits. Mirrors the JS
    # payment.reconcile.completed line.
    def log_reconcile_pass(attempts, results, window)
      logger = openreceive_logger
      return if logger.nil?

      counts = results.group_by { |checked| checked["status"] }.transform_values(&:length)
      decided = %w[settled pending not_found].filter_map do |status|
        count = counts[status]
        "#{count} #{status.tr('_', ' ')}" unless count.nil? || count.zero?
      end
      decided = ["0 decided"] if decided.empty?
      # Attempts scanned vs hashes decided: a gap is how a truncated scan shows up.
      scanned = results.length == attempts.length ? "" : " of #{attempts.length} attempts"
      logger.info(
        "[openreceive] payment.reconcile.completed: #{decided.join(', ')}#{scanned} " \
        "attempt_count=#{attempts.length} window=#{window.fetch("from")}..#{window["until"] || "unbounded"}"
      )
    rescue StandardError
      # Diagnostics must never affect the pass.
      nil
    end

    # The gate interval for the current pending set: the configured floor
    # (config.opportunistic_reconcile min_interval_seconds), stretched by
    # invoice age — 2s while any pending invoice is under 2 minutes old, 6s
    # under 5 minutes, else 12s. Mirrors the JS reconcile gate.
    def reconcile_gate_interval_seconds(attempts, now, setting)
      floor = MIN_RECONCILE_INTERVAL_SECONDS
      if setting.is_a?(Hash)
        configured = setting[:min_interval_seconds] || setting["min_interval_seconds"]
        floor = [Integer(configured), floor].max unless configured.nil?
      end
      age_stretch = attempts.map do |attempt|
        elapsed = [now - Integer(attempt.fetch("created_at")), 0].max
        if elapsed < 120
          2
        elsif elapsed < 300
          6
        else
          12
        end
      end.min
      [floor, age_stretch].max
    end

    def payment_received_notification?(notification)
      return false unless notification.respond_to?(:[])

      type = notification["notification_type"] || notification[:notification_type] ||
             notification["type"] || notification[:type]
      type.to_s == "payment_received"
    end

    # Direct settlement from one authenticated payment_received payload.
    # Returns true only when the payload, normalized like a list_transactions
    # row, satisfies the shared settlement rule AND matches a pending attempt —
    # in that case it settles through the engine's write-once settlement hook
    # and no wallet scan runs for that invoice. Any other outcome (no payload,
    # no finality signal, unknown/not-pending hash, or a failure) returns
    # false so the caller falls back to a bounded reconciliation scan.
    def settle_from_notification!(notification)
      payload = notification["notification"] || notification[:notification]
      return false unless payload.respond_to?(:each_pair)

      transaction = OpenReceive::Nwc.normalize_transaction(payload)
      return false unless OpenReceive::Settlement.status(transaction) == "settled"

      payment_hash = transaction["payment_hash"].to_s.downcase
      return false if payment_hash.empty?

      return false if OpenReceivePayment.find_pending_attempt(payment_hash).nil?

      observed_at = Time.now.to_i
      config.settlement_hook.call(
        "payment_hash" => payment_hash,
        "paid_at" => transaction["settled_at"] || observed_at,
        "details" => {
          "transaction" => transaction,
          "observed_at" => observed_at,
          "paid_at_source" => transaction["settled_at"] ? "settled_at" : "observed_at"
        }
      )
      OpenReceivePayment.where(payment_hash: payment_hash, status: "settled").exists?
    rescue StandardError
      # A direct-settlement failure falls back to the scan-based safety net.
      false
    end
  end
end
