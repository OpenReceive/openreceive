# frozen_string_literal: true

namespace :openreceive do
  desc "Run one OpenReceive reconciliation pass over pending payment attempts"
  task reconcile: :environment do
    checks = OpenReceive.reconcile!
    puts "openreceive:reconcile checked #{checks.length} pending attempt(s)"
  end

  # The one optional worker (case 2). By default no worker is needed at all:
  # every engine request runs the durably gated opportunistic reconcile, so
  # settlement of abandoned checkouts piggybacks on ordinary traffic. Run this
  # long-lived process only when you want settlements pushed the moment the
  # wallet reports payment_received — it both listens for NWC-02 notifications
  # AND runs a periodic reconcile pass in the same process, the safety net for
  # notifications missed while this worker was down. Hosts do not additionally
  # schedule OpenReceive::ReconcileJob; it remains available as a one-shot
  # primitive.
  desc "Optional worker: listen for NWC-02 notifications and reconcile periodically (long-running)"
  task notifications: :environment do
    interval = Integer(ENV.fetch("OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS", "15"))
    puts "openreceive:notifications listening for NWC-02 payment_received and " \
         "reconciling every #{interval}s. Notifications are authenticated wallet data; " \
         "the periodic pass covers notifications missed while this worker was down."

    reconciler = Thread.new do
      loop do
        begin
          OpenReceive.reconcile!
        rescue StandardError => error
          warn "openreceive:notifications periodic reconcile failed (will retry): #{error.message}"
        end
        sleep interval
      end
    end
    reconciler.abort_on_exception = false

    backoff = 1
    loop do
      begin
        OpenReceive.listen_for_notifications!
        warn "openreceive:notifications subscription ended; retrying in #{backoff}s"
      rescue OpenReceive::ConfigurationError
        # The configured NWC client cannot notify; surface the limitation
        # clearly. The periodic pass alone would be a silent downgrade the
        # operator asked this worker to exceed.
        reconciler.kill
        raise
      rescue StandardError => error
        warn "openreceive:notifications error: #{error.message}; retrying in #{backoff}s " \
             "(the periodic reconcile pass still covers settlements)"
      end
      sleep backoff
      backoff = [backoff * 2, 60].min
    end
  end
end
