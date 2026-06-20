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
  config.merchant_scope = "hello-fruit-rails-hotwire"
  config.production = ENV.fetch("RAILS_ENV", "development") == "production"
  config.authenticate = ->(_controller) { true }
  config.authorize_invoice = ->(_controller, _invoice) { true }
  config.metadata = lambda do |_controller, params|
    {
      "fruit" => params["fruit"] || "banana",
      "demo" => "rails-hotwire"
    }
  end
  config.fulfill = lambda do |invoice|
    FruitUnlock.find_or_create_by!(invoice_id: invoice.fetch("invoice_id")) do |unlock|
      unlock.fruit = invoice.fetch("metadata").fetch("fruit")
      unlock.payment_hash = invoice.fetch("payment_hash")
    end
  end
end
