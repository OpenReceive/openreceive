# frozen_string_literal: true

OpenReceive::Rails.configure do |config|
  connection_uri = ENV["OPENRECEIVE_NWC"].to_s
  config.client = if connection_uri.empty?
    OpenReceive::UnavailableReceiveClient.new(
      message: "Set OPENRECEIVE_NWC before creating live invoices."
    )
  else
    require "nwc_ruby"
    OpenReceive::NwcRubyReceiveClient.new(
      client: NwcRuby::Client.from_uri(connection_uri),
      connection_uri: connection_uri
    )
  end

  config.store = OpenReceive::Rails.create_active_record_invoice_store
  config.merchant_scope = Rails.application.class.module_parent_name.underscore
  config.production = Rails.env.production?
  config.authenticate = lambda do |controller|
    if controller.respond_to?(:authenticate_user!)
      controller.authenticate_user!
    elsif Rails.env.production?
      raise SecurityError, "Configure OpenReceive authentication before production."
    else
      true
    end
  end
  config.authorize_invoice = ->(_controller, _invoice) { true }
  config.metadata = ->(_controller, _params) { {} }
  config.settlement_action = lambda do |_invoice|
    # Unlock the app-owned order, account, or entitlement here.
  end
end
