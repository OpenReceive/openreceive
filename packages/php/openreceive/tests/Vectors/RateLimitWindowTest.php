<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Storage\Timestamps;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * The per-IP budget windows on the immutable `inserted_at` stamp, never on the
 * wallet-reported created_at or the moving updated_at: each vector case is
 * inserted as a row with those three stamps and counted through the
 * production countAttemptsFromIp query.
 */
final class RateLimitWindowTest extends TestCase
{
    use VectorSupport;

    public function testTheBudgetCountsOnTheDecidedColumn(): void
    {
        $family = self::vector('rate-limit-window');
        self::assertSame('inserted_at', $family['column']);
        self::assertSame(['client_ip', 'inserted_at'], $family['index']);
        self::assertStringContainsString('(client_ip, inserted_at)', implode("\n", PaymentsSchema::statements('sqlite')));
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($db);
        $repo = new SqlPaymentRepository($db);
        foreach ($family['cases'] as $index => $case) {
            $ip = "10.0.0.{$index}";
            $attempt = $case['attempt'];
            $db->execute(
                'INSERT INTO openreceive_payments (reference, payment_hash, status, expires_at, checkout_data, client_ip, inserted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                ["ref-{$index}", str_pad((string) $index, 64, '0', STR_PAD_LEFT), 'pending', Timestamps::toDb(99_999), '{}', $ip,
                    Timestamps::toDb($attempt['inserted_at']), Timestamps::toDb($attempt['created_at']), Timestamps::toDb($attempt['updated_at'])]
            );
            $counted = $repo->countAttemptsFromIp($ip, $case['now'] - $case['window_seconds']) === 1;
            self::assertSame($case['expected']['counted'], $counted, $case['name']);
        }
    }
}
