<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Testing;

use OpenReceive\Nwc\Info;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Swap\Assets;
use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;

/**
 * THE FIXTURES ARE THE CONTRACT (docs/internal/testkit-contract.md). These
 * fakes are a port of packages/js/testkit; one Playwright suite drives every
 * stack and asserts the same strings, so drift here fails as a one-stack E2E
 * mystery. The assertions mirror the Rails fixture test verbatim.
 */
final class TestkitFixturesTest extends TestCase
{
    public function testTheWalletMintsTheJsTestkitInvoiceAndPaymentHashFixtures(): void
    {
        $wallet = new FakeWallet();
        $first = $wallet->makeInvoice(['amount_msats' => 2_000_000, 'expiry' => 600]);
        self::assertSame(str_repeat('0', 63) . '1', $first['payment_hash']);
        self::assertSame('lnbcopenreceive000001', $first['invoice']);
        self::assertSame(2_000_000, $first['amount_msats']);
        // The requested expiry is honoured EXACTLY.
        self::assertSame(600, $first['expires_at'] - $first['created_at']);
        $second = $wallet->makeInvoice(['amount_msats' => 1_000]);
        self::assertSame(str_repeat('0', 63) . '2', $second['payment_hash']);
        $this->expectException(\InvalidArgumentException::class);
        $wallet->makeInvoice(['amount_msats' => 999]);
    }

    public function testAPendingInvoiceIsAbsentFromHistoryAndSettlingPutsItThere(): void
    {
        $wallet = new FakeWallet();
        $minted = $wallet->makeInvoice(['amount_msats' => 2_000_000]);
        self::assertSame([], $wallet->listTransactions([])['transactions']);
        self::assertCount(1, $wallet->listTransactions(['unpaid' => true])['transactions']);
        $notified = [];
        $wallet->subscribeNotifications(static function (array $notification) use (&$notified): void {
            $notified[] = $notification;
            throw new \RuntimeException('a throwing handler never breaks the subscription');
        });
        $wallet->settleInvoice(['payment_hash' => $minted['payment_hash']], null, null, true);
        $rows = $wallet->listTransactions([])['transactions'];
        self::assertCount(1, $rows);
        self::assertSame($minted['payment_hash'], $rows[0]['payment_hash']);
        self::assertSame('settled', $rows[0]['transaction_state']);
        self::assertGreaterThan(0, $rows[0]['settled_at']);
        self::assertSame(FakeWallet::PREIMAGE, $rows[0]['preimage']);
        self::assertSame('payment_received', $notified[0]['notification_type']);
        self::assertSame($minted['payment_hash'], $notified[0]['notification']['payment_hash']);
        self::assertSame([], $wallet->listTransactions(['type' => 'outgoing'])['transactions']);
        $this->expectException(\OutOfBoundsException::class);
        $wallet->expireInvoice(['payment_hash' => str_repeat('9', 64)]);
    }

    public function testTheWalletAdvertisesReceiveMethodsOnly(): void
    {
        $summary = Info::summarize((new FakeWallet())->preflight());
        self::assertTrue($summary['receive_checkout_ready']);
        self::assertFalse($summary['spend_capability_advertised']);
        self::assertSame('nip04', $summary['encryption']);
    }

    public function testScriptedHistoryReadsAdvanceThenFallBack(): void
    {
        $wallet = new FakeWallet();
        $minted = $wallet->makeInvoice(['amount_msats' => 2_000_000]);
        $wallet->scriptTransactionSequence($minted['payment_hash'], ['settled', new \RuntimeException('relay hiccup')]);
        self::assertSame('settled', $wallet->listTransactions([])['transactions'][0]['transaction_state']);
        try {
            $wallet->listTransactions([]);
            self::fail('the scripted error was not thrown');
        } catch (\RuntimeException $e) {
            self::assertSame('relay hiccup', $e->getMessage());
        }
        self::assertSame([], $wallet->listTransactions([])['transactions'], 'back to the stored pending state');
    }

