# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"
require "fileutils"

module ActiveSupport
  class TestCase
    # No fixtures. Products come from the shared catalog seeds; visitors,
    # orders and items are created through the demo's own endpoints, which is
    # the only way they are ever created in production either.
  end
end

# Test wallet stub, modeled on packages/ruby/openreceive-rails/test/rails_test.rb:
# mints deterministic invoices and lets tests flip transaction states so
# payments/check and reconciliation observe them. No relay, no network.
class FakeWallet
  attr_reader :transactions

  def initialize
    @counter = 0
    @transactions = []
  end

  def make_invoice(request)
    @counter += 1
    hash = @counter.to_s(16).rjust(64, "0")
    now = Time.now.to_i
    @transactions << {
      "type" => "incoming", "payment_hash" => hash, "invoice" => "lnbc-test-#{@counter}",
      "amount_msats" => request.fetch("amount_msats"), "transaction_state" => "pending",
      "created_at" => now
    }
    { "invoice" => "lnbc-test-#{@counter}", "payment_hash" => hash,
      "amount_msats" => request.fetch("amount_msats"),
      "created_at" => now, "expires_at" => now + request.fetch("expiry", 600) }
  end

  def list_transactions(request)
    rows = @transactions.slice(request.fetch("offset", 0), request.fetch("limit", 20)) || []
    { "transactions" => rows }
  end

  def settle!(hash, at:)
    row = @transactions.find { |transaction| transaction["payment_hash"] == hash }
    raise "no such invoice: #{hash}" if row.nil?

    row["transaction_state"] = "settled"
    row["settled_at"] = at
  end
end

module ButtonShopTestSetup
  # Point the initializer-built configuration at hermetic test doubles: the fake
  # NWC wallet, the static $50,000/BTC price table (no live feed), and no swap
  # providers. reset_runtime! rebuilds the memoized service/handler. Rate
  # limiting stays exactly as the initializer configured it (on).
  def stub_openreceive!(wallet)
    OpenReceive.config.nwc_client = wallet
    OpenReceive.config.price_provider = OpenReceive::Rates::StaticPriceProvider.new
    OpenReceive.config.swap_providers = []
    OpenReceive.config.reset_runtime!
  end

  # The six product rows, from the same shared catalog file the data migration
  # and `bin/rails db:seed` read. Inside the test transaction, so each test
  # starts clean.
  def seed_catalog!
    Rails.application.load_seed
  end

  # Stub Shakapacker output so pack tags render without shelling out to webpack
  # (config/shakapacker.yml sets test compile: false). Digest-shaped names keep
  # any immutable-caching assertion honest.
  STUB_JS = "/packs-test/js/buttons-0123456789abcdef0123.js"
  STUB_CSS = "/packs-test/css/buttons-0123456789abcdef0123.css"

  def ensure_pack_assets!
    dir = Rails.public_path.join("packs-test")
    FileUtils.mkdir_p(dir.join("js"))
    FileUtils.mkdir_p(dir.join("css"))
    dir.join("js/#{File.basename(STUB_JS)}").write("console.log('buttons-stub')")
    dir.join("css/#{File.basename(STUB_CSS)}").write("/* buttons-stub */")
    dir.join("manifest.json").write(JSON.generate(
                                      "buttons.js" => STUB_JS,
                                      "buttons.css" => STUB_CSS,
                                      "entrypoints" => {
                                        "buttons" => {
                                          "assets" => { "js" => [STUB_JS], "css" => [STUB_CSS] }
                                        }
                                      }
                                    ))
    Shakapacker.manifest.refresh
  end

  # A visitor, as the browser holds one: a SIGNED cookie carrying a ShopUser id.
  #
  # Integration tests share one cookie jar across requests, so the usual way to
  # be "a different browser" is a second test; this is the escape hatch for
  # asserting on somebody else's order inside one test.
  def sign_shop_cookie(user_id)
    jar = ActionDispatch::Cookies::CookieJar.build(ActionDispatch::TestRequest.create, {})
    jar.signed[ShopIdentity::COOKIE] = user_id
    jar[ShopIdentity::COOKIE.to_s]
  end

  def json_body
    JSON.parse(response.body)
  end

  # A cable connection's whole identity is the signed cookie, so a stubbed
  # connection is a stubbed cookie read. `nil` is a visitor with no cookie:
  # allowed on the public feed, rejected from anybody's order.
  def stub_shop_connection(shop_user_id)
    stub = ActionCable::Channel::ConnectionStub.new
    stub.define_singleton_method(:shop_user_id) { shop_user_id }
    @connection = stub
  end
end
