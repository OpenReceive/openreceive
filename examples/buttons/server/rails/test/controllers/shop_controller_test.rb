# frozen_string_literal: true

require "test_helper"

# PART 11.2 — orders, the trust boundary, and 404-not-403.
class ShopControllerTest < ActionDispatch::IntegrationTest
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    ensure_pack_assets!
  end

  test "POST /shop/orders attaches the current shop user" do
    post shop_orders_path, params: { items: [{ sku: "safety-orange", quantity: 1 }] }, as: :json

    assert_response :created
    order = ShopOrder.find(json_body.fetch("reference"))
    assert_equal ShopUser.sole.id, order.shop_user_id
    assert_equal ShopOrder::AWAITING_PAYMENT, order.state
  end

  test "a price in the request body is ignored" do
    post shop_orders_path,
         params: { items: [{ sku: "signal-red", quantity: 1, price_cents: 1,
                             unit_price_cents: 1, total_cents: 1 }] },
         as: :json

    assert_response :created
    # $10.00 from the product row, not the $0.01 the payer asked for.
    assert_equal 1000, json_body.fetch("total_cents")
    assert_equal "10.00", json_body.fetch("total_amount")
    assert_equal 1000, ShopOrder.sole.total_cents
  end

  test "quantity 999 clamps to MAX_PER_SKU" do
    post shop_orders_path, params: { items: [{ sku: "safety-orange", quantity: 999 }] }, as: :json

    assert_response :created
    assert_equal ShopProduct::MAX_PER_SKU, json_body.fetch("items").sole.fetch("quantity")
  end

  test "duplicate lines merge and still clamp" do
    post shop_orders_path,
         params: { items: [{ sku: "safety-orange", quantity: 7 },
                           { sku: "safety-orange", quantity: 7 }] },
         as: :json

    assert_response :created
    assert_equal ShopProduct::MAX_PER_SKU, json_body.fetch("items").sole.fetch("quantity")
  end

  test "an unknown sku is dropped rather than raising" do
    post shop_orders_path,
         params: { items: [{ sku: "no-such-button", quantity: 1 },
                           { sku: "plain-white", quantity: 1 }] },
         as: :json

    assert_response :created
    assert_equal ["plain-white"], json_body.fetch("items").map { |item| item.fetch("sku") }
  end

  test "a deactivated sku is dropped" do
    ShopProduct.find_by!(sku: "plain-white").update!(active: false)

    post shop_orders_path, params: { items: [{ sku: "plain-white", quantity: 1 }] }, as: :json

    assert_response :unprocessable_content
    assert_equal 0, ShopOrder.count
  end

  test "an empty cart is a 422 with an error string, not a row" do
    post shop_orders_path, params: { items: [] }, as: :json

    assert_response :unprocessable_content
    assert_equal "Your cart is empty.", json_body.fetch("error")
    assert_equal 0, ShopOrder.count
  end

  test "a non-array items parameter is a 422, not a 500" do
    post shop_orders_path, params: { items: "safety-orange" }, as: :json

    assert_response :unprocessable_content
    assert_equal 0, ShopOrder.count
  end

  test "GET show returns the order and withholds downloads until it is paid" do
    order = create_order!

    get shop_order_path(order)

    assert_response :success
    assert_equal ShopOrder::AWAITING_PAYMENT, json_body.fetch("state")
    assert_nil json_body.fetch("items").sole.fetch("download_path")
  end

  test "GET show with a different cookie is 404, not 403" do
    order = create_order!
    other = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
    cookies[ShopIdentity::COOKIE] = sign_shop_cookie(other.id)

    get shop_order_path(order)

    assert_response :not_found
  end

  test "GET show of a nonexistent order is 404" do
    create_order!

    get shop_order_path(SecureRandom.uuid)

    assert_response :not_found
  end

  test "a download on an unpaid order is 403" do
    order = create_order!

    get shop_order_download_path(order, "safety-orange")

    assert_response :forbidden
  end

  test "a paid order serves the artwork and advertises the download" do
    order = create_order!
    mark_paid!(order)

    get shop_order_path(order)
    assert_response :success
    assert_equal shop_order_download_path(order, "safety-orange"),
                 json_body.fetch("items").sole.fetch("download_path")

    get shop_order_download_path(order, "safety-orange")
    assert_response :success
    assert_equal "image/webp", response.media_type
  end

  test "GET download with a different cookie is 404" do
    order = create_order!
    mark_paid!(order)
    other = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
    cookies[ShopIdentity::COOKIE] = sign_shop_cookie(other.id)

    get shop_order_download_path(order, "safety-orange")

    assert_response :not_found
  end

  test "a download for a sku that is not on the order is 404" do
    order = create_order!
    mark_paid!(order)

    get shop_order_download_path(order, "signal-red")

    assert_response :not_found
  end

  test "a deactivated product still downloads for an order that paid for it" do
    order = create_order!
    mark_paid!(order)
    ShopProduct.find_by!(sku: "safety-orange").update!(active: false)

    get shop_order_download_path(order, "safety-orange")

    assert_response :success
  end

  test "the bootstrap payload carries the catalog, the prefix and the public ref only" do
    get root_path

    assert_response :success
    payload = JSON.parse(
      response.body[%r{<script id="__shop_bootstrap" type="application/json">\s*(.+?)\s*</script>}m, 1]
    ).fetch("shop")

    assert_equal 6, payload.fetch("catalog").length
    assert_equal "/openreceive", payload.fetch("openreceive_prefix")
    assert_equal ShopProduct::MAX_PER_SKU, payload.fetch("max_per_sku")

    visitor = payload.fetch("visitor")
    assert_equal ShopUser.sole.public_ref, visitor.fetch("public_ref")
    # The private id is the cookie's business and nothing else's.
    refute_includes response.body, ShopUser.sole.id
  end

  private

  def create_order!(sku: "safety-orange", quantity: 1)
    post shop_orders_path, params: { items: [{ sku: sku, quantity: quantity }] }, as: :json
    assert_response :created
    ShopOrder.find(json_body.fetch("reference"))
  end

  def mark_paid!(order)
    assert ShopOrder.claim_paid!(reference: order.id, paid_at: Time.current,
                                 payment_hash: "c" * 64)
  end
end
