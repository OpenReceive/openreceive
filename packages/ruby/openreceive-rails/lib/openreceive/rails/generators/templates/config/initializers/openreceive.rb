# frozen_string_literal: true

OpenReceive::Rails.configure do |config|
  connection_uri = ENV.fetch("OPENRECEIVE_NWC", "").to_s.strip
  if connection_uri.empty?
    message = OpenReceive.missing_nwc_message
    warn message
    raise message
  end
  begin
    OpenReceive.parse_nwc_uri(connection_uri)
  rescue OpenReceive::NwcUriParseError => error
    message = OpenReceive.invalid_nwc_message(reason: error.message)
    warn message
    raise message
  end
  require "nwc_ruby"
  config.client = OpenReceive::NwcRubyReceiveClient.new(
    client: NwcRuby::Client.from_uri(connection_uri),
    connection_uri: connection_uri
  )

  config.store = OpenReceive::Rails.resolve_invoice_store
  config.namespace = Rails.application.class.module_parent_name.underscore
  config.production = Rails.env.production?
  config.metadata = ->(_controller, _params) { {} }
  config.settlement_action = lambda do |_invoice|
    # Unlock the app-owned order, account, or entitlement here.
  end
end
