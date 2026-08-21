# frozen_string_literal: true

require "openreceive/server"

module OpenReceive
  class ConfigurationError < StandardError; end

  # Passed to the quickstart `config.on_paid` inside the settlement transaction,
  # only for the order's first settled attempt. (Named to avoid the core gem's
  # OpenReceive::Settlement rules module; mirrors JS OpenReceiveOrderSettlement.)
  # `details` carries the wallet-observed settlement details JS delivers to
  # onPaid (transaction snapshot, observed_at, paid_at_source); may be nil for
  # settlements recorded without wallet details.
  OrderSettlement = Struct.new(:order_id, :payment_hash, :paid_at, :details, keyword_init: true)

  class Configuration
    # Quickstart contract: authorize + load_order + amount_for_order + on_paid.
    # The engine derives checkout resolution, attempt commit, and settlement
    # write-once from the engine-owned OpenReceivePayment model.
    #
    # Advanced escape hatch: hosts with a custom payment repository configure
    # resolve_checkout and on_checkout_created together; on_paid then receives
    # the raw settlement event and owns replay safety itself.
    attr_accessor :parent_controller, :nwc, :nwc_client, :authorize,
                  :load_order, :amount_for_order, :on_paid, :order_model,
                  :resolve_checkout, :on_checkout_created,
                  :rate_limit, :rate_limiting, :client_ip, :price_provider,
                  :swap_providers, :price_currencies, :allow_spend_capable_wallet,
                  :opportunistic_reconcile

    def initialize
      @parent_controller = "ActionController::Base"
      @nwc = nil
      @nwc_client = nil
      @authorize = nil
      @load_order = nil
      @amount_for_order = nil
      @on_paid = nil
      @order_model = "Order"
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
    end

    def service
      validate!
      @service ||= OpenReceive::Server::Service.new(
        nwc_client: resolved_nwc_client,
        price_provider: @price_provider,
        swap_providers: @swap_providers,
        price_currencies: @price_currencies,
        allow_spend_capable_wallet: @allow_spend_capable_wallet
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
      if !advanced_hooks? && (@load_order.nil? || @amount_for_order.nil?)
        raise ConfigurationError,
              "Set OpenReceive.config.load_order and amount_for_order (quickstart), " \
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

    def engine_resolve_checkout
      lambda do |action:, request:, order_id:, input:, pay_in_asset: nil|
        order = @load_order.call(order_id)
        raise OpenReceive::Server::NotFoundError, "Order not found." if order.nil?

        amount = @amount_for_order.call(order)
        next({ amount: amount }) if %w[checkout.prepare swap.quote].include?(action)

        requested_hash = input["payment_hash"] || input[:payment_hash]
        begin
          payment = OpenReceivePayment.selected_for(
            order_id: order.id,
            action: action,
            payment_hash: requested_hash,
            pay_in_asset: pay_in_asset
          )
        rescue OpenReceivePayment::AttemptConflict => e
          raise OpenReceive::Server::ConflictError, e.message
        end
        if !requested_hash.to_s.strip.empty? && payment.nil?
          raise OpenReceive::Server::NotFoundError, "Payment attempt not found for this order."
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
      lambda do |order_id:, payment_hash:, checkout:, swap_data: nil, client_ip: nil, **|
        order = @load_order.call(order_id)
        raise OpenReceive::Server::NotFoundError, "Order not found." if order.nil?

        begin
          OpenReceivePayment.commit_attempt!(
            order: order,
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
        data = event.each_pair.to_h { |key, value| [key.to_s, value] }
        OpenReceivePayment.mark_paid_once!(
          payment_hash: data.fetch("payment_hash"),
          paid_at: data.fetch("paid_at")
        ) do |_order, payment|
          @on_paid.call(
            OrderSettlement.new(
              order_id: payment.order_id,
              payment_hash: payment.payment_hash,
              paid_at: payment.paid_at,
              details: data["details"]
            )
          )
        end
      end
    end

    def resolved_nwc_client
      @resolved_nwc_client ||= begin
        return @nwc_client unless @nwc_client.nil?
        connection = @nwc || ENV["NWC_URI"]&.strip
        if connection.nil? || connection.empty?
          raise ConfigurationError, "Set NWC_URI, or configure OpenReceive.config.nwc/nwc_client explicitly."
        end
        return connection if connection.respond_to?(:make_invoice) || connection.respond_to?(:makeInvoice)

        raw = build_nwc_ruby_client(connection)
        OpenReceive::NwcRubyReceiveClient.new(client: raw, connection_uri: connection)
      end
    end

    def build_nwc_ruby_client(connection)
      require "nwc_ruby"
      if defined?(::NwcRuby::Client) && ::NwcRuby::Client.respond_to?(:from_uri)
        return ::NwcRuby::Client.from_uri(connection)
      end
      if defined?(::Nwc::Client)
        return ::Nwc::Client.new(connection_uri: connection)
      end
      raise ConfigurationError, "Install nwc-ruby or configure nwc_client."
    rescue LoadError
      raise ConfigurationError, "Install nwc-ruby or configure nwc_client."
    end
  end


  class << self
    def configure
      yield(config) if block_given?
      config.reset_runtime!
    end

    def config
      @config ||= Configuration.new
    end

    def reset_config!
      @config = nil
    end
  end
end
