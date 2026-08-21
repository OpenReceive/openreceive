# frozen_string_literal: true

require "json"
require "openreceive/server"

module OpenReceive
  # Floor for the durable reconcile-gate interval (seconds); stretched by
  # invoice age (2s while any pending invoice is under 2 minutes old, 6s under
  # 5 minutes, else 12s). Mirrors the JS OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS.
  MIN_RECONCILE_INTERVAL_SECONDS = 2
  # Wall-clock bound on an awaited request-path pass. Enforced as a deadline
  # the wallet scan checks between page fetches rather than a Timeout.timeout:
  # Thread#raise at an arbitrary point could tear down an ActiveRecord
  # connection or kill a host's on_paid fulfillment mid-flight, on every
  # winning request. A pass that runs out of budget simply stops walking.
  RECONCILE_SCAN_TIMEOUT_SECONDS = 9
  # Wallet-history pages a request-path pass may walk, mirroring the JS
  # OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES.
  RECONCILE_SCAN_MAX_PAGES = 50

  class << self
    # One bounded reconciliation pass over the engine-owned payment ledger:
    # scan the wallet for every pending attempt, deliver settlements through the
    # settlement hook (write-once + on_paid), and persist terminal transitions
    # so closed attempts leave the scan set. Attempt closure only ever happens
    # from a successful wallet scan result observed at or after expiry plus
    # OpenReceive::Server::Reconciliation::EXPIRY_GRACE_SECONDS — a local clock
    # alone never closes a row, because a payment could have settled while the
    # application was offline. A wallet failure raises and leaves every row
    # pending for the next pass.
    #
    # Runs on any OpenReceive call via maybe_reconcile! (default), from the
    # optional `bin/rails openreceive:notifications` worker, or one-shot from
    # OpenReceive::ReconcileJob / `bin/rails openreceive:reconcile`.
    # Returns the per-hash check results of the pass (an array of
    # { "payment_hash", "status", "paid_at"?, "details"? } hashes) so callers —
    # notably payments/check — can serve a requested hash straight from the
    # pass instead of adding a second per-invoice wallet walk.
    def reconcile!(overlap_seconds: 60, now: nil, max_pages: nil, deadline: nil)
      attempts = OpenReceivePayment.reconcilable_attempts
      return [] if attempts.empty?

      observed_at = Integer(now || Time.now.to_i)
      results = config.service.reconcile_payments(
        {
          "attempts" => attempts,
          "overlap_seconds" => overlap_seconds,
          "until" => observed_at
        }.merge(
          max_pages.nil? ? {} : { "max_pages" => max_pages }
        ).merge(
          deadline.nil? ? {} : { "deadline" => deadline }
        )
      )
      log_reconcile_pass(attempts, results, overlap_seconds, observed_at)
      by_hash = attempts.to_h { |attempt| [attempt.fetch("payment_hash"), attempt] }
      settle = config.settlement_hook
      results.each do |checked|
        attempt = by_hash[checked.fetch("payment_hash")]
        next if attempt.nil?

        if checked["status"] == "settled" && checked["paid_at"]
          # One failing settlement (a raising on_paid, a host data problem)
          # must not abort the rest of the pass: every later attempt would
          # otherwise never settle and never close, on every pass.
          begin
            settle.call(
              "payment_hash" => checked.fetch("payment_hash"),
              "paid_at" => checked.fetch("paid_at"),
              "details" => checked["details"]
            )
          rescue StandardError => e
            warn "[openreceive] settlement for #{checked.fetch('payment_hash')} failed " \
                 "(will retry next pass): #{e.class}: #{e.message}"
          end
          next
        end

        wallet_transaction = checked.dig("details", "transaction") || {}
        transition = OpenReceive::Server::Reconciliation.transition(
          expires_at: attempt.fetch("expires_at"),
          status: checked.fetch("status"),
          observed_at: observed_at,
          transaction_state: wallet_transaction["state"] || wallet_transaction["transaction_state"]
        )
        next if transition.nil?

        OpenReceivePayment.record_reconciliation!(
          payment_hash: checked.fetch("payment_hash"),
          status: transition.fetch("status"),
          observed_at: observed_at,
          reason: transition.fetch("reason")
        )
      end
      results
    end

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

      attempts = OpenReceivePayment.reconcilable_attempts
      return { "reason" => "no_pending" } if attempts.empty?

      observed_at = Integer(now || Time.now.to_i)
      interval = reconcile_gate_interval_seconds(attempts, observed_at, setting)
      unless OpenReceiveMeta.claim_reconcile_gate(now: observed_at, interval_seconds: interval)
        # Another worker scanned within the interval; this request pays nothing.
        openreceive_logger&.debug(
          "[openreceive] opportunistic reconcile: gate_busy " \
          "(#{attempts.length} pending, interval #{interval}s)"
        )
        return { "reason" => "gate_busy" }
      end

      checks = reconcile!(
        now: observed_at,
        max_pages: RECONCILE_SCAN_MAX_PAGES,
        deadline: Process.clock_gettime(Process::CLOCK_MONOTONIC) + RECONCILE_SCAN_TIMEOUT_SECONDS
      )
      { "reason" => "ran", "checks" => checks }
    rescue StandardError => e
      warn "[openreceive] opportunistic reconcile failed (will retry): #{e.class}: #{e.message}"
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
    # Duck-types the configured NWC client for
    # `subscribe_notifications`/`subscribeNotifications` (called with the
    # requested notification types plus a block, falling back to just the
    # block). Returns whatever the client's subscribe call returns; blocking
    # clients simply do not return until the subscription ends. Raises
    # OpenReceive::ConfigurationError when the client does not support
    # notifications.
    def listen_for_notifications!(overlap_seconds: 60)
      client = config.send(:resolved_nwc_client)
      subscribe = %i[subscribe_notifications subscribeNotifications].find do |name|
        client.respond_to?(name)
      end
      if subscribe.nil?
        raise ConfigurationError,
              "The configured NWC client does not support NWC-02 notifications " \
              "(no subscribe_notifications method). Notifications are optional; " \
              "keep polling with OpenReceive::ReconcileJob or " \
              "`bin/rails openreceive:reconcile`."
      end

      handler = lambda do |notification|
        next unless payment_received_notification?(notification)

        reconcile!(overlap_seconds: overlap_seconds) unless settle_from_notification!(notification)
      end

      begin
        client.public_send(subscribe, ["payment_received"], &handler)
      rescue ArgumentError
        client.public_send(subscribe, &handler)
      end
    end

    private

    # Rails.logger when the engine runs inside Rails; nil in bare-gem tests.
    # Settlement behavior never depends on logging.
    def openreceive_logger
      return nil unless defined?(::Rails) && ::Rails.respond_to?(:logger)

      ::Rails.logger
    end

    # Info, not debug: passes are durably gated (min 2s apart, and only while
    # attempts are pending), so operators can watch settlement discovery and
    # the batched list_transactions window without raising the log level. All
    # pending attempts share one creation-time window walked at most twice —
    # never one wallet call per invoice.
    def log_reconcile_pass(attempts, results, overlap_seconds, observed_at)
      logger = openreceive_logger
      return if logger.nil?

      counts = results.group_by { |checked| checked["status"] }.transform_values(&:length)
      window_from = [attempts.map { |attempt| Integer(attempt.fetch("created_at")) }.min - overlap_seconds, 0].max
      logger.info(
        "[openreceive] reconcile pass: #{attempts.length} pending attempt(s) in one " \
        "batched list_transactions window (from #{window_from} until #{observed_at}, <=2 walks): " \
        "#{counts.map { |status, count| "#{count} #{status}" }.join(', ')}"
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

      pending = OpenReceivePayment.reconcilable_attempts.any? do |attempt|
        attempt.fetch("payment_hash").to_s.downcase == payment_hash
      end
      return false unless pending

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
      true
    rescue StandardError
      # A direct-settlement failure falls back to the scan-based safety net.
      false
    end
  end
end
