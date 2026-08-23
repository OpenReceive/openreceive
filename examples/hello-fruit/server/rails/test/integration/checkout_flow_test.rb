# frozen_string_literal: true

require "test_helper"

# The demo's own glue over real HTTP routes, mirroring the Node demo coverage
# (tests/hello-fruit-sqlite-store.test.mjs): catalog-priced order
# creation, checkout mint through the mounted engine with a stubbed NWC
# wallet, settlement via payments/check, and delivery gated on settlement.
class CheckoutFlowTest < ActionDispatch::IntegrationTest
  include HelloFruitTestSetup
  include ActionCable::TestHelper

  JSON_HEADERS = { "CONTENT_TYPE" => "application/json" }.freeze

  setup do
    @wallet = FakeWallet.new
    stub_openreceive!(@wallet)
    seed_catalog!
    link_shared_stickers!
  end

  def create_order!(cart:, currency: "USD")
    post orders_url, params: { cart: cart, currency: currency }, as: :json
    assert_response :created
    response.parsed_body
  end

  def create_checkout!(order_id)
    post "/openreceive/checkouts",
         params: JSON.generate(reference: order_id), headers: JSON_HEADERS
    assert_response :created
    response.parsed_body.fetch("checkout")
  end

  def check_payment!(order_id, payment_hash)
    post "/openreceive/payments/check",
         params: JSON.generate(reference: order_id, payment_hash: payment_hash),
         headers: JSON_HEADERS
    assert_response :success
    response.parsed_body
  end

  test "orders are priced from the catalog, never from payer input" do
    body = create_order!(cart: [{ id: "apple", quantity: 2 }, { id: "banana", quantity: 1 }])
    summary = body.fetch("summary")
    # 2 x $2.00 apples + 1 x $4.00 banana from shared/fruits.json.
    assert_equal({ "currency" => "USD", "value" => "8.00" }, summary.fetch("total_amount"))
    assert_equal %w[apple banana], summary.fetch("items").map { |item| item.fetch("product_id") }.sort
  end

  test "a SATS order converts the USD catalog price through the rate feed" do
    body = create_order!(cart: [{ id: "apple", quantity: 1 }], currency: "SATS")
    # $2.00 at the static $50,000/BTC test price is exactly 4000 sats.
    assert_equal({ "currency" => "SATS", "value" => "4000" },
                 body.dig("summary", "total_amount"))
  end

  test "checkout mints an invoice, settles via payments/check, and gates delivery" do
    order_id = create_order!(cart: [{ id: "apple", quantity: 2 }]).fetch("order_id")

    checkout = create_checkout!(order_id)
    payment_hash = checkout.fetch("payment_hash")
    assert_match(/\A[0-9a-f]{64}\z/, payment_hash)
    assert checkout.fetch("bolt11")
    # $4.00 at the static $50,000/BTC test price is exactly 8000 sats.
    assert_equal 8_000_000, checkout.fetch("amount_msats")

    assert_equal "pending", check_payment!(order_id, payment_hash).fetch("status")

    # Delivery is forbidden until the order settles.
    # Literal path: after a request to the mounted engine the integration
    # session would prefix named routes with the engine's /openreceive mount.
    get "/delivery/#{order_id}/apple"
    assert_response :forbidden

    @wallet.settle!(payment_hash, at: Time.now.to_i)
    # The durable openreceive_meta gate collapses rapid polls to one wallet
    # scan per 2s interval; the payer's next poll after the interval (browsers
    # poll every ~3s) wins the gate and observes the settlement.
    travel 3.seconds
    assert_equal "settled", check_payment!(order_id, payment_hash).fetch("status")
    assert_equal "paid", Order.find(order_id).status
    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: payment_hash).status

    get "/delivery/#{order_id}/apple"
    assert_response :success
    assert_equal "image/svg+xml", response.media_type

    # A product that is not on the order stays undeliverable.
    get "/delivery/#{order_id}/banana"
    assert_response :not_found
  end

  test "reconciliation settles a pending attempt without browser polling" do
    order_id = create_order!(cart: [{ id: "pear", quantity: 1 }]).fetch("order_id")
    payment_hash = create_checkout!(order_id).fetch("payment_hash")
    @wallet.settle!(payment_hash, at: Time.now.to_i)

    assert_equal 1, OpenReceive.reconcile!.length

    assert_equal "paid", Order.find(order_id).status
    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: payment_hash).status
  end

  test "settlement broadcasts an order-update envelope on OrderChannel" do
    order_id = create_order!(cart: [{ id: "apple", quantity: 1 }]).fetch("order_id")
    order = Order.find(order_id)
    order.mark_paid!
    assert_broadcast_on(
      OrderChannel.broadcasting_for(order.id),
      "message" => "order-update", "data" => order.summary
    ) do
      order.broadcast_order_update
    end
  end

  test "/rates serves the service's BTC fiat rates for the currency picker" do
    get "/rates"
    assert_response :success
    assert_equal({ "rates" => { "bitcoin" => { "usd" => "50000.00" } } }, response.parsed_body)
  end

  test "rate limiting stamps the client IP on committed attempts" do
    order_id = create_order!(cart: [{ id: "orange", quantity: 1 }]).fetch("order_id")
    create_checkout!(order_id)
    assert_equal ["127.0.0.1"], OpenReceivePayment.pluck(:client_ip).uniq
  end

  test "the SPA shell is not cached so webpack rebuilds reach the browser" do
    ensure_hello_fruit_assets!
    get "/"
    assert_response :success
    assert_includes response.headers["Cache-Control"], "no-store"
    assert_match %r{/packs-test/js/hello_fruit-[0-9a-f]+\.js}, response.body
  end
end
