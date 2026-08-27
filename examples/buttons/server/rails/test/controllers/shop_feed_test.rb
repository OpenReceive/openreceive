# frozen_string_literal: true

require "test_helper"

# PART 11.4 — the public feed, and the leak test.
class ShopFeedTest < ActionDispatch::IntegrationTest
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    ensure_pack_assets!
  end

  test "returns paid rows only" do
    paid = create_order!(sku: "signal-red")
    mark_paid!(paid)
    create_order!(sku: "plain-white")

    get shop_recent_orders_path

    assert_response :success
    rows = json_body.fetch("orders")
    assert_equal 1, rows.length
    assert_equal 1000, rows.sole.fetch("total_cents")
  end

  test "returns ONLY the whitelisted fields" do
    order = create_order!(sku: "signal-red")
    mark_paid!(order, payment_hash: "d" * 64)

    get shop_recent_orders_path

    assert_response :success
    body = response.body

    # The order id IS the OpenReceive reference. Not even a truncated prefix.
    refute_includes body, order.id
    refute_includes body, order.id.first(8)
    refute_includes body, "download_path"
    refute_includes body, shop_order_download_path(order, "signal-red")
    refute_includes body, "d" * 64
    refute_includes body, "payment_hash"
    refute_includes body, "session"
    # shop_users.id is the ownership token in the signed cookie.
    refute_includes body, order.shop_user_id
    # Nothing off the engine-owned openreceive_payments row. (The image URLs
    # legitimately contain "openreceive" — they are the product filenames — so
    # this names the columns rather than the word.)
    %w[checkout_data swap_data client_ip inserted_at expires_at status_reason].each do |column|
      refute_includes body, column
    end

    row = json_body.fetch("orders").sole
    assert_equal %w[buyer currency items paid_at total_amount total_cents], row.keys.sort
    assert_equal %w[image_url name quantity sku], row.fetch("items").sole.keys.sort
    assert_equal ShopUser.sole.public_ref, row.fetch("buyer")
  end

  test "a larger ?limit= does not increase the row count" do
    (ShopOrder::FEED_LIMIT + 3).times do |index|
      order = create_order!(sku: "safety-orange")
      mark_paid!(order, payment_hash: index.to_s(16).rjust(64, "0"))
    end

    get shop_recent_orders_path, params: { limit: 500 }

    assert_response :success
    assert_equal ShopOrder::FEED_LIMIT, json_body.fetch("orders").length
  end

  test "the response carries a public cache header" do
    get shop_recent_orders_path

    assert_response :success
    assert_includes response.headers["Cache-Control"], "public"
    assert_includes response.headers["Cache-Control"], "max-age=10"
  end

  # The cache header alone is not enough once settlement is PUSHED.
  #
  # A client that has just been told the feed changed revalidates rather than
  # re-reading its ten-second-old copy (see `getJson`'s `fresh` option). That is
  # only cheap because this response also carries a validator: an unchanged feed
  # comes back 304 with no body and no second query per visitor.
  test "the response carries a validator so a push-triggered re-read is a 304" do
    get shop_recent_orders_path
    assert_response :success
    etag = response.headers["ETag"]
    assert etag.present?, "the feed must carry an ETag for revalidation to be cheap"

    get shop_recent_orders_path, headers: { "If-None-Match" => etag }
    assert_response :not_modified
  end

  # And the validator has to MOVE when a new order settles, or a revalidation
  # would answer 304 with the stale body and the pushed row would never appear.
  test "settling an order changes the validator" do
    get shop_recent_orders_path
    before = response.headers["ETag"]

    order = create_order!(sku: "vintage-cream")
    mark_paid!(order)

    get shop_recent_orders_path
    refute_equal before, response.headers["ETag"]
  end

  test "ordering is newest paid first" do
    first = create_order!(sku: "safety-orange")
    second = create_order!(sku: "signal-red")
    mark_paid!(first, at: Time.utc(2026, 8, 27, 10, 0, 0), payment_hash: "e" * 64)
    mark_paid!(second, at: Time.utc(2026, 8, 27, 11, 0, 0), payment_hash: "f" * 64)

    get shop_recent_orders_path

    assert_equal [1000, 100], json_body.fetch("orders").map { |row| row.fetch("total_cents") }
  end

  test "totals count paid orders and paid buttons only" do
    paid = create_order!(sku: "safety-orange", quantity: 3)
    mark_paid!(paid)
    create_order!(sku: "signal-red", quantity: 4)

    get shop_recent_orders_path

    assert_equal({ "paid_orders" => 1, "buttons_sold" => 3 }, json_body.fetch("totals"))
  end

  test "paid_at is unix seconds" do
    order = create_order!(sku: "safety-orange")
    at = Time.utc(2026, 8, 27, 12, 0, 0)
    mark_paid!(order, at: at)

    get shop_recent_orders_path

    assert_equal at.to_i, json_body.fetch("orders").sole.fetch("paid_at")
  end

  test "an empty feed is a well-formed payload rather than a 404" do
    get shop_recent_orders_path

    assert_response :success
    assert_equal [], json_body.fetch("orders")
    assert_equal({ "paid_orders" => 0, "buttons_sold" => 0 }, json_body.fetch("totals"))
  end

  test "the feed does not mint a visitor row" do
    get shop_recent_orders_path

    assert_response :success
    assert_equal 0, ShopUser.count
  end

  test "a deleted product leaves a feed row readable with no image" do
    order = create_order!(sku: "plain-white")
    mark_paid!(order)
    ShopProduct.find_by!(sku: "plain-white").destroy!

    get shop_recent_orders_path

    item = json_body.fetch("orders").sole.fetch("items").sole
    assert_equal "plain-white", item.fetch("sku")
    assert_equal "Plain White", item.fetch("name")
    assert_nil item.fetch("image_url")
  end

  private

  def create_order!(sku:, quantity: 1)
    post shop_orders_path, params: { items: [{ sku: sku, quantity: quantity }] }, as: :json
    assert_response :created
    ShopOrder.find(json_body.fetch("reference"))
  end

  def mark_paid!(order, at: Time.current, payment_hash: "c" * 64)
    assert ShopOrder.claim_paid!(reference: order.id, paid_at: at, payment_hash: payment_hash)
  end
end