    public function testTheSwapProviderMintsTheJsTestkitOrderFixtures(): void
    {
        $provider = new FakeSwapProvider();
        $order = $provider->createSwap('USDT_TRON', 'lnbc1', 2_000_000);
        self::assertSame('fixedfloat', $order['provider']);
        self::assertSame('testkit-swap-1', $order['provider_order_id']);
        self::assertSame('testkit-token-1', $order['provider_token']);
        self::assertSame('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', $order['deposit_address']);
        self::assertSame('1.05', $order['deposit_amount']);
        self::assertSame('awaiting_deposit', $order['state']);
        self::assertSame(1_800, $provider->invoiceExpirySeconds('USDT_TRON'));
        self::assertSame('1.05', $provider->quote('USDT_TRON', 2_000_000)['pay_amount']);
    }

    public function testEachAssetsDepositAddressPinsItsNetworkNotItsTicker(): void
    {
        $provider = new FakeSwapProvider();
        self::assertSame('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', $provider->createSwap('USDT_TRON', 'a', 2_000_000)['deposit_address']);
        self::assertSame('So11111111111111111111111111111111111111112', $provider->createSwap('USDT_SOL', 'b', 2_000_000)['deposit_address']);
        self::assertSame('0x1111111111111111111111111111111111111111', $provider->createSwap('USDC_ETH', 'c', 2_000_000)['deposit_address']);
    }

    public function testAScriptAdvancesOneStatePerPollAndThenHolds(): void
    {
        $provider = new FakeSwapProvider();
        $order = $provider->createSwap('USDT_TRON', 'a', 2_000_000);
        $provider->script(['provider_order_id' => $order['provider_order_id']], ['confirming', 'completed']);
        self::assertSame('confirming', $provider->getStatus($order)['state']);
        $completed = $provider->getStatus($order);
        self::assertSame('completed', $completed['state']);
        self::assertSame('testkit-deposit-tx', $completed['deposit_tx_id']);
        self::assertSame('testkit-payout-tx', $completed['payout_tx_id']);
        self::assertSame('completed', $provider->getStatus($order)['state']);
    }

    public function testRefundRequiredLandsImmediatelyAndARefundMovesItToRefundPending(): void
    {
        $provider = new FakeSwapProvider();
        $order = $provider->createSwap('USDT_TRON', 'a', 2_000_000);
        $provider->forceRefundRequired(['provider_order_id' => $order['provider_order_id']]);
        self::assertSame('refund_required', $provider->getStatus($order)['state']);
        $provider->requestRefund($order, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
        self::assertSame('refund_pending', $provider->getStatus($order)['state']);
        self::assertSame(
            [['provider_order_id' => $order['provider_order_id'], 'refund_address' => 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t']],
            $provider->counters()['refund_calls']
        );
        $provider->forceAttention(['provider_order_id' => $order['provider_order_id']]);
        $attention = $provider->getStatus($order);
        self::assertTrue($attention['attention']);
        self::assertSame('provider_reported_emergency', $attention['attention_reason']);
    }

    public function testAnAssetScriptedBeforeAnyAttemptArmsTheNextAttemptForIt(): void
    {
        $provider = new FakeSwapProvider();
        $provider->forceRefundRequired('SOL_SOL');
        $order = $provider->createSwap('SOL_SOL', 'a', 2_000_000);
        self::assertSame('refund_required', $provider->getStatus($order)['state']);
        $provider->forceCreateError();
        $this->expectException(\RuntimeException::class);
        $provider->createSwap('SOL_SOL', 'b', 2_000_000);
    }

    public function testTheCatalogCoversEveryPayInAssetTheEngineKnows(): void
    {
        $provider = new FakeSwapProvider();
        $catalog = $provider->payInAssetCatalog();
        $assets = array_column($catalog, 'pay_asset');
        sort($assets);
        $expected = Assets::PAY_IN_ASSETS;
        sort($expected);
        self::assertSame($expected, $assets);
        foreach ($catalog as $row) {
            self::assertTrue($row['available']);
        }
    }

    public function testAOneDollarButtonIsTwoThousandSatsAtTheStaticPrice(): void
    {
        // The one fixture shared across languages and price code.
        self::assertSame('50000.00', (new StaticPriceProvider())->btcFiatPrice('USD'));
        self::assertSame(2_000_000, \OpenReceive\Money\Money::quoteFiatToMsats('1.00', (new StaticPriceProvider())->btcFiatPrice('USD')));
    }
}
