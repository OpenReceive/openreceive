# frozen_string_literal: true

require "minitest/autorun"
require "openreceive/server"
require "stringio"

class StorageFreeServerTest < Minitest::Test
  class Wallet
    attr_reader :transactions

    def initialize
      @counter = 0
      @transactions = []
    end

    def make_invoice(request)
      @counter += 1
      hash = @counter.to_s(16).rjust(64, "0")
      @transactions << {
        "type" => "incoming", "payment_hash" => hash, "invoice" => "ln-test-#{@counter}",
        "amount_msats" => request.fetch("amount_msats"), "transaction_state" => "pending",
        "created_at" => 1000
      }
      { "invoice" => "ln-test-#{@counter}", "payment_hash" => hash,
        "amount_msats" => request.fetch("amount_msats"), "created_at" => 1000, "expires_at" => 1600 }
    end

    def list_transactions(request)
      rows = @transactions.slice(request.fetch("offset", 0), request.fetch("limit", 20)) || []
      { "transactions" => rows }
    end
  end

  class SwapProvider
    attr_reader :order

    def name
      "test-swap"
    end

    def supported_pay_in_assets
      ["USDT_TRON"]
    end

    def invoice_expiry_seconds(pay_in_asset:)
      600
    end

    def create_swap(_input)
      @order = {
        "provider" => name,
        "provider_order_id" => "ruby-swap-1",
        "pay_in_asset" => "USDT_TRON",
        "deposit_address" => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
        "deposit_amount" => "1.05",
        "state" => "awaiting_deposit",
        "expires_at" => 1500
      }
    end

    def get_status(_stored_order)
      @order.dup
    end

    def request_refund(_current_order, _address)
      @order["state"] = "refund_pending"
    end

    def force_refund_required
      @order["state"] = "refund_required"
    end
  end

  def setup
    @wallet = Wallet.new
    @service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: Struct.new(:unused) do
        def btc_fiat_price(_currency)
          "50000.00"
        end
      end.new,
      clock: -> { 1000 }
    )
  end

  def test_checkout_and_payment_check_are_storage_free
    checkout = @service.create_checkout("order_id" => "ruby-1", "amount" => { "sats" => 1000 })
    refute_respond_to @service, :store
    assert_equal "pending", @service.check_payment("payment_hash" => checkout["payment_hash"])["status"]
    @wallet.transactions.first["transaction_state"] = "settled"
    @wallet.transactions.first["settled_at"] = 1010
    assert_equal 1010, @service.check_payment("payment_hash" => checkout["payment_hash"])["paid_at"]
  end

  def test_handler_commits_before_returning_invoice
    committed = []
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "sats" => 5 } },
      on_checkout_created: ->(**payment) { committed << payment }
    )
    status, _headers, body = handler.create_checkout(
      raw_body: JSON.generate("order_id" => "ruby-http"),
      request: {}, request_id: "req-1"
    )
    assert_equal 201, status
    assert_equal body.dig("checkout", "payment_hash"), committed.first.fetch(:payment_hash)
    refute body.key?("order_access_token")
  end

  def test_handler_reuses_host_rows_live_payment_hash
    committed = nil
    handler = OpenReceive::Server::RequestHandler.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: lambda do |**_context|
        { "amount" => { "sats" => 5 }, "payment_hash" => committed }.compact
      end,
      on_checkout_created: ->(**payment) { committed = payment.fetch(:payment_hash) }
    )
    request = { raw_body: JSON.generate("order_id" => "ruby-retry"), request: {} }
    first = handler.create_checkout(**request, request_id: "req-a")
    second = handler.create_checkout(**request, request_id: "req-b")
    assert_equal 201, first.first
    assert_equal 201, second.first
    assert_equal first.last.dig("checkout", "payment_hash"), second.last.dig("checkout", "payment_hash")
    assert_equal 1, @wallet.transactions.length
  end

  def test_watch_payments_retries_failed_callback
    checkout = @service.create_checkout("order_id" => "ruby-retry-paid", "amount" => { "sats" => 10 })
    @wallet.transactions.first["transaction_state"] = "settled"
    @wallet.transactions.first["settled_at"] = 1010
    deliveries = 0
    stopped = false
    @service.watch_payments(
      from: 0,
      interval: 0,
      stop: -> { stopped },
      on_paid: lambda do |payment|
        deliveries += 1
        assert_equal checkout["payment_hash"], payment["payment_hash"]
        raise "host transaction rolled back" if deliveries == 1
        stopped = true
      end
    )
    assert_equal 2, deliveries
  end

  def test_host_serialized_swap_data_recovers_state_and_controls_refunds
    provider = SwapProvider.new
    service = OpenReceive::Server::Service.new(
      nwc_client: @wallet,
      price_provider: nil,
      swap_providers: [provider],
      clock: -> { 1000 }
    )
    swap = service.create_swap(
      "order_id" => "ruby-swap",
      "amount" => { "sats" => 20_000 },
      "pay_in_asset" => "USDT_TRON"
    )
    stored = JSON.parse(JSON.generate(swap.fetch("swap_data")))
    refute stored.key?("payment_hash")
    refute stored.key?("order_id")

    provider.force_refund_required
    assert_equal "refund_required", service.get_swap(
      order_id: swap.fetch("order_id"), payment_hash: swap.fetch("payment_hash"), swap_data: stored
    ).fetch("provider_state")
    refunded = service.refund_swap(
      order_id: swap.fetch("order_id"),
      payment_hash: swap.fetch("payment_hash"),
      swap_data: stored,
      refund_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"
    )
    assert_equal "refund_pending", refunded.fetch("provider_state")
    refute refunded.key?("swap_data")
  end

  def test_rack_handler_satisfies_http_golden_vectors
    app = OpenReceive::Server::RackApp.new(
      service: @service,
      authorize: ->(_context) { true },
      resolve_checkout: ->(**_context) { { "sats" => 1 } },
      on_checkout_created: ->(**_payment) {}
    )
    Dir["spec/test-vectors/http-golden/*.json"].sort.each do |path|
      vector = JSON.parse(File.read(path))
      request = vector.fetch("request")
      status, _headers, body = app.call(
        "REQUEST_METHOD" => request.fetch("method"),
        "PATH_INFO" => request.fetch("path"),
        "QUERY_STRING" => "",
        "HTTP_X_REQUEST_ID" => "golden",
        "rack.input" => StringIO.new(request.key?("body") ? JSON.generate(request["body"]) : "")
      )
      parsed = JSON.parse(body.join)
      assert_equal vector.dig("expected", "status"), status, vector.fetch("name")
      assert_equal vector.dig("expected", "code"), parsed["code"], vector.fetch("name")
    end
  end
end
