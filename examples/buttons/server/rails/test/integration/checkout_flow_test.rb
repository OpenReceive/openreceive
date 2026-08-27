# frozen_string_literal: true

require "test_helper"

# The whole hop-by-hop path over real HTTP, with a stubbed NWC wallet:
#
#   POST /shop/orders          mint ONE order row, priced from shop_products
#   POST /openreceive/checkouts  -> authorize -> amount_for -> an invoice
#   POST /openreceive/payments/check -> settlement -> on_paid -> claim_paid!
#   GET  /shop/orders/:id      re-read the row; downloads have unlocked
#   GET  .../downloads/:sku    the artwork
#
# The first test in this file is the gate the whole plan rests on: whether
# `config.authorize` can read a SIGNED COOKIE off the bare ActionDispatch::Request
# the hook is handed.
class CheckoutFlowTest < ActionDispatch::IntegrationTest
  include ButtonShopTestSetup

  JSON_HEADERS = { "CONTENT_TYPE" => "application/json" }.freeze

  setup do
    @wallet = FakeWallet.new
    stub_openreceive!(@wallet)
    seed_catalog!
    ensure_pack_assets!
  end

  test "authorize reads the signed cookie off the bare request" do
    order = create_order!(sku: "safety-orange", quantity: 1)

    # The browser that placed the order may check out.
    post "/openreceive/checkouts",
         params: JSON.generate(reference: order.fetch("reference")), headers: JSON_HEADERS
    assert_response :created
  end

  test "another browser cannot check out somebody else's order" do
    order = create_order!(sku: "safety-orange", quantity: 1)
    reference = order.fetch("reference")

    # A different browser: no cookie at all.
    reset!
    post "/openreceive/checkouts",
         params: JSON.generate(reference: reference), headers: JSON_HEADERS
    assert_response :forbidden

    # And an unsigned cookie carrying the real owner's uuid is still nobody.
    owner_id = ShopOrder.find(reference).shop_user_id
    cookies[ShopIdentity::COOKIE] = owner_id
    post "/openreceive/checkouts",
         params: JSON.generate(reference: reference), headers: JSON_HEADERS
    assert_response :forbidden

    assert_equal 0, OpenReceivePayment.count
  end

  test "checkout mints an invoice, settles, and unlocks the download" do
    order = create_order!(sku: "safety-orange", quantity: 2)
    reference = order.fetch("reference")

    checkout = create_checkout!(reference)
    payment_hash = checkout.fetch("payment_hash")
    assert_match(/\A[0-9a-f]{64}\z/, payment_hash)
    assert checkout.fetch("bolt11")
    # 2 × $1.00 at the static $50,000/BTC test price is exactly 4000 sats.
    assert_equal 4_000_000, checkout.fetch("amount_msats")

    assert_equal "pending", check_payment!(reference, payment_hash).fetch("status")

    # Literal paths: after a request to the mounted engine the integration
    # session would prefix named routes with the engine's /openreceive mount.
    get "/shop/orders/#{reference}/downloads/safety-orange"
    assert_response :forbidden

    @wallet.settle!(payment_hash, at: Time.now.to_i)
    # The durable openreceive_meta gate collapses rapid polls to one wallet scan
    # per 2s interval; the payer's next poll after the interval wins it.
    travel 3.seconds
    assert_equal "settled", check_payment!(reference, payment_hash).fetch("status")

    stored = ShopOrder.find(reference)
    assert_equal ShopOrder::PAID, stored.state
    assert_equal payment_hash, stored.payment_hash
    assert stored.paid_at.present?

    get "/shop/orders/#{reference}"
    assert_response :success
    assert_equal "/shop/orders/#{reference}/downloads/safety-orange",
                 JSON.parse(response.body).fetch("items").sole.fetch("download_path")

    get "/shop/orders/#{reference}/downloads/safety-orange"
    assert_response :success
    assert_equal "image/webp", response.media_type
  end

  test "the download survives the browser being closed and reopened" do
    order = create_order!(sku: "signal-red", quantity: 1)
    reference = order.fetch("reference")
    cookie = cookies[ShopIdentity::COOKIE]

    payment_hash = create_checkout!(reference).fetch("payment_hash")
    @wallet.settle!(payment_hash, at: Time.now.to_i)
    travel 3.seconds
    check_payment!(reference, payment_hash)

    # A new session is a new browser process. The signed cookie is what it
    # brings back, and it is the whole of what makes the order still theirs.
    reset!
    cookies[ShopIdentity::COOKIE] = cookie

    get "/shop/orders/#{reference}/downloads/signal-red"
    assert_response :success
    assert_equal 1, ShopUser.count
  end

  test "reconciliation settles a pending attempt without browser polling" do
    reference = create_order!(sku: "midnight-navy", quantity: 1).fetch("reference")
    payment_hash = create_checkout!(reference).fetch("payment_hash")
    @wallet.settle!(payment_hash, at: Time.now.to_i)

    assert_equal 1, OpenReceive.reconcile!.length

    assert_equal ShopOrder::PAID, ShopOrder.find(reference).state
    assert_equal "settled", OpenReceivePayment.find_by(payment_hash: payment_hash).status
  end

  test "a settled order appears in the public feed, to a visitor who never bought anything" do
    reference = create_order!(sku: "classic-black", quantity: 1).fetch("reference")
    buyer_ref = ShopOrder.find(reference).shop_user.public_ref
    payment_hash = create_checkout!(reference).fetch("payment_hash")
    @wallet.settle!(payment_hash, at: Time.now.to_i)
    assert_equal 1, OpenReceive.reconcile!.length

    reset!
    get "/shop/recent_orders"

    assert_response :success
    row = JSON.parse(response.body).fetch("orders").sole
    assert_equal buyer_ref, row.fetch("buyer")
    assert_equal 500, row.fetch("total_cents")
    assert_equal "Classic Black", row.fetch("items").sole.fetch("name")
    refute_includes response.body, reference
  end

  test "rate limiting stamps the client IP on committed attempts" do
    reference = create_order!(sku: "plain-white", quantity: 1).fetch("reference")
    create_checkout!(reference)

    assert_equal ["127.0.0.1"], OpenReceivePayment.pluck(:client_ip).uniq
  end

  test "the SPA shell is not cached so webpack rebuilds reach the browser" do
    get "/"

    assert_response :success
    assert_includes response.headers["Cache-Control"], "no-store"
    assert_match %r{/packs-test/js/buttons-[0-9a-f]+\.js}, response.body
  end

  private

  def create_order!(sku:, quantity:)
    post "/shop/orders", params: { items: [{ sku: sku, quantity: quantity }] }, as: :json
    assert_response :created
    JSON.parse(response.body)
  end

  def create_checkout!(reference)
    post "/openreceive/checkouts",
         params: JSON.generate(reference: reference), headers: JSON_HEADERS
    assert_response :created
    JSON.parse(response.body).fetch("checkout")
  end

  def check_payment!(reference, payment_hash)
    post "/openreceive/payments/check",
         params: JSON.generate(reference: reference, payment_hash: payment_hash),
         headers: JSON_HEADERS
    assert_response :success
    JSON.parse(response.body)
  end
end
