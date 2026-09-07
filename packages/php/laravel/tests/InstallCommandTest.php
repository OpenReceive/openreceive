<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Filesystem\Filesystem;
use OpenReceive\Host;
use OpenReceive\Laravel\Console\InstallCommand;

final class InstallCommandTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        parent::setUp();
        $this->root = sys_get_temp_dir() . '/openreceive-laravel-install-' . bin2hex(random_bytes(4));
        mkdir($this->root);
        $this->app->useAppPath($this->root . '/app');
        $this->app->useConfigPath($this->root . '/config');
        $this->app->useDatabasePath($this->root . '/database');
    }

    protected function tearDown(): void
    {
        (new Filesystem())->deleteDirectory($this->root);
        parent::tearDown();
    }

    public function testItWritesTheConfigTheHostAndOneMigration(): void
    {
        $this->artisan('openreceive:install')
            ->expectsOutputToContain('config/openreceive.php')
            ->expectsOutputToContain('app/OpenReceive/Host.php')
            ->expectsOutputToContain('_create_openreceive_tables.php')
            ->expectsOutputToContain('php artisan migrate')
            ->assertSuccessful();

        self::assertFileEquals(__DIR__ . '/../config/openreceive.php', $this->root . '/config/openreceive.php');

        $host = (string) file_get_contents($this->root . '/app/OpenReceive/Host.php');
        self::assertStringContainsString('namespace App\\OpenReceive;', $host);
        self::assertStringContainsString('use AllowAllAuthorize;', $host);
        self::assertStringContainsString('use LoggingOnPaid;', $host);
        // The generated fulfillment note rides along as comments, table name filled in.
        self::assertStringContainsString('WHAT OPENRECEIVE GUARANTEES', $host);
        self::assertStringContainsString('`openreceive_payments` rows', $host);
        self::assertStringNotContainsString('{{', $host);
        // The idempotent-transition example, and the row-lock alternative.
        self::assertStringContainsString("Order::where('id', \$settlement->reference)", $host);
        self::assertStringContainsString("->where('state', 'awaiting_payment')", $host);
        self::assertStringContainsString('Order::lockForUpdate()', $host);

        // The scaffold is valid PHP that implements the contract.
        require $this->root . '/app/OpenReceive/Host.php';
        self::assertTrue(class_exists(\App\OpenReceive\Host::class));
        self::assertInstanceOf(Host::class, new \App\OpenReceive\Host());

        $migrations = glob($this->root . '/database/migrations/*_create_openreceive_tables.php') ?: [];
        self::assertCount(1, $migrations);
        $migration = (string) file_get_contents($migrations[0]);
        self::assertStringContainsString('PaymentsSchema::statements(', $migration);
        self::assertStringContainsString('PaymentsSchema::dropStatements()', $migration);
        self::assertStringContainsString("config('openreceive.connection')", $migration);
        self::assertSame(InstallCommand::renderMigration(), $migration);
    }

    public function testASecondRunLeavesExistingFilesAlone(): void
    {
        $this->artisan('openreceive:install')->assertSuccessful();
        file_put_contents($this->root . '/app/OpenReceive/Host.php', '<?php // edited');
        $this->artisan('openreceive:install')
            ->expectsOutputToContain('exists')
            ->assertSuccessful();
        self::assertSame('<?php // edited', file_get_contents($this->root . '/app/OpenReceive/Host.php'));
        self::assertCount(1, glob($this->root . '/database/migrations/*_create_openreceive_tables.php') ?: []);
    }
}
