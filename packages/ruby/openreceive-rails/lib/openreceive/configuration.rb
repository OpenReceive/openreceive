# frozen_string_literal: true

require "openreceive/server"

module OpenReceive
  class ConfigurationError < StandardError; end

  # Passed to the quickstart `config.on_paid` inside the settlement transaction,
  # only for the first settled attempt for a reference. (Named to avoid the core gem's
  # OpenReceive::Settlement rules module; mirrors JS PaymentSettlement.)
  # `details` carries the wallet-observed settlement details JS delivers to
  # onPaid (transaction snapshot, observed_at, paid_at_source); may be nil for
  # settlements recorded without wallet details.
  PaymentSettlement = Struct.new(:reference, :payment_hash, :paid_at, :details, keyword_init: true)

  # The generated initializer's placeholder `config.on_paid`: it logs the
  # settlement and fulfills nothing. Kept as a named constant so the engine can
  # detect it at boot and warn while a host still ships it — orders recorded as
  # settled without ever being fulfilled must not pass silently.
  LOGGING_ON_PAID = lambda do |settlement|
    ::Rails.logger.info(
      "[openreceive] order #{settlement.reference} paid (payment_hash #{settlement.payment_hash})"
    )
  end

  class Configuration
    # Quickstart contract: authorize + amount_for + on_paid. The engine derives
    # checkout resolution, attempt commit, and settlement write-once from the
    # engine-owned OpenReceivePayment model.
    #
    # Advanced escape hatch: hosts with a custom payment repository configure
    # resolve_checkout and on_checkout_created together; on_paid then receives
    # the raw settlement event and owns replay safety itself.
    attr_accessor :parent_controller, :nwc, :nwc_client, :authorize,
                  :amount_for, :on_paid,
                  :resolve_checkout, :on_checkout_created,
                  :rate_limit, :rate_limiting, :client_ip, :price_provider,
                  :swap_providers, :price_currencies, :allow_spend_capable_wallet,
                  :opportunistic_reconcile, :eager_preflight

    def initialize
      @parent_controller = "ActionController::Base"
      @nwc = nil
      @nwc_client = nil
      @authorize = nil
      @amount_for = nil
      @on_paid = nil
      @resolve_checkout = nil
      @on_checkout_created = nil
      @rate_limit = nil
      # Built-in per-IP invoice rate limiting (mirrors the JS `rateLimiting`
      # option): OFF by default — shared-IP deployments (POS terminals,
      # kiosks) must never be throttled by accident. `true` caps invoice
      # creation at 60 per client IP per rolling hour, counted from the
      # engine-owned openreceive_payments rows; or a Hash with
      # limit_per_hour / limit_per_day. Mutually exclusive with rate_limit.
      @rate_limiting = false
      # Client IP attribution: a proc receiving the framework request.
      # Defaults to ActionDispatch::Request#ip (which honors the app's
      # trusted-proxy configuration).
      @client_ip = nil
      # nil (the default) mirrors the JS createOpenReceive defaults: the
      # price provider becomes the built-in cached live price feed (with
      # OPENRECEIVE_PRICE_FEED_*_URL overrides), and swap providers are
      # auto-built from LSC_URI_PRIMARY / LSC_URI_BACKUP. Set an explicit
      # value (e.g. swap_providers = []) to override.
      @price_provider = nil
      @swap_providers = nil
      @price_currencies = ["USD"]
      @allow_spend_capable_wallet = false
      # Opportunistic settlement discovery, ON by default (mirrors the JS
      # handler's opportunisticReconcile): every engine request first runs one
      # durably gated reconcile pass when attempts are pending, so abandoned
      # checkouts settle on any later OpenReceive call with no scheduled job.
      # The openreceive_meta gate row is shared by every Puma worker/process on
      # the host database (min 2s between real wallet scans, stretched by
      # invoice age). Set false to disable (e.g. when the optional
      # `bin/rails openreceive:notifications` worker owns scanning), or a Hash
      # with min_interval_seconds to tune.
      @opportunistic_reconcile = true
      # The production boot preflight (Engine's after_initialize): build the
      # service, and with it the wallet check, so a missing NWC_URI or a
      # spend-capable wallet stops a deploy instead of the first customer. ON by
      # default. Asset builds are detected and skipped automatically (see
      # OpenReceive.eager_preflight?); set false for any other boot that must
      # come up without wallet secrets.
      @eager_preflight = true
    end

    def service
      validate!
      # The Rails logger, so the service's operator diagnostics actually land:
      # the detailed invoice-expiry rejection ("requested Xs, got Ys…") and the
      # spend-capable override warning are logged, never sent, so without this
      # a Rails operator saw only the short 502 wire message.
      @service ||= OpenReceive::Server::Service.new(
        nwc_client: resolved_nwc_client,
        price_provider: @price_provider,
        swap_providers: @swap_providers,
        price_currencies: @price_currencies,
        allow_spend_capable_wallet: @allow_spend_capable_wallet,
        logger: rails_logger
      )
    end

    def request_handler
      validate!
      @request_handler ||= OpenReceive::Server::RequestHandler.new(
        service: service,
        authorize: @authorize,
        resolve_checkout: @resolve_checkout || engine_resolve_checkout,
        on_checkout_created: @on_checkout_created || engine_on_checkout_created,
        on_paid: settlement_hook,
        rate_limit: resolved_rate_limit,
        client_ip: resolved_client_ip
      )
    end

    # The settlement-event hook shared by payments/check and OpenReceive.reconcile!.
    # In quickstart mode it delivers through OpenReceivePayment.mark_paid_once!,
    # so config.on_paid fires only for the order's FIRST settled attempt, inside
    # the settlement transaction; a later duplicate settlement is recorded
    # (status_reason "duplicate_settlement") but never fulfilled again.
    def settlement_hook
      return @on_paid if advanced_hooks?

      @settlement_hook ||= engine_settlement_hook
    end

    def advanced_hooks?
      !@resolve_checkout.nil? && !@on_checkout_created.nil?
    end

    def reset_runtime!
      %i[@service @request_handler @settlement_hook @resolved_nwc_client].each do |name|
        remove_instance_variable(name) if instance_variable_defined?(name)
      end
      self
    end

    def validate!
      raise ConfigurationError, "OpenReceive.config.authorize is required." if @authorize.nil?
      if @rate_limiting && @rate_limit
        raise ConfigurationError,
              "Set either OpenReceive.config.rate_limiting or a custom rate_limit hook, not both."
      end
      if @rate_limiting && advanced_hooks?
        raise ConfigurationError,
              "config.rate_limiting counts engine-owned OpenReceivePayment rows; with a custom " \
              "repository (resolve_checkout/on_checkout_created), pass a custom rate_limit hook " \
              "backed by your own store instead."
      end
      if @opportunistic_reconcile && advanced_hooks?
        # Same fail-at-construction idiom as the JS handler: the default
        # settlement path needs the engine-owned durable gate and payment rows;
        # a custom repository must opt out explicitly, never degrade silently.
        raise ConfigurationError,
              "config.opportunistic_reconcile (on by default) scans engine-owned " \
              "OpenReceivePayment rows through the shared openreceive_meta gate; with a custom " \
              "repository (resolve_checkout/on_checkout_created), set " \
              "config.opportunistic_reconcile = false and run your own settlement worker."
      end
      if @on_paid.nil?
        raise ConfigurationError, "OpenReceive.config.on_paid is required to durably record settlement."
      end
      if @resolve_checkout.nil? != @on_checkout_created.nil?
        raise ConfigurationError,
              "OpenReceive.config.resolve_checkout and on_checkout_created must be configured together (advanced mode)."
      end
      if !advanced_hooks? && @amount_for.nil?
        raise ConfigurationError,
              "Set OpenReceive.config.amount_for (quickstart), " \
              "or resolve_checkout and on_checkout_created (advanced)."
      end
      resolved_nwc_client
      true
    end

    private

    DEFAULT_RATE_LIMIT_PER_HOUR = 60
    HOUR_SECONDS = 3_600
    DAY_SECONDS = 86_400

    def resolved_client_ip
      extractor = @client_ip || lambda do |request|
        if request.respond_to?(:ip)
          request.ip
        elsif request.is_a?(Hash)
          request["REMOTE_ADDR"]
        end
      end
      # Mirrors the JS handler: the extracted IP (custom hook or framework
      # default) is normalized into the bucket the limiter counts with (IPv6
      # /64, v4-mapped collapsed) and that same bucket is what gets stamped on
      # committed attempt rows. No attributable IP stays nil (fail open).
      ->(request) { OpenReceive::Server::ClientIp.attributed(extractor.call(request)) }
    end

    # The built-in limiter (config.rate_limiting): a COUNT over the
    # engine-owned rows' client_ip within the rolling window, throttling only
    # the invoice-minting actions — identical semantics to the JS handler.
    # Mirrors the JS built-in limiter, including its message and its refusal to
    # accept a non-positive limit: `limit_per_hour: 0` would otherwise block
    # every attributable payer while looking like a configured budget.
    BUILT_IN_RATE_LIMIT_MESSAGE = "Too many payment attempts. Please try again later."

    def resolved_rate_limit
      return @rate_limit unless @rate_limiting
      settings = @rate_limiting.is_a?(Hash) ? @rate_limiting : {}
      limit_per_hour = positive_rate_limit(
        settings[:limit_per_hour] || settings["limit_per_hour"] || DEFAULT_RATE_LIMIT_PER_HOUR,
        "limit_per_hour"
      )
      limit_per_day = settings[:limit_per_day] || settings["limit_per_day"]
      limit_per_day = positive_rate_limit(limit_per_day, "limit_per_day") unless limit_per_day.nil?
      extract_ip = resolved_client_ip
      warned_unattributable = false
      lambda do |context|
        next true unless %w[checkout.create swap.create].include?(context[:action].to_s)
        ip = extract_ip.call(context[:request]).to_s
        if ip.empty?
          # Warned once per process: a deployment where no request ever yields
          # an IP has rate limiting silently switched off.
          unless warned_unattributable
            warned_unattributable = true
            rails_logger&.warn(
              "[openreceive] rate limiting is enabled but no client IP could be resolved; " \
              "attempts from this request are not counted. Configure config.client_ip."
            )
          end
          next true
        end
        now = Time.now
        over_hour = OpenReceivePayment.count_attempts_from_ip(ip, now - HOUR_SECONDS) >= limit_per_hour
        raise OpenReceive::Server::RateLimitedError, BUILT_IN_RATE_LIMIT_MESSAGE if over_hour

        if limit_per_day &&
           OpenReceivePayment.count_attempts_from_ip(ip, now - DAY_SECONDS) >= limit_per_day
          raise OpenReceive::Server::RateLimitedError, BUILT_IN_RATE_LIMIT_MESSAGE
        end
        true
      end
    end

    # Rails.logger when the engine runs inside Rails; nil in bare-gem tests.
    def rails_logger
      return nil unless defined?(::Rails) && ::Rails.respond_to?(:logger)

      ::Rails.logger
    end

    def positive_rate_limit(value, name)
      limit = Integer(value)
      return limit if limit.positive?

      raise ConfigurationError,
            "OpenReceive.config.rate_limiting #{name} must be a positive integer (got #{limit})."
    end

    # The host is asked only where a price is minted or quoted. Status polls
    # and refund recovery for committed attempts are answered from the engine's
    # own rows and never wait for the host's price hook.
    def engine_resolve_checkout
      lambda do |action:, request:, reference:, input:, pay_in_asset: nil|
        pricing = %w[checkout.prepare swap.quote checkout.create swap.create].include?(action)
        amount = pricing ? @amount_for.call(reference) : nil
        raise OpenReceive::Server::NotFoundError, "Unknown reference." if pricing && amount.nil?
        next({ amount: amount }) if %w[checkout.prepare swap.quote].include?(action)

        requested_hash = input["payment_hash"] || input[:payment_hash]
        begin
          payment = OpenReceivePayment.selected_for(
            reference: reference,
            action: action,
            payment_hash: requested_hash,
            pay_in_asset: pay_in_asset
          )
        rescue OpenReceivePayment::AttemptConflict => e
          raise OpenReceive::Server::ConflictError, e.message
        end
        if !requested_hash.to_s.strip.empty? && payment.nil?
          raise OpenReceive::Server::NotFoundError, "Payment attempt not found for this reference."
        end

        {
          amount: amount,
          payment_hash: payment&.payment_hash,
          checkout: payment&.checkout_data,
          swap_data: payment&.swap_data
        }.compact
      end
    end

    def engine_on_checkout_created
      lambda do |reference:, payment_hash:, checkout:, swap_data: nil, client_ip: nil, **|
        begin
          OpenReceivePayment.commit_attempt!(
            reference: reference,
            payment_hash: payment_hash,
            checkout: checkout,
            swap_data: swap_data,
            client_ip: client_ip
          )
        rescue OpenReceivePayment::AttemptConflict => e
          # Same wrap as engine_resolve_checkout: a live same-method row is a
          # 409 CONFLICT. Leaving AttemptConflict unwrapped lets request_handler
          # #commit treat it as infrastructure failure (retryable 503 persist).
          raise OpenReceive::Server::ConflictError, e.message
        end
      end
    end

    def engine_settlement_hook
      lambda do |event|
        data = OpenReceive.as_string_keys(event)
        OpenReceivePayment.mark_paid_once!(
          payment_hash: data.fetch("payment_hash"),
          paid_at: data.fetch("paid_at")
        ) do |payment|
          @on_paid.call(
            PaymentSettlement.new(
              reference: payment.reference,
              payment_hash: payment.payment_hash,
              paid_at: payment.paid_at,
              details: data["details"]
            )
          )
        end
      end
    end

    # Memoized for real: `||= begin ... return ... end` returned out of the
    # method BEFORE the assignment, so the injected-client and
    # client-shaped-string paths never cached — and reset_runtime! cleared an
    # ivar they never set.
    def resolved_nwc_client
      @resolved_nwc_client ||= build_resolved_nwc_client
    end

    def build_resolved_nwc_client
      return @nwc_client unless @nwc_client.nil?

      connection = @nwc || ENV["NWC_URI"]&.strip
      if connection.nil? || connection.empty?
        raise ConfigurationError, "Set NWC_URI, or configure OpenReceive.config.nwc/nwc_client explicitly."
      end
      return connection if connection.respond_to?(:make_invoice) || connection.respond_to?(:makeInvoice)

      OpenReceive::NwcRubyReceiveClient.new(
        client: build_nwc_ruby_client(connection), connection_uri: connection
      )
    end

    def build_nwc_ruby_client(connection)
      require "nwc_ruby"
      ::NwcRuby::Client.from_uri(connection)
    rescue LoadError
      raise ConfigurationError, "Install nwc-ruby or configure nwc_client."
    end
  end

  # Rake tasks that are an ASSET BUILD, never a serving boot.
  ASSET_BUILD_TASKS = %w[assets:precompile assets:clean assets:clobber].freeze

  class << self
    def configure
      @configured = true
      yield(config) if block_given?
      config.reset_runtime!
    end

    # True once the host ran OpenReceive.configure — the engine's boot-time
    # preflight only makes sense for a configured install (the gem may sit in a
    # Gemfile before the installer has been run).
    def configured?
      @configured == true
    end

    # Whether the engine's production boot preflight should run (see Engine).
    #
    # It must not run during `rails assets:precompile`. That is a production
    # boot by RAILS_ENV, but it happens inside an image build where no wallet
    # secrets are mounted — they arrive at deploy time — so the preflight would
    # fail the BUILD, long before the deploy it exists to protect. Rails' own
    # generated Dockerfile has exactly this shape.
    def eager_preflight?
      preflight_skip_reason.nil?
    end

    # nil when the boot preflight should run; otherwise the short reason the
    # engine logs, so an operator who expected a fail-closed boot and did not
    # get one can see why in the same log line.
    def preflight_skip_reason
      return "config.eager_preflight = false" unless config.eager_preflight
      return "asset build" if asset_build?

      nil
    end

    # An asset build, by the two signals that are actually reliable.
    # `Rails.const_defined?(:Console)`-style sniffing is not: the console
    # constant exists in a serving boot too.
    def asset_build?
      # Rails' own convention for "a production boot with a throwaway secret",
      # set by its generated Dockerfile alongside `rails assets:precompile`.
      return true unless ENV["SECRET_KEY_BASE_DUMMY"].to_s.empty?

      # The honest test for older/hand-written build shapes: what was actually
      # invoked. `SECRET_KEY_BASE=dummy rails assets:precompile` lands here.
      return false unless defined?(::Rake)

      ::Rake.application.top_level_tasks.any? { |task| ASSET_BUILD_TASKS.include?(task.to_s) }
    rescue StandardError
      # Rake present but without a usable application: not an asset build.
      false
    end

    def config
      @config ||= Configuration.new
    end

    def reset_config!
      @config = nil
      @configured = false
    end
  end
end
