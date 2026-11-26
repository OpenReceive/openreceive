<?php

declare(strict_types=1);

namespace OpenReceiveHikaShop\Tests;

use OpenReceive\PaymentSettlement;
use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceiveHikaShop\MysqliConnection;
use OpenReceiveHikaShop\PaymentHistory;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The plugin's design claims. The engine's settlement transaction runs on
 * the link of Joomla's own database driver (mysqli by default, PDO with the
 * pdomysql driver), so the history row the plugin writes on the order inside
 * onPaid commits with the payment row or rolls back with it, once per
 * payment. And a settled payment whose order HikaShop still counts as unpaid
 * is found again by the repair query, until the order moves on.
 *
 * Runs on SQLite always, and on MySQL through both mysqli and PDO when
 * OPENRECEIVE_TEST_MYSQL_DSN is set, as in CI's php-engine job.
 */
final class SharedConnectionTest extends TestCase
{
    private const PREFIX = 'jos_';

    /** @return iterable<string, array{0: string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            // CI's php-engine job loads mysqli for this suite; a local PHP may lack it.
            if (extension_loaded('mysqli')) {
                yield 'mysql (mysqli, Joomla\'s default driver)' => ['mysqli'];
            }
            yield 'mysql (PDO, Joomla\'s pdomysql driver)' => ['pdo_mysql'];
        }
    }

    private static function connect(string $driver): DatabaseConnection
    {
        if ($driver === 'sqlite') {
            return new PdoConnection(new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]));
        }
        $dsn = (string) getenv('OPENRECEIVE_TEST_MYSQL_DSN');
        $user = (string) getenv('OPENRECEIVE_TEST_MYSQL_USER');
        $password = (string) getenv('OPENRECEIVE_TEST_MYSQL_PASSWORD');
        if ($driver === 'pdo_mysql') {
            return new PdoConnection(new \PDO($dsn, $user, $password, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]));
        }
        $parts = [];
        foreach (explode(';', substr($dsn, strlen('mysql:'))) as $pair) {
            [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
            $parts[$key] = $value;
        }
        // Joomla's mysqli driver connects like this: one link, reports as exceptions.
        mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
        return new MysqliConnection(new \mysqli($parts['host'] ?? '127.0.0.1', $user, $password, $parts['dbname'] ?? '', (int) ($parts['port'] ?? 3306)));
    }

    /** The engine's tables with Joomla's prefix, and stand-ins for HikaShop's orders and order history, empty. */
    private static function fresh(DatabaseConnection $db): SqlPaymentRepository
    {
        $table = self::PREFIX . PaymentsSchema::DEFAULT_TABLE;
        $meta = self::PREFIX . PaymentsSchema::DEFAULT_META_TABLE;
        foreach (PaymentsSchema::dropStatements($table, $meta) as $statement) {
            $db->execute($statement);
        }
        PaymentsSchema::migrate($db, $table, $meta);
        foreach (['hikashop_order', 'hikashop_history'] as $name) {
            $db->execute('DROP TABLE IF EXISTS ' . self::PREFIX . $name);
        }
        $db->execute('CREATE TABLE ' . self::PREFIX . 'hikashop_order (order_id INTEGER NOT NULL PRIMARY KEY, order_status VARCHAR(255) NOT NULL, order_type VARCHAR(255) NOT NULL, order_payment_method VARCHAR(255) NOT NULL)');
        $db->execute('CREATE TABLE ' . self::PREFIX . 'hikashop_history (history_id INTEGER PRIMARY KEY ' . ($db->dialect() === 'sqlite' ? 'AUTOINCREMENT' : 'AUTO_INCREMENT')
            . ', history_order_id INTEGER NOT NULL, history_created INTEGER NOT NULL, history_ip VARCHAR(255) NOT NULL, history_new_status VARCHAR(255) NOT NULL,'
            . ' history_reason TEXT NOT NULL, history_notified INTEGER NOT NULL, history_amount VARCHAR(255) NOT NULL, history_package_id INTEGER NOT NULL,'
            . ' history_payment_id VARCHAR(255) NOT NULL, history_payment_method VARCHAR(255) NOT NULL, history_data TEXT NOT NULL, history_type VARCHAR(255) NOT NULL, history_user_id INTEGER)');
        return new SqlPaymentRepository($db, null, $table, $meta);
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

    private static function order(DatabaseConnection $db, int $id, string $status, string $method = 'openreceive', string $type = 'sale'): void
    {
        $db->execute('INSERT INTO ' . self::PREFIX . 'hikashop_order (order_id, order_status, order_type, order_payment_method) VALUES (?, ?, ?, ?)', [$id, $status, $type, $method]);
    }

    /** What Host::onPaid does inside the settlement transaction. */
    private static function record(DatabaseConnection $db, PaymentSettlement $settlement): void
    {
        PaymentHistory::record($settlement->connection ?? $db, self::PREFIX, (int) $settlement->reference, $settlement->paymentHash, '12.50 USD', $settlement->paidAt);
    }

    private static function historyRows(DatabaseConnection $db): int
    {
        return (int) $db->query('SELECT COUNT(*) AS n FROM ' . self::PREFIX . 'hikashop_history')[0]['n'];
    }

    #[DataProvider('drivers')]
    public function testThePaymentAndItsHistoryRowCommitTogetherOnce(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = hash('sha256', 'together');
        self::order($db, 7, 'created');
        self::commit($repository, '7', $hash);

        $this->assertTrue($repository->markPaidOnce($hash, 1_100, null, static fn (PaymentSettlement $settlement) => self::record($db, $settlement)));

        $this->assertSame('settled', $repository->findByPaymentHash($hash)?->status);
        $rows = $db->query('SELECT history_order_id, history_new_status, history_amount, history_payment_id, history_payment_method, history_type, history_created FROM ' . self::PREFIX . 'hikashop_history');
        $this->assertCount(1, $rows);
        $this->assertSame(['7', 'created', '12.50 USD', $hash, 'openreceive', 'payment', '1100'], array_map('strval', array_values($rows[0])));
        // Settlement is write-once: a second pass never records the payment again.
        $this->assertFalse($repository->markPaidOnce($hash, 1_200, null, fn () => $this->fail('fulfilled twice')));
        // And the history row itself is written once per payment hash.
        $this->assertFalse(PaymentHistory::record($db, self::PREFIX, 7, $hash, '12.50 USD', 1_300));
        $this->assertSame(1, self::historyRows($db));
    }

    #[DataProvider('drivers')]
    public function testAFailedFulfillmentRollsBothBackAndTheNextPassSettles(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = hash('sha256', 'rollback');
        self::order($db, 8, 'created');
        self::commit($repository, '8', $hash);

        try {
            $repository->markPaidOnce($hash, 1_100, null, static function (PaymentSettlement $settlement) use ($db): void {
                self::record($db, $settlement);
                throw new \RuntimeException('HikaShop failed after the history row');
            });
            $this->fail('the fulfillment failure did not reach the caller');
        } catch (\RuntimeException $error) {
            $this->assertSame('HikaShop failed after the history row', $error->getMessage());
        }

        $this->assertSame('pending', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(0, self::historyRows($db));

        $this->assertTrue($repository->markPaidOnce($hash, 1_200, null, static fn (PaymentSettlement $settlement) => self::record($db, $settlement)));
        $this->assertSame(1, self::historyRows($db));
    }

    #[DataProvider('drivers')]
    public function testAPaymentForAMissingOrderIsNotSettled(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = hash('sha256', 'missing');
        self::commit($repository, '99', $hash);

        try {
            $repository->markPaidOnce($hash, 1_100, null, static fn (PaymentSettlement $settlement) => self::record($db, $settlement));
            $this->fail('settled a payment whose order is missing');
        } catch (\RuntimeException $error) {
            $this->assertStringContainsString('Order 99 is missing', $error->getMessage());
        }
        $this->assertSame('pending', $repository->findByPaymentHash($hash)?->status);
    }

    /**
     * Repair finds a settled payment while HikaShop still counts its order as
     * unpaid. It leaves alone what is unsettled, already paid, moved on by
     * the merchant, or another payment method's.
     */
    #[DataProvider('drivers')]
    public function testRepairFindsSettledPaymentsWhoseOrdersAreStillUnpaid(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $settle = static function (string $reference, string $seed) use ($repository): void {
            $hash = hash('sha256', $seed);
            self::commit($repository, $reference, $hash);
            $repository->markPaidOnce($hash, 1_100, null, static function (): void {
            });
        };

        self::order($db, 9, 'created');
        $settle('9', 'waiting');
        self::order($db, 10, 'pending');
        $settle('10', 'waiting in another unpaid status');
        self::order($db, 11, 'confirmed');
        $settle('11', 'paid');
        self::order($db, 12, 'created');
        self::commit($repository, '12', hash('sha256', 'unpaid'));
        self::order($db, 13, 'cancelled');
        $settle('13', 'cancelled first');
        self::order($db, 14, 'created', 'banktransfer');
        $settle('14', 'other method');
        self::order($db, 15, 'created', 'openreceive', 'subsale');
        $settle('15', 'not a sale');

        $this->assertSame([9, 10], PaymentHistory::pending($db, self::PREFIX, ['created', 'pending']));
        $this->assertSame([9], PaymentHistory::pending($db, self::PREFIX, ['created']));
        $this->assertSame([], PaymentHistory::pending($db, self::PREFIX, []));
    }
}
