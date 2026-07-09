# frozen_string_literal: true

require "openreceive/server"

module OpenReceive
  # Raised for host-configuration problems (missing NWC connection, unbuildable store, etc.).
  class ConfigurationError < StandardError; end

  # Host-facing configuration for the Rails engine. Set via `OpenReceive.configure`:
  #
  #   OpenReceive.configure do |config|
  #     config.parent_controller = "ApplicationController"
  #     config.nwc               = ENV.fetch("OPENRECEIVE_NWC")
  #     config.namespace         = "default"
  #     config.authorize         = ->(ctx) { ... }
  #     config.get_checkout_amount       = ->(ctx) {
  #       { amount: { currency: "USD", value: Order.find(ctx[:order_id]).total_usd.to_s } }
  #     }
  #   end
  #
  # The Configuration lazily builds — and memoizes — a single `OpenReceive::Server::Service`, a
  # `Tokens::Manager`, and the shared `OpenReceive::Server::RequestHandler` the controllers delegate
  # to. Rebuild them after mutation with `#reset_runtime!` (a fresh `OpenReceive.configure` block
  # does this for you).
  class Configuration
    # Engine controllers inherit from this class. Default is a bare ActionController::Base; a host
    # sets "ApplicationController" so the engine inherits its CSRF, authentication, and current_user.
    attr_accessor :parent_controller

    # NWC connection. Either a receive-only connection string (built into an `nwc-ruby` client at
    # first use) or an already-constructed duck-typed client (responds to make_invoice /
    # list_transactions). The secret is never logged and never sent to the browser.
    attr_accessor :nwc

    # An explicit, pre-built NWC client. Takes precedence over `nwc`. Use this to inject a client
    # constructed however you like (or a test double).
    attr_accessor :nwc_client

    # Store namespace (multi-tenant isolation). Defaults to "default".
    attr_accessor :namespace

    # Invoice store. Defaults to a normalized ActiveRecordInvoiceStore (the Rails schema). Provide
    # your own store object to override.
    attr_accessor :store

    # authorize: ->(context) { boolean }. Context = { action:, request:, resource:, token:,
    # token_valid:, order_id: } — `token_valid` is the handler-precomputed per-order token validity,
    # so a policy never needs the token manager. When nil, the built-in default policy applies: Tier 1
    # allow, Tier 2 iff token_valid, Tier 3 (invoice.sweep) DENY (fail closed). The ready-made
    # OpenReceive::Server::Presets.guest_checkout / .with_user policies can be assigned here directly.
    attr_accessor :authorize

    # get_checkout_amount: REQUIRED. Called on create-checkout only to return payment terms (never
    # trust a client price). Accepts either the single-context form `->(ctx) { ... }` (ctx has
    # :order_id, :client_amount, :metadata, :request, :action) or the keyword form
    # `->(order_id:, client_amount:, metadata:, request:) { ... }` (matching RackApp). Must return
    # { amount: { currency:, value: } } or { amount: { sats: } }, or nil for 404 (order not found).
    attr_accessor :get_checkout_amount

    # rate_limit: ->(context) { allowed_boolean }. Returning false yields a 429. Optional.
    attr_accessor :rate_limit

    # Mount prefix. Informational for the engine (Rails owns routing via `mount`); kept so the
    # Service/RackApp semantics line up. Defaults to "/openreceive".
    attr_accessor :prefix

    # Optional injected price provider (responds to btc_fiat_price(currency)). Without one, fiat
    # checkouts and the rates route raise NOT_IMPLEMENTED — matching openreceive-server.
    attr_accessor :price_provider

    # Optional swap providers (scaffolded in openreceive-server; swaps advertise as disabled).
    attr_accessor :swap_providers

    # Optional list of price currencies for the rates route.
    attr_accessor :price_currencies

    # Optional logger (responds to :info/:warn or :call). Never receives the NWC secret.
    attr_accessor :logger

    def initialize
      @parent_controller = "ActionController::Base"
      @nwc = nil
      @nwc_client = nil
      @namespace = "default"
      @store = nil
      @authorize = nil
      @get_checkout_amount = nil
      @rate_limit = nil
      @prefix = "/openreceive"
      @price_provider = nil
      @swap_providers = []
      @price_currencies = nil
      @logger = nil
    end

    # True when the host supplied an authorize hook. When false the default policy applies and
    # Tier 3 (invoice.sweep) fails closed; the engine logs a loud warning at boot.
    def authorize_configured?
      !@authorize.nil?
    end

    # Memoized invoice store (host-provided or the default ActiveRecord store).
    def store_instance
      @store_instance ||= (@store || default_store)
    end

    # Memoized checkout/order Service, wired to the resolved NWC client and store.
    def service
      @service ||= OpenReceive::Server::Service.new(
        nwc_client: nwc_client_instance,
        store: store_instance,
        namespace: @namespace,
        price_provider: @price_provider,
        swap_providers: @swap_providers || [],
        logger: @logger,
        price_currencies: @price_currencies
      )
    end

    # Memoized per-order capability-token manager (backed by the same store's meta KV).
    def tokens
      @tokens ||= OpenReceive::Server::Tokens::Manager.new(store: store_instance, namespace: @namespace)
    end

    # Memoized request handler — the shared framework-neutral handler the controllers (and the Rack
    # app) delegate to. Passing `authorize: @authorize` (which may be nil) means the default
    # fail-closed policy is used when the host did not supply one.
    def request_handler
      if @get_checkout_amount.nil?
        raise ConfigurationError,
              "OpenReceive.config.get_checkout_amount is required — the create-checkout route " \
              "never trusts a client-supplied price."
      end
      @request_handler ||= OpenReceive::Server::RequestHandler.new(
        service: service,
        tokens: tokens,
        authorize: @authorize,
        get_checkout_amount: @get_checkout_amount,
        rate_limit: @rate_limit,
        prefix: @prefix
      )
    end

    # The built-in fail-closed tier policy (Tier 1 allow, Tier 2 iff a valid token, Tier 3 deny).
    # The Authorization concern's default hook defers here when no authorize proc is configured.
    def default_authorize_decision(context)
      request_handler.default_authorize_decision(context)
    end

    # Drop memoized runtime objects so the next access rebuilds them from the current settings.
    def reset_runtime!
      remove_instance_variable(:@store_instance) if defined?(@store_instance)
      remove_instance_variable(:@nwc_client_instance) if defined?(@nwc_client_instance)
      remove_instance_variable(:@service) if defined?(@service)
      remove_instance_variable(:@tokens) if defined?(@tokens)
      remove_instance_variable(:@request_handler) if defined?(@request_handler)
      self
    end

    private

    # Resolve (and memoize) the raw NWC client the Service will wrap. Precedence:
    #   1. an explicit pre-built client (`config.nwc_client`)
    #   2. `config.nwc` when it is already a duck-typed client (responds to make_invoice)
    #   3. `config.nwc` treated as a connection string → built via the `nwc-ruby` gem
    def nwc_client_instance
      @nwc_client_instance ||= resolve_nwc_client
    end

    def resolve_nwc_client
      return @nwc_client unless @nwc_client.nil?
      raise ConfigurationError, "OpenReceive.config.nwc (or .nwc_client) is not set." if @nwc.nil?
      return @nwc if @nwc.respond_to?(:make_invoice) || @nwc.respond_to?(:makeInvoice)

      build_nwc_ruby_client(@nwc)
    end

    def build_nwc_ruby_client(connection_uri)
      unless defined?(::Nwc) && ::Nwc.const_defined?(:Client)
        begin
          require "nwc"
        rescue LoadError
          raise ConfigurationError,
                "config.nwc is a connection string but the `nwc-ruby` gem is not available. " \
                "Add `gem \"nwc-ruby\"` to your Gemfile, or set config.nwc_client to a pre-built " \
                "client (any object responding to make_invoice / list_transactions)."
        end
      end
      ::Nwc::Client.new(connection_uri: connection_uri)
    end

    def default_store
      OpenReceive::Server::ActiveRecordInvoiceStore.new
    end
  end

  class << self
    # Yields the singleton Configuration for mutation and rebuilds memoized runtime objects so the
    # next request uses the new settings.
    #
    #   OpenReceive.configure { |config| config.nwc = ENV["OPENRECEIVE_NWC"] }
    def configure
      cfg = config
      yield(cfg) if block_given?
      cfg.reset_runtime!
      cfg
    end

    # The singleton Configuration (created with defaults on first access).
    def config
      @config ||= Configuration.new
    end

    # Replace the singleton with a fresh default Configuration (primarily for tests).
    def reset_config!
      @config = nil
    end
  end
end
