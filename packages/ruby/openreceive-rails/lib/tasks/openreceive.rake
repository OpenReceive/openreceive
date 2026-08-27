# frozen_string_literal: true

namespace :openreceive do
  # Step 0 of the agent directions, as one command.
  #
  # "Look for NWC_URI in this app's server environment" is a SEARCH, and it has
  # a different answer on every host shape: a .env file, Rails credentials, a
  # deploy config, or — in a containerised app — a value that exists only in the
  # running process, fetched by a launcher script, where grepping the repo finds
  # the NAME in a compose file and proves nothing about the value. This asks the
  # process, which is the only place that always knows.
  #
  # PRESENCE ONLY. No secret is ever printed, echoed, or partially shown; every
  # line is "set" or "unset". That rule is what makes this safe to run in a
  # shared terminal, paste into an issue, or hand to a coding agent.
  desc "Report OpenReceive's install state: credentials (set/unset only), engine mount, hooks"
  task doctor: :environment do
    set = ->(name) { ENV[name].to_s.strip.empty? ? "unset" : "set" }
    lines = [
      "openreceive:doctor",
      "  NWC_URI:          #{set.call('NWC_URI')}",
      "  LSC_URI_PRIMARY:  #{set.call('LSC_URI_PRIMARY')}",
      "  LSC_URI_BACKUP:   #{set.call('LSC_URI_BACKUP')}"
    ]

    if OpenReceive.configured?
      config = OpenReceive.config
      hook = lambda do |value, placeholder, name|
        return "MISSING — the engine refuses to serve checkouts without it" if value.nil?
        return "the generated placeholder (#{name}) — replace it" if value.equal?(placeholder)

        "set"
      end
      lines << "  configure:        run"
      lines << "  authorize:        #{hook.call(config.authorize, OpenReceive::ALLOW_ALL_AUTHORIZE,
                                                'allow-all')}"
      lines << "  amount_for:       #{config.amount_for.nil? ? 'MISSING — the engine refuses to serve checkouts without it' : 'set'}"
      lines << "  on_paid:          #{hook.call(config.on_paid, OpenReceive::LOGGING_ON_PAID,
                                                'logging-only')}"
    else
      lines << "  configure:        NOT RUN — run `bin/rails generate openreceive:install`"
    end

    mount = Rails.application.routes.routes.find do |route|
      route.app.respond_to?(:app) && route.app.app == OpenReceive::Engine
    end
    lines << "  engine mounted:   #{mount.nil? ? 'no — add `mount OpenReceive::Engine` to config/routes.rb' : "at #{mount.path.spec}"}"

    # The wallet check, last and best-effort: it is the only line that talks to
    # a relay, and a doctor that raises tells an operator less than one that
    # reports. The receive-only verdict is the whole point — a spend-capable
    # connection is refused, not warned about.
    lines << "  wallet preflight: #{OpenReceive.doctor_wallet_report}"

    puts lines.join("\n")
  end

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
          # Redacted: a connect failure can quote the NWC URI, secret and all.
          warn "openreceive:notifications periodic reconcile failed (will retry): " \
               "#{OpenReceive.sanitize_failure_message(error)}"
        end
        sleep interval
      end
    end
    reconciler.abort_on_exception = false

    backoff = nil
    loop do
      subscribed_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      failure = nil
      begin
        OpenReceive.listen_for_notifications!
      rescue OpenReceive::ConfigurationError
        # The configured NWC client cannot notify; surface the limitation
        # clearly. The periodic pass alone would be a silent downgrade the
        # operator asked this worker to exceed.
        reconciler.kill
        raise
      rescue StandardError => error
        failure = error
      end
      backoff = OpenReceive.notifications_retry_delay(
        backoff, Process.clock_gettime(Process::CLOCK_MONOTONIC) - subscribed_at
      )
      if failure.nil?
        warn "openreceive:notifications subscription ended; retrying in #{backoff}s"
      else
        warn "openreceive:notifications error: " \
             "#{OpenReceive.sanitize_failure_message(failure)}; retrying in #{backoff}s " \
             "(the periodic reconcile pass still covers settlements)"
      end
      sleep backoff
    end
  end
end
