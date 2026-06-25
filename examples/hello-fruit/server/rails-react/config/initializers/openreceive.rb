OpenReceive::Rails.configure do |config|
  connection_uri = ENV.fetch("OPENRECEIVE_NWC", "").to_s.strip
  if connection_uri.empty?
    message = OpenReceive.missing_nwc_message(subject: "The Hello Fruit demo")
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
  config.namespace = "hello-fruit-rails-react"
  config.production = ENV.fetch("RAILS_ENV", "development") == "production"
  config.metadata = lambda do |_controller, params|
    {
      "fruit" => params["fruit"] || "banana",
      "demo" => "rails-react"
    }
  end
  config.settlement_action = lambda do |invoice|
    FruitUnlock.find_or_create_by!(invoice_id: invoice.fetch("invoice_id")) do |unlock|
      unlock.fruit = invoice.fetch("metadata").fetch("fruit")
      unlock.payment_hash = invoice.fetch("payment_hash")
    end
  end
end
