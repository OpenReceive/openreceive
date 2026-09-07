<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Filesystem\Filesystem;
use Illuminate\Support\Facades\DB;
use OpenReceive\Laravel\Console\InstallCommand;
use OpenReceive\Storage\PaymentsSchema;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * The published migration through Laravel's own migrator: sqlite always, and
 * pgsql / mysql when OPENRECEIVE_TEST_PGSQL_DSN / OPENRECEIVE_TEST_MYSQL_DSN
 * (PDO DSNs, plus _USER / _PASSWORD) point at real servers — the same switches
 * the engine's storage tests use.
 */
final class MigrationTest extends TestCase
{
    private string $dir;

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

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir() . '/openreceive-laravel-migration-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        file_put_contents($this->dir . '/2026_01_01_000000_create_openreceive_tables.php', InstallCommand::renderMigration());
    }

    protected function tearDown(): void
    {
        (new Filesystem())->deleteDirectory($this->dir);
        parent::tearDown();
    }

    #[DataProvider('dialects')]
    public function testUpCreatesBothTablesAndDownDropsThem(string $dialect): void
    {
        $connection = $this->configureConnection($dialect);
        $this->app->make('config')->set('openreceive.connection', $connection);
        $db = DB::connection($connection);
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $db->statement($statement);
        }
        $db->statement('DROP TABLE IF EXISTS migrations');

        $this->artisan('migrate', ['--database' => $connection, '--path' => $this->dir, '--realpath' => true, '--force' => true])->assertSuccessful();

        self::assertTrue($db->getSchemaBuilder()->hasTable('openreceive_payments'));
        self::assertTrue($db->getSchemaBuilder()->hasTable('openreceive_meta'));
        $version = $db->table('openreceive_meta')->where('key', 'schema_version')->value('value');
        self::assertSame((string) PaymentsSchema::SCHEMA_VERSION, (string) $version);
        self::assertEqualsCanonicalizing(
            ['id', 'reference', 'payment_hash', 'status', 'status_reason', 'paid_at', 'expires_at', 'checkout_data', 'swap_data', 'client_ip', 'inserted_at', 'created_at', 'updated_at'],
            $db->getSchemaBuilder()->getColumnListing('openreceive_payments'),
        );

        // Idempotent: the DDL is IF NOT EXISTS, so a re-run of up() is harmless.
        $this->artisan('migrate:refresh', ['--database' => $connection, '--path' => $this->dir, '--realpath' => true, '--force' => true])->assertSuccessful();
        self::assertTrue($db->getSchemaBuilder()->hasTable('openreceive_payments'));

        $this->artisan('migrate:rollback', ['--database' => $connection, '--path' => $this->dir, '--realpath' => true, '--force' => true])->assertSuccessful();
        self::assertFalse($db->getSchemaBuilder()->hasTable('openreceive_payments'));
        self::assertFalse($db->getSchemaBuilder()->hasTable('openreceive_meta'));
    }

    /** Registers (and returns the name of) the connection for a dialect; sqlite is Testbench's in-memory one. */
    private function configureConnection(string $dialect): string
    {
        if ($dialect === 'sqlite') {
            return 'testing';
        }
        $prefix = 'OPENRECEIVE_TEST_' . strtoupper($dialect);
        $dsn = (string) getenv("{$prefix}_DSN");
        $options = [];
        foreach (explode(';', substr($dsn, strpos($dsn, ':') + 1)) as $pair) {
            [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
            $options[trim($key)] = trim($value);
        }
        $user = getenv("{$prefix}_USER");
        $password = getenv("{$prefix}_PASSWORD");
        $name = "openreceive_test_{$dialect}";
        $this->app->make('config')->set("database.connections.{$name}", [
            'driver' => $dialect,
            'host' => $options['host'] ?? '127.0.0.1',
            'port' => $options['port'] ?? ($dialect === 'pgsql' ? '5432' : '3306'),
            'database' => $options['dbname'] ?? '',
            'username' => $user === false ? null : $user,
            'password' => $password === false ? null : $password,
            'charset' => $dialect === 'pgsql' ? 'utf8' : 'utf8mb4',
            'prefix' => '',
            'prefix_indexes' => true,
        ]);
        return $name;
    }
}
