<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use PHPUnit\Framework\TestCase;

/**
 * Runs each storage test against sqlite in memory (always) and against real
 * pgsql / mysql servers when OPENRECEIVE_TEST_PGSQL_DSN / OPENRECEIVE_TEST_MYSQL_DSN
 * are set (optionally with _USER / _PASSWORD). Tables are dropped and
 * recreated per connection so the lock paths run against a clean ledger.
 */
abstract class DatabaseCase extends TestCase
{
    /** @return iterable<string, array{0: string}> */
    public static function dialects(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        if (getenv('OPENRECEIVE_TEST_PGSQL_DSN') !== false) {
            yield 'pgsql' => ['pgsql'];
        }
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            yield 'mysql' => ['mysql'];
        }
    }

    protected static function connect(string $dialect, ?string $sqlitePath = null): PdoConnection
    {
        if ($dialect === 'sqlite') {
            return new PdoConnection(new \PDO('sqlite:' . ($sqlitePath ?? ':memory:')));
        }
        $prefix = 'OPENRECEIVE_TEST_' . strtoupper($dialect);
        $dsn = getenv("{$prefix}_DSN");
        if ($dsn === false) {
            self::markTestSkipped("{$prefix}_DSN is not set");
        }
        $user = getenv("{$prefix}_USER");
        $password = getenv("{$prefix}_PASSWORD");
        return new PdoConnection(new \PDO($dsn, $user === false ? null : $user, $password === false ? null : $password));
    }

    protected static function freshDatabase(string $dialect, ?string $sqlitePath = null): PdoConnection
    {
        $db = self::connect($dialect, $sqlitePath);
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $db->execute($statement);
        }
        PaymentsSchema::migrate($db);
        return $db;
    }

    /** @return array<string, mixed> */
    protected static function checkout(string $reference, string $hash, int $createdAt = 1_000, int $expiresAt = 1_600): array
    {
        return [
            'reference' => $reference,
            'payment_hash' => $hash,
            'bolt11' => 'lnbc' . substr($hash, 0, 8),
            'amount_msats' => 1000,
            'created_at' => $createdAt,
            'expires_at' => $expiresAt,
            'fiat_quote' => null,
        ];
    }

    protected static function hash(string $seed): string
    {
        return str_pad(preg_replace('/[^0-9a-f]/', '', hash('sha256', $seed)) ?? '', 64, '0');
    }

    /** @return array<string, mixed> */
    protected static function swapData(string $asset, int $expiresAt = 1_900): array
    {
        return ['version' => 1, 'provider_order' => [
            'provider' => 'fixedfloat', 'provider_order_id' => 'o-' . $asset, 'provider_token' => 't', 'pay_in_asset' => $asset,
            'deposit_address' => 'addr', 'deposit_amount' => '1.05', 'expires_at' => $expiresAt, 'state' => 'awaiting_deposit',
        ]];
    }

    protected static function countRows(DatabaseConnection $db, string $sql, array $params = []): int
    {
        return (int) $db->query($sql, $params)[0]['n'];
    }
}
