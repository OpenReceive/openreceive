# frozen_string_literal: true

require "test_helper"

# The core quickstart loop over real HTTP routes: create the $2.00 order,
# mint a checkout through the mounted engine, poll payments/check, and settle
# once the (stubbed) wallet reports the invoice paid.
class CheckoutFlowTest < ActionDispatch::IntegrationTest
  include OpenReceiveTestStubs

  JSON_HEADERS = { "CONTENT_TYPE" => "application/json" }.freeze

  setup do
    @wallet = FakeWallet.new
    stub_openreceive!(@wallet)
  end

  def create_order!
    post orders_url, as: :json
    assert_response :created
    response.parsed_body.fetch("order_id")
  end

  def create_checkout!(order_id)
    post "/openreceive/checkouts",
         params: JSON.generate(order_id: order_id), headers: JSON_HEADERS
    assert_response :created
    response.parsed_body.fetch("checkout")
  end

  def check_payment!(order_id, payment_hash)
    post "/openreceive/payments/check",
         params: JSON.generate(order_id: order_id, payment_hash: payment_hash),
         headers: JSON_HEADERS
    assert_response :success
    response.parsed_body
  end

  test "checkout mints an invoice, reports pending, then settles when paid" do
    order_id = create_order!
    summary = Order.find(order_id)
    assert_equal ["USD", "pending_payment"], [summary.currency, summary.status]

    checkout = create_checkout!(order_id)
    payment_hash = checkout.fetch("payment_hash")
    assert_match(/\A[0-9a-f]{64}\z/, payment_hash)
    assert checkout.fetch("bolt11")
    # $2.00 at the static $50,000/BTC test price is exactly 4000 sats.
    assert_equal 4_000_000, checkout.fetch("amount_msats")

    assert_equal "pending", check_payment!(order_id, payment_hash).fetch("status")
    assert_equal "pending_payment", Order.find(order_id).status

    @wallet.settle!(payment_hash, at: Time.now.to_i)
    # The durable openreceive_meta gate collapses rapid polls to one wallet
    # scan per 2s interval; the payer's next poll after the interval (browsers
    # poll every ~3s) wins the gate and observes the settlement.
    travel 3.seconds
    assert_equal "settled", check_payment!(order_id, payment_hash).fetch("status")
    assert_equal "paid", Order.find(order_id).status

    payment = OpenReceivePayment.find_by(payment_hash: payment_hash)
    assert_equal [order_id, "settled"], [payment.order_id, payment.status]
  end

  test "checkout create is idempotent while the attempt is live" do
    order_id = create_order!
    first = create_checkout!(order_id)
    second = create_checkout!(order_id)
    assert_equal first.fetch("payment_hash"), second.fetch("payment_hash")
    assert_equal 1, @wallet.transactions.length
  end

  test "reconciliation settles a pending attempt without browser polling" do
    order_id = create_order!
    payment_hash = create_checkout!(order_id).fetch("payment_hash")
    @wallet.settle!(payment_hash, at: Time.now.to_i)

    assert_equal 1, OpenReceive.reconcile!.length

    assert_equal "paid", Order.find(order_id).status
    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: payment_hash).status
  end

  test "unknown order is refused by the demo authorize policy" do
    # OpenReceiveOrderPolicy authorizes only existing orders, so an unknown id
    # is rejected as UNAUTHORIZED before the engine ever looks the order up.
    post "/openreceive/checkouts",
         params: JSON.generate(order_id: "missing"), headers: JSON_HEADERS
    assert_response :forbidden
    assert_equal "UNAUTHORIZED", response.parsed_body["code"]
  end
end
