<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Tests;

use OpenReceive\PaymentSettlement;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use PrestaShop\Module\OpenReceive\Completion;

/**
 * The module's design claims. The engine's settlement transaction runs on
 * PrestaShop's own PDO link (Db::getInstance()->getLink()), so the order
 * payment PrestaShop writes inside onPaid, through that link as its Db class
 * does, commits with the payment row or rolls back with it. And a settled
 * payment whose order still waits in the module's state is found again by
 * the repair query, until the order moves on.
 *
 * Runs on SQLite always, and on MySQL when OPENRECEIVE_TEST_MYSQL_DSN is set,
 * as in CI's php-engine job.
 */
final class SharedConnectionTest extends TestCase
{
    private const PREFIX = 'ps_';

    private const AWAITING = 31;

    private const PAID = 2;

    /** @return iterable<string, array{0: string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            yield 'mysql' => ['mysql'];
        }
    }

    /** A link like PrestaShop's DbPDO makes: exceptions on (pdo_mysql buffers queries by default, as DbPDO asks). */
    private static function connect(string $driver): \PDO
    {
        if ($driver === 'sqlite') {
            return new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        }
        return new \PDO((string) getenv('OPENRECEIVE_TEST_MYSQL_DSN'), (string) getenv('OPENRECEIVE_TEST_MYSQL_USER'), (string) getenv('OPENRECEIVE_TEST_MYSQL_PASSWORD'), [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);
    }

    /** The engine's tables with PrestaShop's prefix, and stand-ins for its orders and order payments, empty. */
    private static function fresh(\PDO $pdo): SqlPaymentRepository
    {
        $engine = new PdoConnection($pdo);
        $table = self::PREFIX . PaymentsSchema::DEFAULT_TABLE;
        $meta = self::PREFIX . PaymentsSchema::DEFAULT_META_TABLE;
        foreach (PaymentsSchema::dropStatements($table, $meta) as $statement) {
            $engine->execute($statement);
        }
        PaymentsSchema::migrate($engine, $table, $meta);
        foreach (['orders', 'order_payment'] as $name) {
            $pdo->exec('DROP TABLE IF EXISTS ' . self::PREFIX . $name);
        }
        $pdo->exec('CREATE TABLE ' . self::PREFIX . 'orders (id_order INTEGER NOT NULL PRIMARY KEY, reference VARCHAR(9) NOT NULL, id_cart INTEGER NOT NULL, current_state INTEGER NOT NULL, module VARCHAR(255) NOT NULL)');
        $pdo->exec('CREATE TABLE ' . self::PREFIX . 'order_payment (order_reference VARCHAR(9) NOT NULL, transaction_id VARCHAR(254) NOT NULL, amount DECIMAL(20,6) NOT NULL)');
        return new SqlPaymentRepository($engine, null, $table, $meta);
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

    /** What Host::onPaid makes PrestaShop do: Order::addOrderPayment's insert, a plain query on the link. */
    private static function record(\PDO $pdo, PaymentSettlement $settlement): void
    {
        $pdo->query("INSERT INTO " . self::PREFIX . "order_payment (order_reference, transaction_id, amount) VALUES ('XKBKNABJK', '" . $settlement->paymentHash . "', 12.5)");
    }

    private static function rows(\PDO $pdo, string $table): int
    {
        return (int) $pdo->query('SELECT COUNT(*) FROM ' . self::PREFIX . $table)->fetchColumn();
    }

    private static function order(\PDO $pdo, int $id, string $reference, int $cart, int $state, string $module = 'openreceive'): void
    {
        $statement = $pdo->prepare('INSERT INTO ' . self::PREFIX . 'orders (id_order, reference, id_cart, current_state, module) VALUES (?, ?, ?, ?, ?)');
        $statement->execute([$id, $reference, $cart, $state, $module]);
    }

    #[DataProvider('drivers')]
    public function testThePaymentAndPrestaShopsOrderPaymentCommitTogether(string $driver): void
    {
        $pdo = self::connect($driver);
        $repository = self::fresh($pdo);
        $hash = hash('sha256', 'together');
        self::commit($repository, '7', $hash);

        $settled = $repository->markPaidOnce($hash, 1_100, null, static fn (PaymentSettlement $settlement) => self::record($pdo, $settlement));

        $this->assertTrue($settled);
        $this->assertFalse($pdo->inTransaction());
        $this->assertSame('settled', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(1, self::rows($pdo, 'order_payment'));
        // Settlement is write-once: a second pass never records the payment again.
        $this->assertFalse($repository->markPaidOnce($hash, 1_200, null, fn () => $this->fail('fulfilled twice')));
        $this->assertSame(1, self::rows($pdo, 'order_payment'));
    }

    #[DataProvider('drivers')]
    public function testAFailedFulfillmentRollsBothBackAndTheNextPassSettles(string $driver): void
    {
        $pdo = self::connect($driver);
        $repository = self::fresh($pdo);
        $hash = hash('sha256', 'rollback');
        self::commit($repository, '8', $hash);

        try {
            $repository->markPaidOnce($hash, 1_100, null, static function (PaymentSettlement $settlement) use ($pdo): void {
                self::record($pdo, $settlement);
                throw new \RuntimeException('PrestaShop failed after recording the payment');
            });
            $this->fail('the fulfillment failure did not reach the caller');
        } catch (\RuntimeException $error) {
            $this->assertSame('PrestaShop failed after recording the payment', $error->getMessage());
        }

        $this->assertSame('pending', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(0, self::rows($pdo, 'order_payment'));
        $this->assertFalse($pdo->inTransaction());

        $this->assertTrue($repository->markPaidOnce($hash, 1_200, null, static fn (PaymentSettlement $settlement) => self::record($pdo, $settlement)));
        $this->assertSame(1, self::rows($pdo, 'order_payment'));
    }

    /**
     * Repair finds a settled payment while an order of its cart still waits:
     * the first order itself, or the second of a cart PrestaShop split. It
     * leaves alone what is unsettled, already paid, moved on by someone, or
     * another module's.
     */
    #[DataProvider('drivers')]
    public function testRepairFindsSettledPaymentsWhoseOrdersStillWait(string $driver): void
    {
        $pdo = self::connect($driver);
        $repository = self::fresh($pdo);
        $engine = new PdoConnection($pdo);
        $settle = static function (string $reference, string $seed) use ($repository): void {
            $hash = hash('sha256', $seed);
            self::commit($repository, $reference, $hash);
            $repository->markPaidOnce($hash, 1_100, null, static function (): void {
            });
        };

        self::order($pdo, 10, 'AAAAAAAAA', 100, self::AWAITING);
        $settle('10', 'waiting');
        self::order($pdo, 11, 'BBBBBBBBB', 101, self::PAID);
        $settle('11', 'paid');
        self::order($pdo, 12, 'CCCCCCCCC', 102, self::AWAITING);
        self::commit($repository, '12', hash('sha256', 'unpaid'));
        self::order($pdo, 13, 'DDDDDDDDD', 103, 6);
        $settle('13', 'cancelled first');
        self::order($pdo, 14, 'EEEEEEEEE', 104, self::PAID);
        self::order($pdo, 15, 'EEEEEEEEE', 104, self::AWAITING);
        $settle('14', 'split');
        self::order($pdo, 16, 'FFFFFFFFF', 105, self::AWAITING, 'ps_wirepayment');
        $settle('16', 'other module');

        $this->assertSame(['10', '14'], Completion::pending($engine, self::PREFIX, self::AWAITING));
    }
}
