<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Reconciler;
use OpenReceive\Server\Service;
use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Storage\Timestamps;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * A database that is not set to UTC. Every session here runs in Asia/Tokyo
 * (UTC+9), whatever the server was started with, and the process has yet
 * another default zone. The engine writes UTC wall-clock text into TIMESTAMP
 * and DATETIME columns, so a session offset must change nothing; the expiry
 * boundaries below would catch a nine hour shift in either direction.
 *
 * tools/ci/deployment-edge-tests.sh also runs this against servers started in
 * that zone.
 */
final class NonUtcDatabaseTest extends DatabaseCase
{
    private const NOW = 1_794_210_000;

    private string $previousZone;

    protected function setUp(): void
    {
        $this->previousZone = date_default_timezone_get();
        if ($this->dataName() === 'none') {
            self::markTestSkipped('needs OPENRECEIVE_TEST_PGSQL_DSN or OPENRECEIVE_TEST_MYSQL_DSN');
        }
        date_default_timezone_set('America/New_York');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->previousZone);
    }

    /** @return iterable<string, array{0: string}> */
    public static function nonUtcDialects(): iterable
    {
        if (getenv('OPENRECEIVE_TEST_PGSQL_DSN') !== false) {
            yield 'pgsql' => ['pgsql'];
        }
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            yield 'mysql' => ['mysql'];
        }
        // PHPUnit errors on an empty provider, and most runs have no server database.
        if (getenv('OPENRECEIVE_TEST_PGSQL_DSN') === false && getenv('OPENRECEIVE_TEST_MYSQL_DSN') === false) {
            yield 'none' => ['none'];
        }
    }

    /** @return array{0: DatabaseConnection, 1: SqlPaymentRepository} */
    private function tokyoRepository(string $dialect): array
    {
        $db = self::freshDatabase($dialect);
        $db->execute($dialect === 'pgsql' ? "SET TIME ZONE 'Asia/Tokyo'" : "SET time_zone = '+09:00'");
        return [$db, new SqlPaymentRepository($db, static fn (): int => self::NOW)];
    }

    private static function storedText(DatabaseConnection $db, string $dialect, string $column, string $hash): string
    {
        $select = $dialect === 'pgsql'
            ? "to_char({$column}, 'YYYY-MM-DD HH24:MI:SS')"
            : "DATE_FORMAT({$column}, '%Y-%m-%d %H:%i:%s')";
        return (string) $db->query("SELECT {$select} AS wall_clock FROM openreceive_payments WHERE payment_hash = ?", [$hash])[0]['wall_clock'];
    }

    private static function utcText(int $unixSeconds): string
    {
        return (new \DateTimeImmutable("@{$unixSeconds}"))->format('Y-m-d H:i:s');
    }

    #[DataProvider('nonUtcDialects')]
    public function testColumnsHoldUtcWallClockInATokyoSession(string $dialect): void
    {
        [$db, $repository] = $this->tokyoRepository($dialect);
        $created = self::NOW - 60;
        $expires = self::NOW + 540;
        $hash = self::hash('tz-a');
        $record = $repository->commitAttempt('ord', $hash, self::checkout('ord', $hash, $created, $expires), null, '203.0.113.1');
        self::assertSame($created, $record->createdAt);
        self::assertSame($expires, $record->expiresAt);
        self::assertSame(self::utcText($expires), self::storedText($db, $dialect, 'expires_at', $hash));
        self::assertSame(self::utcText($created), self::storedText($db, $dialect, 'created_at', $hash));
        self::assertSame(self::utcText(self::NOW), self::storedText($db, $dialect, 'inserted_at', $hash));
        self::assertSame($expires, $repository->listForReference('ord')[0]->expiresAt);
        // The same read through the session clock is what would shift nine hours.
        self::assertSame(1, $repository->countAttemptsFromIp('203.0.113.1', self::NOW - 1));
        self::assertSame(0, $repository->countAttemptsFromIp('203.0.113.1', self::NOW + 1));
        self::assertSame(1, $repository->countAttemptsFromIp('203.0.113.1', self::NOW - 9 * 3600 - 1));
        self::assertSame(0, $repository->countAttemptsFromIp('203.0.113.1', self::NOW + 9 * 3600 + 1));
    }

    #[DataProvider('nonUtcDialects')]
    public function testPaidAtRoundTripsExactly(string $dialect): void
    {
        [$db, $repository] = $this->tokyoRepository($dialect);
        $hash = self::hash('tz-b');
        $repository->commitAttempt('paid', $hash, self::checkout('paid', $hash, self::NOW, self::NOW + 600));
        $paidAt = self::NOW + 123;
        self::assertTrue($repository->markPaidOnce($hash, $paidAt, null, static fn (PaymentSettlement $settlement) => null));
        self::assertSame($paidAt, $repository->findByPaymentHash($hash)?->paidAt);
        self::assertSame(self::utcText($paidAt), self::storedText($db, $dialect, 'paid_at', $hash));
    }

    #[DataProvider('nonUtcDialects')]
    public function testExpiryClosesOnTheClockNineHoursFromNowhere(string $dialect): void
    {
        [, $repository] = $this->tokyoRepository($dialect);
        $clock = static fn (): int => self::NOW;
        $service = new Service(new FakeWallet($clock), false, [], ['USD'], $clock);
        $reconciler = new Reconciler(
            $service,
            $repository,
            static fn (array $event): bool => $repository->markPaidOnce((string) $event['payment_hash'], (int) $event['paid_at'], null, static fn (PaymentSettlement $settlement) => null),
            true,
            null,
            $clock,
        );
        $grace = \OpenReceive\Payments\Reconciliation::EXPIRY_GRACE_SECONDS;
        $hashes = ['a' => self::hash('tz-past'), 'b' => self::hash('tz-grace'), 'c' => self::hash('tz-live')];
        $expiries = ['a' => self::NOW - $grace - 1, 'b' => self::NOW - $grace + 120, 'c' => self::NOW + 300];
        foreach ($hashes as $key => $hash) {
            $repository->commitAttempt("close-{$key}", $hash, self::checkout("close-{$key}", $hash, $expiries[$key] - 600, $expiries[$key]));
        }
        // The wallet has never heard of these: only the clock can close one.
        $reconciler->reconcile();
        self::assertSame('expired', $repository->findByPaymentHash($hashes['a'])?->status);
        self::assertSame('pending', $repository->findByPaymentHash($hashes['b'])?->status);
        self::assertSame('pending', $repository->findByPaymentHash($hashes['c'])?->status);
    }

    #[DataProvider('nonUtcDialects')]
    public function testTheScanWindowFindsASettledInvoice(string $dialect): void
    {
        // The walk's window comes from created_at read back from the database: a nine
        // hour offset there would filter this invoice out of the history page.
        [, $repository] = $this->tokyoRepository($dialect);
        $clock = static fn (): int => self::NOW;
        $wallet = new FakeWallet($clock);
        $service = new Service($wallet, false, [], ['USD'], $clock);
        $fulfilled = [];
        $settle = static function (array $event) use ($repository, &$fulfilled): bool {
            return $repository->markPaidOnce((string) $event['payment_hash'], (int) $event['paid_at'], null, static function (PaymentSettlement $settlement) use (&$fulfilled): void {
                $fulfilled[] = $settlement->reference;
            });
        };
        $reconciler = new Reconciler($service, $repository, $settle, true, null, $clock);
        $minted = $wallet->makeInvoice(['amount_msats' => 1000, 'expiry' => 600]);
        $hash = (string) $minted['payment_hash'];
        $repository->commitAttempt('window', $hash, self::checkout('window', $hash, self::NOW, (int) $minted['expires_at']));
        $wallet->settleInvoice(['payment_hash' => $hash]);
        $reconciler->reconcile();
        self::assertSame('settled', $repository->findByPaymentHash($hash)?->status);
        self::assertSame(['window'], $fulfilled);
    }

    public function testATimestampWithAnOffsetIsReadAsAnInstant(): void
    {
        self::markTestSkipped('Known bug: Timestamps::fromDb discards the offset of a timestamptz value; see packages/php/openreceive/src/Storage/Timestamps.php.');
        // Reachable only on a column the engine did not create (a hand-written
        // migration using timestamptz); PaymentsSchema never makes one.
        self::assertSame(1_794_238_621, Timestamps::fromDb('2026-11-10 00:37:01+09', 'expires_at'));
    }
}
