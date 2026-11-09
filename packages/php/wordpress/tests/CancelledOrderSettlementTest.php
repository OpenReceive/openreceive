<?php
declare(strict_types=1);

namespace OpenReceive\WP;

use PHPUnit\Framework\TestCase;

/**
 * What happens to a store order the merchant already cancelled, or that is
 * gone, when its payment arrives. The scenarios run in cancelled-order-settlement.php
 * in their own process (its wpdb stand-in answers GET_LOCK); these assertions
 * pin the observed behaviour.
 */
final class CancelledOrderSettlementTest extends TestCase
{
    /** @var array<string, array<string, mixed>> */
    private static array $results;

    public static function setUpBeforeClass(): void
    {
        $command = [PHP_BINARY, __DIR__ . '/cancelled-order-settlement.php'];
        $process = proc_open($command, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);
        $stdout = (string) stream_get_contents($pipes[1]);
        $stderr = (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($process);
        self::assertSame(0, $exit, "the scenario script failed:\n{$stderr}\n{$stdout}");
        self::$results = json_decode($stdout, true, 512, JSON_THROW_ON_ERROR);
    }

    public function testAWooCommerceOrderCancelledBeforeThePaymentStaysCancelled(): void
    {
        $result = self::$results['wooCancelled'];
        self::assertNull($result['amount_for_after_cancel'], 'a cancelled order no longer has a price');
        self::assertSame('settled', $result['row'], 'the wallet truth is recorded');
        self::assertSame('cancelled', $result['order_status'], 'the operator decision stands');
        self::assertSame(0, $result['payment_complete_calls'], 'payment_complete never runs, so WooCommerce neither fulfills nor touches stock again');
        self::assertSame('yes', $result['marker'], 'the completion marker stays on the order');
        self::assertTrue($result['hash_recorded']);
    }

    public function testAMerchantIsToldWhenPaymentArrivesOnACancelledWooCommerceOrder(): void
    {
        self::assertCount(1, self::$results['wooCancelled']['notes']);
        self::assertStringContainsString('reinstate the order or refund the customer', self::$results['wooCancelled']['notes'][0]);
    }

    public function testACancelledWooCommerceOrderReopenedByTheMerchantCompletesThroughRepair(): void
    {
        $result = self::$results['wooCancelledThenReopened'];
        self::assertSame('processing', $result['order_status']);
        self::assertSame(1, $result['payment_complete_calls']);
        self::assertNull($result['marker']);
    }

    public function testADeletedWooCommerceOrderIsRetriedForeverWithoutStarvingALiveOne(): void
    {
        $result = self::$results['wooDeleted'];
        self::assertSame('pending', $result['row'], 'the failed hook rolled back, so the payment is not dropped');
        self::assertSame('settled', $result['live_row']);
        self::assertSame('processing', $result['live_order']);
        self::assertSame(['ran', 'ran', 'ran'], $result['reasons']);
        self::assertStringContainsString('Settlement order is missing.', (string) $result['warning']);
        self::assertSame(3, $result['warning_count'], 'one warning per pass, for as long as the wallet reports it');
    }

    public function testAnEddOrderRevokedBeforeThePaymentStaysRevoked(): void
    {
        $result = self::$results['eddRevoked'];
        self::assertNull($result['amount_for_after_cancel']);
        self::assertSame('settled', $result['row']);
        self::assertSame('revoked', $result['order_status']);
        self::assertSame('yes', $result['marker']);
        self::assertTrue($result['hash_recorded']);
    }

    public function testAMerchantIsToldWhenPaymentArrivesOnARevokedEddOrder(): void
    {
        self::assertCount(1, self::$results['eddRevoked']['notes']);
        self::assertStringContainsString('reinstate the order or refund the customer', self::$results['eddRevoked']['notes'][0]);
    }

    public function testAMissingEddOrderIsRetriedAndLoggedRatherThanDropped(): void
    {
        $result = self::$results['eddDeleted'];
        self::assertSame('pending', $result['row']);
        self::assertStringContainsString('Settlement order is missing.', (string) $result['warning']);
    }

    public function testAnEddRepairStillReachesARecoverableOrderBehindFiftyStuckMarkers(): void
    {
        $result = self::$results['eddStuckMarkersAheadOfARecoverableOrder'];
        self::assertSame(50, $result['stuck_markers'], 'the revoked orders keep their markers');
        self::assertSame('complete', $result['recoverable_status']);
    }
}
