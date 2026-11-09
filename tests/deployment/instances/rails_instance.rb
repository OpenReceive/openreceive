# frozen_string_literal: true

# One Rails process of a two-instance shop on real Postgres or MySQL, driven by
# tests/deployment/two-instances.test.mjs (the contract is at the top of that
# file): the real engine, routes and generated migration, in a minimal app.

require "json"
require "net/http"
require "uri"
require "tmpdir"

ENV["RAILS_ENV"] ||= "production"
ENV["SECRET_KEY_BASE"] ||= "edge-test-only-#{'x' * 80}"

REPO = File.expand_path("../../..", __dir__)
%w[packages/ruby/openreceive/lib packages/ruby/openreceive-server/lib packages/ruby/openreceive-rails/lib].each do |path|
  $LOAD_PATH.unshift(File.join(REPO, path))
end

require "rails"
require "active_record/railtie"
require "action_controller/railtie"
require "rack"
require "puma"
require "puma/configuration"
require "openreceive/rails"

INSTANCE = ENV.fetch("EDGE_INSTANCE", "a")
KIND = ENV.fetch("EDGE_DB_KIND")
WALLET_URL = ENV.fetch("EDGE_WALLET_URL")
ACTIVE_RECORD_URL = ENV.fetch("EDGE_DB_URL").sub(%r{\Amysql://}, "mysql2://")
ENV["DATABASE_URL"] = "#{ACTIVE_RECORD_URL}?pool=24"

def post_wallet(path, body)
  uri = URI("#{WALLET_URL}#{path}")
  request = Net::HTTP::Post.new(uri, "content-type" => "application/json", "x-edge-instance" => INSTANCE)
  request.body = JSON.generate(body)
  response = Net::HTTP.start(uri.host, uri.port, read_timeout: 10) { |http| http.request(request) }
  JSON.parse(response.body.to_s.empty? ? "{}" : response.body)
end

# The Ruby engine's wallet client contract: string-keyed hashes in and out.
class SharedWalletClient
  def preflight
    {
      "wallet_pubkey" => "f" * 64,
      "relays" => ["wss://relay.test.openreceive.local"],
      "methods" => %w[make_invoice list_transactions],
      "encryption" => ["nip04"],
    }
  end

  def make_invoice(request)
    post_wallet("/make_invoice", request)
  end

  def list_transactions(request)
    post_wallet("/list_transactions", request)
  end

  def subscribe_notifications(&handler)
    @handler = handler
    :subscribed
  end

  def notify(notification)
    @handler.call(notification)
  end
end

CLIENT = SharedWalletClient.new

OpenReceive.configure do |config|
  config.parent_controller = "ActionController::API"
  config.nwc_client = CLIENT
  config.price_provider = false
  config.swap_providers = []
  config.authorize = ->(_context) { true }
  config.amount_for = ->(_reference) { { "sats" => 1234 } }
  config.rate_limiting = { limit_per_hour: Integer(ENV.fetch("EDGE_RATE_LIMIT_PER_HOUR", "60")) }
  config.client_ip = ->(request) { request.get_header("HTTP_X_EDGE_CLIENT_IP") }
  config.on_paid = lambda do |settlement|
    ActiveRecord::Base.connection.exec_insert(
      "INSERT INTO edge_fulfillments (reference, payment_hash, instance) VALUES (#{ActiveRecord::Base.connection.quote(settlement.reference)}, " \
      "#{ActiveRecord::Base.connection.quote(settlement.payment_hash)}, #{ActiveRecord::Base.connection.quote(INSTANCE)})"
    )
    post_wallet("/fulfilled", { reference: settlement.reference, payment_hash: settlement.payment_hash, instance: INSTANCE })
  end
end

def respond(status, body)
  [status, { "content-type" => "application/json" }, [JSON.generate(body)]]
end

def wait_until(at_ms)
  return if at_ms.nil?

  delay = at_ms.to_f / 1000 - Time.now.to_f
  sleep(delay) if delay.positive?
end

BodyReader = lambda do |env|
  text = env["rack.input"].read
  text.to_s.empty? ? {} : JSON.parse(text)
end

Control = lambda do |env|
  body = BodyReader.call(env)
  wait_until(body["at_ms"])
  case env["PATH_INFO"]
  when "/__settle"
    OpenReceive.config.settlement_hook.call(
      "payment_hash" => body.fetch("payment_hash"),
      "paid_at" => body.fetch("paid_at"),
      "details" => nil
    )
    respond(200, { ok: true })
  when "/__reconcile"
    result = OpenReceive.maybe_reconcile!
    respond(200, { reason: result["reason"] })
  when "/__notify"
    CLIENT.notify("notification_type" => "payment_received", "notification" => body.fetch("transaction"))
    respond(200, { ok: true })
  else
    respond(404, {})
  end
rescue StandardError => e
  respond(500, { error: "#{e.class}: #{e.message}" })
end

class EdgeApp < Rails::Application
  config.root = Dir.mktmpdir("edge-rails-app")
  config.eager_load = true
  config.api_only = true
  config.secret_key_base = ENV.fetch("SECRET_KEY_BASE")
  config.logger = ActiveSupport::Logger.new($stdout)
  config.log_level = :warn
  config.hosts.clear
  routes.append do
    mount OpenReceive::Engine => "/openreceive"
    get "/__health", to: ->(_env) { respond(200, { instance: INSTANCE }) }
    post "/__settle", to: Control
    post "/__reconcile", to: Control
    post "/__notify", to: Control
  end
end

Rails.application.initialize!

if ARGV.include?("migrate")
  require "rails/generators"
  require "openreceive/fulfillment_note"
  require_relative "../../../packages/ruby/openreceive-rails/lib/generators/openreceive/install/install_generator"
  Dir.mktmpdir("edge-rails-migration") do |directory|
    OpenReceive::Generators::InstallGenerator.start(
      ["--skip-initializer", "--skip-route"],
      destination_root: directory,
      behavior: :invoke,
      quiet: true
    )
    ActiveRecord::Migration.verbose = false
    ActiveRecord::MigrationContext.new(File.join(directory, "db/migrate")).migrate
  end
  ActiveRecord::Base.connection.execute(
    "CREATE TABLE edge_fulfillments (reference VARCHAR(255) NOT NULL, payment_hash VARCHAR(64) NOT NULL, instance VARCHAR(16) NOT NULL)"
  )
  exit 0
end

OpenReceive.listen_for_notifications!

server = Puma::Server.new(Rails.application, nil, min_threads: 8, max_threads: 16, log_writer: Puma::LogWriter.null)
server.add_tcp_listener("127.0.0.1", Integer(ENV.fetch("EDGE_PORT")))
thread = server.run
trap("TERM") { exit(0) }
thread.join
