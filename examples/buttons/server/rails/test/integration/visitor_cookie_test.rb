# frozen_string_literal: true

require "test_helper"

# PART 11.1 — identity. A signed cookie holding a ShopUser id, and nothing else.
class VisitorCookieTest < ActionDispatch::IntegrationTest
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    ensure_pack_assets!
  end

  test "a first GET mints a cookie, and a second request reuses the same ShopUser" do
    get root_path

    assert_response :success
    assert_equal 1, ShopUser.count
    assert cookies[ShopIdentity::COOKIE].present?

    get root_path

    assert_response :success
    assert_equal 1, ShopUser.count
  end

  test "the cookie is signed, not the plain id" do
    get root_path

    raw = cookies[ShopIdentity::COOKIE]
    refute_equal ShopUser.sole.id, raw
    refute_includes raw, ShopUser.sole.id
  end

  test "two cookieless requests create two distinct users" do
    get root_path
    first = ShopUser.sole.id

    reset!
    get root_path

    assert_equal 2, ShopUser.count
    refute_equal first, ShopUser.order(:created_at).last.id
  end

  test "a tampered cookie value yields a NEW user, not a 500" do
    get root_path
    original = ShopUser.sole.id

    cookies[ShopIdentity::COOKIE] = "#{cookies[ShopIdentity::COOKIE]}tampered"
    get root_path

    assert_response :success
    assert_equal 2, ShopUser.count
    refute_equal original, ShopUser.order(:created_at).last.id
  end

  test "a validly-signed cookie for a deleted row yields a new user" do
    get root_path
    ShopUser.sole.destroy!

    get root_path

    assert_response :success
    assert_equal 1, ShopUser.count
  end

  # THE TEST THAT PROVES THE TWO-UUID DESIGN.
  #
  # public_ref is rendered to every visitor in the recent-orders feed. Setting
  # it — or any bare uuid — as an UNSIGNED cookie must not make you that user.
  test "a raw uuid set as an unsigned cookie is not accepted" do
    get root_path
    victim = ShopUser.sole

    reset!
    cookies[ShopIdentity::COOKIE] = victim.public_ref
    get root_path
    assert_response :success
    refute_equal victim.id, ShopUser.order(:created_at).last.id

    reset!
    cookies[ShopIdentity::COOKIE] = victim.id
    get root_path
    assert_response :success
    refute_equal victim.id, ShopUser.order(:created_at).last.id

    assert_equal 3, ShopUser.count
  end

  test "an order placed under a tampered cookie belongs to the new visitor, not the old one" do
    post shop_orders_path, params: { items: [{ sku: "safety-orange", quantity: 1 }] }, as: :json
    assert_response :created
    order = ShopOrder.find(json_body.fetch("reference"))
    owner = ShopUser.sole

    reset!
    cookies[ShopIdentity::COOKIE] = owner.id
    get shop_order_path(order)

    # Not 403 — do not confirm that an id exists.
    assert_response :not_found
  end

  test "a health-check route does not mint a user row" do
    get rails_health_check_path

    assert_response :success
    assert_equal 0, ShopUser.count
  end

  test "the recent-orders route does not mint a user row" do
    get shop_recent_orders_path

    assert_response :success
    assert_equal 0, ShopUser.count
  end

  test "the cookie is httponly, lax and rolls a year forward" do
    get root_path

    set_cookie = response.headers["Set-Cookie"]
    header = Array(set_cookie).join("\n").lines.find do |line|
      line.include?(ShopIdentity::COOKIE.to_s)
    end

    assert header.present?, "no Set-Cookie for #{ShopIdentity::COOKIE}"
    # Rack writes the attribute names in lower case.
    assert_includes header.downcase, "httponly"
    assert_includes header.downcase, "samesite=lax"
    assert_includes header.downcase, "path=/"
    assert_includes header, (Time.current + ShopIdentity::LIFETIME).utc.strftime("%d %b %Y")
  end

  test "touch_seen! is throttled so a page of requests is not a write storm" do
    user = ShopUser.create!(first_seen_at: 1.day.ago, last_seen_at: Time.current)

    assert_no_changes -> { user.reload.last_seen_at } do
      user.touch_seen!
    end

    user.update_column(:last_seen_at, 10.minutes.ago)
    user.touch_seen!
    assert user.reload.last_seen_at > 1.minute.ago
  end
end
