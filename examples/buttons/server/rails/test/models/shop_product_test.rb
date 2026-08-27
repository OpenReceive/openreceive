# frozen_string_literal: true

require "test_helper"

# PART 11.5 — the catalog, and what the item snapshots are for.
class ShopProductTest < ActiveSupport::TestCase
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    @user = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
  end

  test "the seed produces the six buttons in catalog order" do
    assert_equal %w[safety-orange midnight-navy classic-black vintage-cream plain-white signal-red],
                 ShopProduct.active.ordered.pluck(:sku)
    assert_equal [100, 300, 500, 700, 900, 1000], ShopProduct.active.ordered.pluck(:price_cents)
  end

  test "the seed is idempotent" do
    seed_catalog!

    assert_equal 6, ShopProduct.count
  end

  test "deactivating a product hides it from the catalog and from order creation" do
    signal_red.update!(active: false)

    refute_includes ShopProduct.active.ordered.pluck(:sku), "signal-red"
    assert_nil ShopProduct.active_by_sku("signal-red")
  end

  test "deactivating leaves an existing order's receipt, download and feed row intact" do
    order = ShopOrder.create_from_lines!(
      [{ product: signal_red, quantity: 2 }], shop_user: @user
    )
    signal_red.update!(active: false)

    item = order.reload.items.sole
    # This is what the snapshots are for.
    assert_equal "signal-red", item.sku
    assert_equal "Signal Red", item.name
    assert_equal 1000, item.unit_price_cents
    assert_equal "OpenReceive buttons: Signal Red ×2", order.checkout_description
  end

  test "an item survives its product being deleted" do
    order = ShopOrder.create_from_lines!(
      [{ product: plain_white, quantity: 1 }], shop_user: @user
    )
    plain_white.destroy!

    item = order.reload.items.sole
    assert_nil item.product
    assert_equal "plain-white", item.sku
    assert_equal "Plain White", item.name
    assert_equal 900, item.unit_price_cents
  end

  test "image_name defaults from the sku when blank, and is respected when set" do
    derived = ShopProduct.create!(sku: "hazard-yellow", name: "Hazard Yellow", price_cents: 200)
    assert_equal "openreceive-hazard-yellow-button.webp", derived.image_name

    explicit = ShopProduct.create!(sku: "storm-grey", name: "Storm Grey", price_cents: 200,
                                   image_name: "special-artwork.webp")
    assert_equal "special-artwork.webp", explicit.image_name
  end

  test "a sku must be kebab-case, unique, and priced above zero" do
    refute ShopProduct.new(sku: "Not Kebab", name: "x", price_cents: 100).valid?
    refute ShopProduct.new(sku: "safety-orange", name: "x", price_cents: 100).valid?
    refute ShopProduct.new(sku: "free-one", name: "x", price_cents: 0).valid?
  end

  test "active_by_sku format-checks before querying" do
    assert_nil ShopProduct.active_by_sku("'; drop table shop_products; --")
    assert_nil ShopProduct.active_by_sku(nil)
    assert_equal signal_red, ShopProduct.active_by_sku("signal-red")
  end

  test "price_dollars is a decimal string" do
    assert_equal "10.00", signal_red.price_dollars
    assert_equal "1.00", ShopProduct.find_by!(sku: "safety-orange").price_dollars
  end

  private

  def signal_red = ShopProduct.find_by!(sku: "signal-red")
  def plain_white = ShopProduct.find_by!(sku: "plain-white")
end
