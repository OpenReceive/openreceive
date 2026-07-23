# frozen_string_literal: true

require "openreceive/server"

module OpenReceive
  class ConfigurationError < StandardError; end

  class Configuration
    attr_accessor :parent_controller, :nwc, :nwc_client, :authorize, :resolve_checkout,
                  :on_checkout_created, :rate_limit, :prefix, :price_provider,
                  :swap_providers, :price_currencies

    def initialize
      @parent_controller = "ActionController::Base"
      @nwc = nil
      @nwc_client = nil
      @authorize = nil
      @resolve_checkout = nil
      @on_checkout_created = nil
      @rate_limit = nil
      @prefix = "/openreceive"
      @price_provider = nil
      @swap_providers = []
      @price_currencies = ["USD"]
    end

    def service
      validate!
      @service ||= OpenReceive::Server::Service.new(
        nwc_client: resolved_nwc_client,
        price_provider: @price_provider,
        swap_providers: @swap_providers,
        price_currencies: @price_currencies
      )
    end

    def request_handler
      validate!
      @request_handler ||= OpenReceive::Server::RequestHandler.new(
        service: service,
        authorize: @authorize,
        resolve_checkout: @resolve_checkout,
        on_checkout_created: @on_checkout_created,
        rate_limit: @rate_limit,
        prefix: @prefix
      )
    end

    def reset_runtime!
      %i[@service @request_handler @resolved_nwc_client].each do |name|
        remove_instance_variable(name) if instance_variable_defined?(name)
      end
      self
    end

    def validate!
      raise ConfigurationError, "OpenReceive.config.authorize is required." if @authorize.nil?
      if @resolve_checkout.nil?
        raise ConfigurationError, "OpenReceive.config.resolve_checkout is required; payer input is not a price authority."
      end
      if @on_checkout_created.nil?
        raise ConfigurationError, "OpenReceive.config.on_checkout_created is required to persist payment_hash before responding."
      end
      resolved_nwc_client
      true
    end

    private

    def resolved_nwc_client
      @resolved_nwc_client ||= begin
        return @nwc_client unless @nwc_client.nil?
        connection = @nwc || OpenReceive::Server::Config.load.nwc
        if connection.nil?
          raise ConfigurationError, "Set nwc in openreceive.yml, or configure OpenReceive.config.nwc/nwc_client explicitly."
        end
        return connection if connection.respond_to?(:make_invoice) || connection.respond_to?(:makeInvoice)
        require "nwc"
        ::Nwc::Client.new(connection_uri: connection)
      rescue LoadError
        raise ConfigurationError, "Install nwc-ruby or configure nwc_client."
      end
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
