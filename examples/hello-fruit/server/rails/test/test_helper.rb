# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"
require "fileutils"

module ActiveSupport
  class TestCase
    # No fixtures: products come from the shared catalog seeds, orders are
    # created through the demo's own endpoints.
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

module HelloFruitTestSetup
  # Point the initializer-built configuration at hermetic test doubles: the
  # fake NWC wallet, the static $50,000/BTC price table (no live feed), and no
  # swap providers. reset_runtime! rebuilds the memoized service/handler.
  # Rate limiting stays exactly as the initializer configured it (on).
  def stub_openreceive!(wallet)
    OpenReceive.config.nwc_client = wallet
    OpenReceive.config.price_provider = OpenReceive::Rates::StaticPriceProvider.new
    OpenReceive.config.swap_providers = []
    OpenReceive.config.reset_runtime!
  end

  # Product rows from the shared catalog, the same seeds `bin/rails db:seed`
  # runs (inside the test transaction, so each test starts clean).
  def seed_catalog!
    Rails.application.load_seed
  end

  # Mirror the Dockerfile's `ln -sfn ../../../shared/stickers public/stickers`
  # so delivery can serve a real sticker file. Idempotent; the symlink is
  # git-ignored like the rest of the built public/ artifacts.
  def link_shared_stickers!
    link = Rails.public_path.join("stickers")
    return if File.exist?(link) || File.symlink?(link)

    FileUtils.ln_s("../../../shared/stickers", link)
  end

  # Stub Shakapacker output so pack tags render without shelling out to
  # webpack (config/shakapacker.yml sets test compile: false). Digest-shaped
  # names keep the immutable-caching assertions honest.
  STUB_JS = "/packs-test/js/hello_fruit-0123456789abcdef0123.js"
  STUB_CSS = "/packs-test/css/hello_fruit-0123456789abcdef0123.css"

  def ensure_hello_fruit_assets!
    dir = Rails.public_path.join("packs-test")
    FileUtils.mkdir_p(dir.join("js"))
    FileUtils.mkdir_p(dir.join("css"))
    dir.join("js/#{File.basename(STUB_JS)}").write("console.log('hello-fruit-stub')")
    dir.join("css/#{File.basename(STUB_CSS)}").write("/* hello-fruit-stub */")
    dir.join("manifest.json").write(JSON.generate(
                                      "hello_fruit.js" => STUB_JS,
                                      "hello_fruit.css" => STUB_CSS,
                                      "entrypoints" => {
                                        "hello_fruit" => {
                                          "assets" => { "js" => [STUB_JS], "css" => [STUB_CSS] }
                                        }
                                      }
                                    ))
    Shakapacker.manifest.refresh
  end
end
