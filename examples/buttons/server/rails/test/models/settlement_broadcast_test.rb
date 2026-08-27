# frozen_string_literal: true

require "test_helper"

# WHEN the settlement push is sent, which is the part that is easy to get wrong.
#
# `config.on_paid` runs INSIDE OpenReceive's settlement transaction, where the
# rule is database writes only. The initializer therefore SCHEDULES the
# broadcast with `ActiveRecord.after_all_transactions_commit` rather than
# sending it.
class SettlementBroadcastTest < ActiveSupport::TestCase
  include ButtonShopTestSetup
  include ActionCable::TestHelper

  setup do
    seed_catalog!
    @user = ShopUser.create!(first_seen_at: Time.current, last_seen_at: Time.current)
    @order = ShopOrder.create_from_lines!(
      [{ product: ShopProduct.find_by!(sku: "classic-black"), quantity: 1 }], shop_user: @user
    )
  end

  test "settlement broadcasts on both streams" do
    assert_broadcast_on(ShopFeedChannel::STREAM, "message" => "orders-changed") do
      assert_broadcast_on(ShopOrderChannel.broadcasting_for(@order.id),
                          "message" => "order-paid") do
        ActiveRecord::Base.transaction { settle!(@order) }
      end
    end

    assert_equal ShopOrder::PAID, @order.reload.state
  end

  # THE TEST THIS DESIGN EXISTS FOR.
  #
  # A broadcast sent from inside the hook survives a rollback: every browser is
  # told to re-read an order that was never committed, and the payer is told
  # their unpaid order is paid.
  test "a rolled-back settlement broadcasts nothing" do
    assert_no_broadcasts(ShopFeedChannel::STREAM) do
      assert_no_broadcasts(ShopOrderChannel.broadcasting_for(@order.id)) do
        ActiveRecord::Base.transaction do
          settle!(@order)
          raise ActiveRecord::Rollback
        end
      end
    end

    assert_equal ShopOrder::AWAITING_PAYMENT, @order.reload.state
  end

  # A duplicate settlement loses the guarded UPDATE, so it schedules nothing —
  # the payer is not told twice and the feed is not re-read for nothing.
  test "a second settlement broadcasts nothing" do
    ActiveRecord::Base.transaction { settle!(@order) }

    assert_no_broadcasts(ShopFeedChannel::STREAM) do
      ActiveRecord::Base.transaction { settle!(@order) }
    end
  end

  # Outside a transaction, `after_all_transactions_commit` runs the block
  # immediately — so the hook is correct on both paths, not only the one
  # OpenReceive happens to use today.
  test "settlement outside a transaction still broadcasts" do
    assert_broadcast_on(ShopFeedChannel::STREAM, "message" => "orders-changed") do
      settle!(@order)
    end
  end

  private

  def settle!(order)
    OpenReceive.config.on_paid.call(
      OpenReceive::PaymentSettlement.new(
        reference: order.id, payment_hash: "b" * 64, paid_at: Time.current.to_i
      )
    )
  end
end
