<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\ConfigurationError;
use OpenReceive\Storage\MetaStore;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\Attributes\DataProvider;

final class PaymentsSchemaTest extends DatabaseCase
{
    #[DataProvider('dialects')]
    public function testTheSchemaMigratesIdempotentlyAndStampsItsVersion(string $dialect): void
    {
        $db = self::freshDatabase($dialect);
        // A second run is a no-op: every statement is IF NOT EXISTS / insert-if-absent.
        PaymentsSchema::migrate($db);
        $meta = new MetaStore($db);
        self::assertSame(PaymentsSchema::SCHEMA_VERSION, $meta->storedSchemaVersion());
        $meta->assertSupportedSchema();
        self::assertSame(0, self::countRows($db, 'SELECT COUNT(*) AS n FROM openreceive_payments'));
    }

    #[DataProvider('dialects')]
    public function testTheCheckConstraintsBackstopTheEngineInvariants(string $dialect): void
    {
        $db = self::freshDatabase($dialect);
        $insert = "INSERT INTO openreceive_payments (reference, payment_hash, status, expires_at, checkout_data, inserted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        $stamp = '2026-01-01 00:00:00';
        $this->expectException(\PDOException::class);
        try {
            $db->execute($insert, ['r', str_repeat('a', 64), 'bogus', $stamp, '{}', $stamp, $stamp, $stamp]);
        } finally {
            try {
                $db->execute($insert, ['r', 'NOT-HEX', 'pending', $stamp, '{}', $stamp, $stamp, $stamp]);
                self::fail('the payment_hash check accepted a non-hex hash');
            } catch (\PDOException) {
                // expected
            }
        }
    }

    public function testAnUnmigratedDatabaseIsDiagnosedNotDumpedAsADriverError(): void
    {
        $db = new PdoConnection(new \PDO('sqlite::memory:'));
        $this->expectException(ConfigurationError::class);
        $this->expectExceptionMessage('have not been migrated');
        (new SqlPaymentRepository($db))->reconcilableAttempts();
    }

    public function testANewerStoredSchemaVersionIsRefused(): void
    {
        $db = self::freshDatabase('sqlite');
        $db->execute("UPDATE openreceive_meta SET value = ? WHERE key = 'schema_version'", [(string) (PaymentsSchema::SCHEMA_VERSION + 1)]);
        $this->expectException(ConfigurationError::class);
        $this->expectExceptionMessage('newer than this library');
        (new MetaStore($db))->assertSupportedSchema();
    }

    public function testAnUnknownDialectHasNoSchema(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        PaymentsSchema::statements('oracle');
    }

    public function testUnsafeIdentifiersAreRefused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        PaymentsSchema::statements('sqlite', 'payments; DROP TABLE x');
    }
}
