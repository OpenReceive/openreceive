# frozen_string_literal: true

require "test_helper"

# PART 11.3 — settlement.
class ShopOrderTest < ActiveSupport::TestCase
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    @user = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
  end

  test "claim_paid! returns true then false, and the second call changes nothing" do
    order = place(safety_orange => 1)
    first_at = Time.utc(2026, 8, 27, 12, 0, 0)
    second_at = Time.utc(2026, 8, 27, 13, 0, 0)

    assert ShopOrder.claim_paid!(reference: order.id, paid_at: first_at, payment_hash: "a" * 64)

    # The WHERE clause is the lock: a second caller updates zero rows.
    refute ShopOrder.claim_paid!(reference: order.id, paid_at: second_at, payment_hash: "b" * 64)

    order.reload
    assert_equal ShopOrder::PAID, order.state
    assert_equal first_at, order.paid_at
    assert_equal "a" * 64, order.payment_hash
  end

  test "claim_paid! refuses a malformed reference rather than letting it reach postgres" do
    refute ShopOrder.claim_paid!(reference: "not-a-uuid", paid_at: Time.current,
                                 payment_hash: "a" * 64)
    refute ShopOrder.claim_paid!(reference: nil, paid_at: Time.current, payment_hash: "a" * 64)
  end

  test "find_by_reference format-checks before querying" do
    order = place(safety_orange => 1)

    assert_equal order, ShopOrder.find_by_reference(order.id)
    assert_nil ShopOrder.find_by_reference("'; drop table shop_orders; --")
    assert_nil ShopOrder.find_by_reference(12_345)
  end

  test "total_amount is a decimal string, and 1.00 rather than 1.0" do
    order = place(safety_orange => 1)

    assert_equal "1.00", order.total_amount
    assert_instance_of String, order.total_amount
  end

  test "amount_for reads only from the row" do
    order = place(safety_orange => 2, classic_black => 1)

    amount = OpenReceive.config.amount_for.call(order.id)

    assert_equal "USD", amount[:currency]
    # 2 × $1.00 + 1 × $5.00, summed on the server from product rows.
    assert_equal "7.00", amount[:value]
    assert_equal "OpenReceive buttons: Safety Orange ×2, Classic Black", amount[:description]
  end

  test "amount_for is nil for an unknown or malformed reference" do
    assert_nil OpenReceive.config.amount_for.call(SecureRandom.uuid)
    assert_nil OpenReceive.config.amount_for.call("nonsense")
  end

  test "checkout_description reads the item snapshots, not the live catalog" do
    order = place(signal_red => 1)
    signal_red.update!(name: "Renamed Since")

    assert_equal "OpenReceive button: Signal Red", order.reload.checkout_description
  end

  test "create_from_lines! prices from the product rows and snapshots them" do
    order = place(vintage_cream => 3)

    assert_equal 2100, order.total_cents
    item = order.items.sole
    assert_equal "vintage-cream", item.sku
    assert_equal "Vintage Cream", item.name
    assert_equal 700, item.unit_price_cents
    assert_equal vintage_cream, item.product
  end

  private

  def place(lines)
    ShopOrder.create_from_lines!(
      lines.map { |product, quantity| { product: product, quantity: quantity } },
      shop_user: @user
    )
  end

  def safety_orange = ShopProduct.find_by!(sku: "safety-orange")
  def classic_black = ShopProduct.find_by!(sku: "classic-black")
  def vintage_cream = ShopProduct.find_by!(sku: "vintage-cream")
  def signal_red = ShopProduct.find_by!(sku: "signal-red")
end
