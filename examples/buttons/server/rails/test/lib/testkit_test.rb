# frozen_string_literal: true

require "test_helper"
require Rails.root.join("lib/button_shop/testkit")

# THE FIXTURES ARE THE CONTRACT.
#
# These fakes are a port of packages/js/testkit, and the reason to port rather
# than invent is that one Playwright suite drives all four stacks and asserts
# the same strings — the Tron deposit address, `testkit-swap-N`, a payment hash
# that is the mint counter in 64 hex characters. Drift here does not fail
# loudly; it fails as a Rails-only E2E mystery. So the values are pinned.
class TestkitFixturesTest < ActiveSupport::TestCase
  test "the wallet mints the JS testkit's invoice and payment-hash fixtures" do
    wallet = ButtonShop::Testkit::Wallet.new

    first = wallet.make_invoice("amount_msats" => 2_000_000, "expiry" => 600)

    assert_equal "0" * 63 + "1", first.fetch("payment_hash")
    assert_equal "lnbcopenreceive000001", first.fetch("invoice")
    assert_equal 2_000_000, first.fetch("amount_msats")
    # The requested expiry is honoured EXACTLY: the service rejects a deviation
    # over 60s on the swap path, where the shadow invoice must outlive the
    # provider order.
    assert_equal 600, first.fetch("expires_at") - first.fetch("created_at")

    second = wallet.make_invoice("amount_msats" => 1_000)
    assert_equal "0" * 63 + "2", second.fetch("payment_hash")
  end

  test "a pending invoice is absent from history, and settling puts it there" do
    wallet = ButtonShop::Testkit::Wallet.new
    minted = wallet.make_invoice("amount_msats" => 2_000_000)

    assert_empty wallet.list_transactions.fetch("transactions")

    wallet.settle_invoice(minted.fetch("payment_hash"))
    row = wallet.list_transactions.fetch("transactions").sole

    assert_equal minted.fetch("payment_hash"), row.fetch("payment_hash")
    assert_equal "settled", row.fetch("transaction_state")
    assert row.fetch("settled_at").positive?
  end

  test "the wallet advertises receive methods only" do
    summary = OpenReceive::Server::WalletInfo.summarize(ButtonShop::Testkit::Wallet.new.get_info)

    assert summary.fetch("receive_checkout_ready")
    refute summary.fetch("spend_capability_advertised")
    assert_equal "nip04", summary.fetch("encryption")
  end

  test "the swap provider mints the JS testkit's order fixtures" do
    provider = ButtonShop::Testkit::SwapProvider.new
    order = provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: "lnbc1", invoice_amount_msats: 2_000_000)

    assert_equal "fixedfloat", order.fetch("provider")
    assert_equal "testkit-swap-1", order.fetch("provider_order_id")
    assert_equal "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", order.fetch("deposit_address")
    assert_equal "1.05", order.fetch("deposit_amount")
    assert_equal "awaiting_deposit", order.fetch("state")
  end

  test "each asset's deposit address pins its NETWORK, not its ticker" do
    provider = ButtonShop::Testkit::SwapProvider.new

    tron = provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: "a", invoice_amount_msats: 2_000_000)
    solana = provider.create_swap(pay_in_asset: "USDT_SOL", bolt11: "b", invoice_amount_msats: 2_000_000)
    ethereum = provider.create_swap(pay_in_asset: "USDC_ETH", bolt11: "c", invoice_amount_msats: 2_000_000)

    assert_equal "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", tron.fetch("deposit_address")
    assert_equal "So11111111111111111111111111111111111111112", solana.fetch("deposit_address")
    assert_equal "0x1111111111111111111111111111111111111111", ethereum.fetch("deposit_address")
  end

  test "a script advances one state per poll and then holds" do
    provider = ButtonShop::Testkit::SwapProvider.new
    order = provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: "a", invoice_amount_msats: 2_000_000)
    provider.script({ "provider_order_id" => order.fetch("provider_order_id") },
                    %w[confirming completed])

    assert_equal "confirming", provider.get_status(order).fetch("state")
    completed = provider.get_status(order)

    assert_equal "completed", completed.fetch("state")
    # A deposit that was detected carries its txid from `confirming` onward.
    assert_equal "testkit-deposit-tx", completed.fetch("deposit_tx_id")
    assert_equal "testkit-payout-tx", completed.fetch("payout_tx_id")
    assert_equal "completed", provider.get_status(order).fetch("state")
  end

  test "refund_required lands immediately, and a refund moves it to refund_pending" do
    provider = ButtonShop::Testkit::SwapProvider.new
    order = provider.create_swap(pay_in_asset: "USDT_TRON", bolt11: "a", invoice_amount_msats: 2_000_000)

    # Forced states do NOT wait for a poll: they are what a test jumps to, and
    # a poll's delay only makes the harness flakier.
    provider.force({ "provider_order_id" => order.fetch("provider_order_id") }, "refund_required")

    assert_equal "refund_required", provider.get_status(order).fetch("state")

    provider.request_refund(order, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")

    assert_equal "refund_pending", provider.get_status(order).fetch("state")
    assert_equal(
      [{ "provider_order_id" => order.fetch("provider_order_id"),
         "refund_address" => "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }],
      provider.counters.fetch("refund_calls")
    )
  end

  test "an asset scripted before any attempt arms the next attempt for it" do
    provider = ButtonShop::Testkit::SwapProvider.new
    provider.force({ "pay_in_asset" => "SOL_SOL" }, "refund_required")

    order = provider.create_swap(pay_in_asset: "SOL_SOL", bolt11: "a", invoice_amount_msats: 2_000_000)

    assert_equal "refund_required", provider.get_status(order).fetch("state")
  end

  test "the catalog covers every pay-in asset the engine knows" do
    provider = ButtonShop::Testkit::SwapProvider.new

    assert_equal OpenReceive::Server::Swap::Assets::PAY_IN_ASSETS.sort,
                 provider.pay_in_asset_catalog.map { |row| row.fetch("pay_asset") }.sort
    assert provider.pay_in_asset_catalog.all? { |row| row.fetch("available") }
  end

  test "a $1.00 button is 2,000 sats at the static price" do
    # The same constant the JS StaticPriceProvider uses. Every stack's E2E
    # asserts this number, so it is the one fixture shared across languages.
    assert_equal "50000.00", OpenReceive::Rates::StaticPriceProvider.new.btc_fiat_price("USD")
  end
end
