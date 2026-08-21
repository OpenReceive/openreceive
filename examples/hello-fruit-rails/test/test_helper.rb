# frozen_string_literal: true

ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

module ActiveSupport
  class TestCase
    # No fixtures: the demo creates its rows ad hoc, exactly like the app does.
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

module OpenReceiveTestStubs
  # Point the initializer-built configuration at hermetic test doubles: the
  # fake NWC wallet, the static $50,000/BTC price table (no live feed), and no
  # swap providers. reset_runtime! rebuilds the memoized service/handler.
  def stub_openreceive!(wallet)
    OpenReceive.config.nwc_client = wallet
    OpenReceive.config.price_provider = OpenReceive::Rates::StaticPriceProvider.new
    OpenReceive.config.swap_providers = []
    OpenReceive.config.reset_runtime!
  end
end
