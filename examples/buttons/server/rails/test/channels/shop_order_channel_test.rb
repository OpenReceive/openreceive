# frozen_string_literal: true

require "test_helper"

# One payer's own order. Possession of an order id is a claim, not proof, so
# subscribing is authorized against the signed cookie — the same rule
# ShopController#authorized_order and `config.authorize` apply.
class ShopOrderChannelTest < ActionCable::Channel::TestCase
  include ButtonShopTestSetup

  setup do
    seed_catalog!
    @user = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
    @order = ShopOrder.create_from_lines!(
      [{ product: ShopProduct.find_by!(sku: "signal-red"), quantity: 1 }], shop_user: @user
    )
  end

  test "the payer may subscribe to their own order" do
    stub_shop_connection(@user.id)
    subscribe(reference: @order.id)

    assert subscription.confirmed?
    # The channel-scoped stream name, which is what `broadcast_paid` publishes
    # to. `assert_has_stream_for` would compute the SERVER-level name and miss
    # the "shop_order:" prefix `stream_for` adds.
    assert_has_stream ShopOrderChannel.broadcasting_for(@order.id)
    # And only that order's.
    assert_has_no_stream ShopOrderChannel.broadcasting_for(SecureRandom.uuid)
  end

  test "a stranger's subscription is rejected" do
    other = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
    stub_shop_connection(other.id)
    subscribe(reference: @order.id)

    assert subscription.rejected?
  end

  test "a connection with no cookie is rejected" do
    stub_shop_connection(nil)
    subscribe(reference: @order.id)

    assert subscription.rejected?
  end

  test "an unknown reference is rejected" do
    stub_shop_connection(@user.id)
    subscribe(reference: SecureRandom.uuid)

    assert subscription.rejected?
  end

  # Format-checked before it reaches the database, like every other anonymous
  # entry point: a malformed uuid literal raises in Postgres.
  test "a malformed reference is rejected rather than raising" do
    stub_shop_connection(@user.id)
    subscribe(reference: "'; drop table shop_orders; --")

    assert subscription.rejected?
  end

  test "the envelope carries no order data" do
    assert_broadcast_on(ShopOrderChannel.broadcasting_for(@order.id),
                        "message" => "order-paid") do
      ShopOrderChannel.broadcast_paid(@order.id)
    end
  end
end
