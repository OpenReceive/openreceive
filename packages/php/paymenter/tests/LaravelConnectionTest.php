<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Tests;

use Illuminate\Database\Capsule\Manager as Capsule;
use Illuminate\Database\Connection;
use Illuminate\Database\DatabaseTransactionsManager;
use Illuminate\Database\Schema\Blueprint;
use OpenReceive\PaymentSettlement;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;
use Paymenter\Extensions\Gateways\OpenReceive\Support\LaravelConnection;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The extension's one design claim: the engine's settlement transaction runs
 * through Laravel's transaction manager, so Paymenter's addPayment (its own
 * DB::transaction, then DB::afterCommit for the invoice's Paid event) nests
 * inside it. The payment row and the invoice's payment commit together, and
 * the Paid work runs only after that commit, never after a rollback.
 *
 * Runs on SQLite always, and on MySQL when OPENRECEIVE_TEST_MYSQL_DSN is set,
 * as in CI's php-engine job.
 */
final class LaravelConnectionTest extends TestCase
{
    /** @return iterable<string, array{0: string}> */
    public static function drivers(): iterable
    {
        yield 'sqlite' => ['sqlite'];
        if (getenv('OPENRECEIVE_TEST_MYSQL_DSN') !== false) {
            yield 'mysql' => ['mysql'];
        }
    }

    /** The paid-work log a test reads, as Paymenter's Paid listeners would act. */
    private array $paid = [];

    private static function connect(string $driver): Connection
    {
        $capsule = new Capsule();
        if ($driver === 'sqlite') {
            $capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:']);
        } else {
            $dsn = (string) getenv('OPENRECEIVE_TEST_MYSQL_DSN');
            preg_match_all('/(\w+)=([^;]+)/', substr($dsn, strlen('mysql:')), $parts, PREG_SET_ORDER);
            $options = array_column($parts, 2, 1);
            $capsule->addConnection([
                'driver' => 'mysql',
                'host' => $options['host'] ?? '127.0.0.1',
                'port' => $options['port'] ?? '3306',
                'database' => $options['dbname'] ?? 'openreceive_test',
                'username' => (string) getenv('OPENRECEIVE_TEST_MYSQL_USER'),
                'password' => (string) getenv('OPENRECEIVE_TEST_MYSQL_PASSWORD'),
            ]);
        }
        $connection = $capsule->getConnection();
        // A Laravel application gives every connection this manager; it is
        // where DB::afterCommit work waits for the outermost commit.
        $connection->setTransactionManager(new DatabaseTransactionsManager());
        return $connection;
    }

    /** The engine's tables and a stand-in for Paymenter's invoice_transactions, empty. */
    private static function fresh(Connection $db): SqlPaymentRepository
    {
        $engine = new LaravelConnection($db);
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $engine->execute($statement);
        }
        PaymentsSchema::migrate($engine);
        $db->getSchemaBuilder()->dropIfExists('invoice_transactions');
        $db->getSchemaBuilder()->create('invoice_transactions', static function (Blueprint $table): void {
            $table->id();
            $table->string('invoice_id');
            $table->string('transaction_id')->unique();
            $table->string('amount');
        });
        return new SqlPaymentRepository($engine);
    }

    private static function hash(string $seed): string
    {
        return hash('sha256', $seed);
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

    /** What Paymenter's ExtensionHelper::addPayment does: its own transaction, then work after the commit. */
    private function addPayment(Connection $db, PaymentSettlement $settlement): void
    {
        $db->transaction(function () use ($db, $settlement): void {
            $db->table('invoice_transactions')->insert([
                'invoice_id' => $settlement->reference,
                'transaction_id' => $settlement->paymentHash,
                'amount' => '12.50',
            ]);
            $db->afterCommit(function () use ($settlement): void {
                $this->paid[] = $settlement->reference;
            });
        });
    }

    #[DataProvider('drivers')]
    public function testTheDialectFollowsLaravelsDriverName(string $driver): void
    {
        $this->assertSame($driver, (new LaravelConnection(self::connect($driver)))->dialect());
    }

    #[DataProvider('drivers')]
    public function testThePaymentAndTheInvoicesPaymentCommitTogetherAndPaidWorkWaitsForTheCommit(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = self::hash('together');
        self::commit($repository, '7', $hash);

        $seenInside = null;
        $settled = $repository->markPaidOnce($hash, 1_100, null, function (PaymentSettlement $settlement) use ($db, &$seenInside): void {
            $this->addPayment($db, $settlement);
            $seenInside = $this->paid;
        });

        $this->assertTrue($settled);
        $this->assertSame([], $seenInside, 'Paid work ran inside the settlement transaction');
        $this->assertSame(['7'], $this->paid);
        $this->assertSame('settled', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(1, $db->table('invoice_transactions')->where('transaction_id', $hash)->count());
        // Settlement is write-once: a second pass neither fulfills nor queues work again.
        $this->assertFalse($repository->markPaidOnce($hash, 1_200, null, fn () => $this->fail('fulfilled twice')));
        $this->assertSame(['7'], $this->paid);
    }

    #[DataProvider('drivers')]
    public function testAFailedFulfillmentRollsBothBackRunsNoPaidWorkAndTheNextPassSettles(string $driver): void
    {
        $db = self::connect($driver);
        $repository = self::fresh($db);
        $hash = self::hash('rollback');
        self::commit($repository, '8', $hash);

        try {
            $repository->markPaidOnce($hash, 1_100, null, function (PaymentSettlement $settlement) use ($db): void {
                $this->addPayment($db, $settlement);
                throw new \RuntimeException('Paymenter failed after recording the payment');
            });
            $this->fail('the fulfillment failure did not reach the caller');
        } catch (\RuntimeException $error) {
            $this->assertSame('Paymenter failed after recording the payment', $error->getMessage());
        }

        $this->assertSame([], $this->paid);
        $this->assertSame('pending', $repository->findByPaymentHash($hash)?->status);
        $this->assertSame(0, $db->table('invoice_transactions')->count());
        $this->assertSame(0, $db->transactionLevel());

        $this->assertTrue($repository->markPaidOnce($hash, 1_200, null, fn (PaymentSettlement $settlement) => $this->addPayment($db, $settlement)));
        $this->assertSame(['8'], $this->paid);
        $this->assertSame(1, $db->table('invoice_transactions')->count());
    }

    #[DataProvider('drivers')]
    public function testQueriesReturnRowsAsArraysAndStatementsTheirRowCount(string $driver): void
    {
        $db = self::connect($driver);
        self::fresh($db);
        $engine = new LaravelConnection($db);
        $this->assertSame(0, $engine->execute('UPDATE openreceive_meta SET rev = rev WHERE 1 = 0'));
        $rows = $engine->query('SELECT value FROM openreceive_meta WHERE ' . ($engine->dialect() === 'mysql' ? '`key`' : 'key') . ' = ?', ['schema_version']);
        $this->assertSame([['value' => (string) PaymentsSchema::SCHEMA_VERSION]], array_map(static fn (array $row): array => ['value' => (string) $row['value']], $rows));
    }
}
