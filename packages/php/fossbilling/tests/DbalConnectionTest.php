<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Tests;

use Box\Mod\Openreceive\Support\DbalConnection;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use OpenReceive\PaymentSettlement;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The module's one design claim: the engine's settlement transaction runs on
 * FOSSBilling's shared DBAL connection, so FOSSBilling's writes inside onPaid
 * (a RedBeanPHP store of the transaction log row, a Doctrine flush of the
 * client's balance, which opens its own nested transaction) commit with the
 * payment row, or roll back with it.
 *
 * Runs on SQLite always, and on MySQL when OPENRECEIVE_TEST_MYSQL_DSN is set,
 * as in CI's php-engine job.
 */
final class DbalConnectionTest extends TestCase
{
    /** @return iterable<string, array{0: string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            yield 'mysql' => ['mysql'];
        }
    }

    private static function connect(string $driver): Connection
    {
        if ($driver === 'sqlite') {
            return DriverManager::getConnection(['driver' => 'pdo_sqlite', 'memory' => true]);
        }
        $dsn = (string) getenv('OPENRECEIVE_TEST_MYSQL_DSN');
        preg_match_all('/(\w+)=([^;]+)/', substr($dsn, strlen('mysql:')), $parts, PREG_SET_ORDER);
        $options = array_column($parts, 2, 1);
        return DriverManager::getConnection([
            'driver' => 'pdo_mysql',
            'host' => $options['host'] ?? '127.0.0.1',
            'port' => (int) ($options['port'] ?? 3306),
            'dbname' => $options['dbname'] ?? 'openreceive_test',
            'user' => (string) getenv('OPENRECEIVE_TEST_MYSQL_USER'),
            'password' => (string) getenv('OPENRECEIVE_TEST_MYSQL_PASSWORD'),
        ]);
    }

    /** The engine's tables and stand-ins for FOSSBilling's transaction and client_balance tables, empty. */
    private static function fresh(Connection $db): SqlPaymentRepository
    {
        $engine = new DbalConnection($db);
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $engine->execute($statement);
        }
        PaymentsSchema::migrate($engine);
        foreach (['transaction', 'client_balance'] as $table) {
            $db->executeStatement('DROP TABLE IF EXISTS ' . $db->quoteSingleIdentifier($table));
        }
        $db->executeStatement('CREATE TABLE ' . $db->quoteSingleIdentifier('transaction') . ' (txn_id VARCHAR(64) NOT NULL, amount VARCHAR(32) NOT NULL)');
        $db->executeStatement('CREATE TABLE client_balance (rel_id VARCHAR(64) NOT NULL, amount VARCHAR(32) NOT NULL)');
        return new SqlPaymentRepository($engine);
    }

    private static function commit(SqlPaymentRepository $repository, string $reference, string $hash): void
    {
        $repository->commitAttempt($reference, $hash, [
            'reference' => $reference,
            'payment_hash' => $hash,
            'bolt11' => 'lnbc' . substr($hash, 0, 8),
            'amount_msats' => 1_000_000,
            'created_at' => 1_000,
            'expires_at' => 1_600,
            'fiat_quote' => null,
        ]);
    }

    /** What Host::onPaid does: a plain write on the connection, then a write in a nested transaction, as a Doctrine flush makes. */
    private static function record(Connection $db, PaymentSettlement $settlement): void
    {
        $db->executeStatement('INSERT INTO ' . $db->quoteSingleIdentifier('transaction') . ' (txn_id, amount) VALUES (?, ?)', [$settlement->paymentHash, '12.50']);
        $db->transactional(static fn (Connection $nested) => $nested->executeStatement('INSERT INTO client_balance (rel_id, amount) VALUES (?, ?)', [$settlement->paymentHash, '12.50']));
    }

    private static function rows(Connection $db, string $table): int
    {
        return (int) $db->fetchOne('SELECT COUNT(*) FROM ' . $db->quoteSingleIdentifier($table));
    }

    #[DataProvider('drivers')]
    public function testTheDialectFollowsTheDatabasePlatform(string $driver): void
    {
        $this->assertSame($driver, (new DbalConnection(self::connect($driver)))->dialect());
    }

    #[DataProvider('drivers')]
    public function testThePaymentAndFossbillingsRecordsCommitTogether(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = hash('sha256', 'together');
        self::commit($repository, '7', $hash);

        $depth = null;
        $settled = $repository->markPaidOnce($hash, 1_100, null, static function (PaymentSettlement $settlement) use ($db, &$depth): void {
            self::record($db, $settlement);
            $depth = $db->getTransactionNestingLevel();
        });

        $this->assertTrue($settled);
        $this->assertSame(1, $depth, 'onPaid ran outside the settlement transaction');
        $this->assertSame(0, $db->getTransactionNestingLevel());
        $this->assertSame('settled', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(1, self::rows($db, 'transaction'));
        $this->assertSame(1, self::rows($db, 'client_balance'));
        // Settlement is write-once: a second pass never records the payment again.
        $this->assertFalse($repository->markPaidOnce($hash, 1_200, null, fn () => $this->fail('fulfilled twice')));
        $this->assertSame(1, self::rows($db, 'client_balance'));
    }

    #[DataProvider('drivers')]
    public function testAFailedFulfillmentRollsBothBackAndTheNextPassSettles(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = hash('sha256', 'rollback');
        self::commit($repository, '8', $hash);

        try {
            $repository->markPaidOnce($hash, 1_100, null, static function (PaymentSettlement $settlement) use ($db): void {
                self::record($db, $settlement);
                throw new \RuntimeException('FOSSBilling failed after recording the payment');
            });
            $this->fail('the fulfillment failure did not reach the caller');
        } catch (\RuntimeException $error) {
            $this->assertSame('FOSSBilling failed after recording the payment', $error->getMessage());
        }

        $this->assertSame('pending', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(0, self::rows($db, 'transaction'));
        $this->assertSame(0, self::rows($db, 'client_balance'));
        $this->assertSame(0, $db->getTransactionNestingLevel());

        $this->assertTrue($repository->markPaidOnce($hash, 1_200, null, static fn (PaymentSettlement $settlement) => self::record($db, $settlement)));
        $this->assertSame(1, self::rows($db, 'client_balance'));
    }

    #[DataProvider('drivers')]
    public function testQueriesReturnRowsAsArraysAndStatementsTheirRowCount(string $driver): void
    {
        $db = self::connect($driver);
        self::fresh($db);
        $engine = new DbalConnection($db);
        $this->assertSame(0, $engine->execute('UPDATE openreceive_meta SET rev = rev WHERE 1 = 0'));
        $rows = $engine->query('SELECT value FROM openreceive_meta WHERE ' . ($engine->dialect() === 'mysql' ? '`key`' : 'key') . ' = ?', ['schema_version']);
        $this->assertSame([['value' => (string) PaymentsSchema::SCHEMA_VERSION]], array_map(static fn (array $row): array => ['value' => (string) $row['value']], $rows));
    }

    /** The engine's reconcile scan pages with LIMIT ?; MySQL refuses a LIMIT bound as a string. */
    #[DataProvider('drivers')]
    public function testIntegersBindAsIntegersSoALimitPlaceholderWorks(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        self::commit($repository, '9', hash('sha256', 'limit'));
        $engine = new DbalConnection($db);
        $rows = $engine->query('SELECT reference FROM openreceive_payments WHERE status = ? ORDER BY id LIMIT ?', ['pending', 200]);
        $this->assertSame([['reference' => '9']], $rows);
        // MySQL counts a row as affected only when a value changes.
        $this->assertSame(1, $engine->execute('UPDATE openreceive_payments SET client_ip = ?, status_reason = ? WHERE reference = ?', ['203.0.113.9', null, '9']));
    }
}
