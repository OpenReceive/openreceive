<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Console;

use Illuminate\Console\Command;
use Illuminate\Filesystem\Filesystem;
use OpenReceive\Generated\FulfillmentNote;
use OpenReceive\Storage\PaymentsSchema;

/**
 * `php artisan openreceive:install` — the Rails install generator's twin. Writes
 * config/openreceive.php, app/OpenReceive/Host.php (three methods, the two
 * placeholders wired, the generated fulfillment note as comments) and one
 * migration for both engine tables. The host runs `php artisan migrate`
 * itself: the migration is the app's own workflow, never a second runner.
 */
final class InstallCommand extends Command
{
    protected $signature = 'openreceive:install {--force : Overwrite config/openreceive.php and app/OpenReceive/Host.php if they exist}';

    protected $description = 'Scaffold config/openreceive.php, app/OpenReceive/Host.php and the openreceive tables migration';

    public function handle(Filesystem $files): int
    {
        $force = (bool) $this->option('force');

        $configPath = $this->laravel->configPath('openreceive.php');
        $this->write($files, $configPath, (string) $files->get(__DIR__ . '/../../config/openreceive.php'), $force);

        $hostPath = rtrim((string) $this->laravel->make('path'), '/') . '/OpenReceive/Host.php';
        $this->write($files, $hostPath, self::renderHost($this->appNamespace()), $force);

        $existing = $files->glob($this->laravel->databasePath('migrations/*_create_openreceive_tables.php'));
        if ($existing !== [] && !$force) {
            $this->components->twoColumnDetail(str_replace($this->laravel->basePath() . '/', '', (string) $existing[0]), '<fg=yellow>exists</>');
        } else {
            $migrationPath = $this->laravel->databasePath('migrations/' . date('Y_m_d_His') . '_create_openreceive_tables.php');
            $this->write($files, $migrationPath, self::renderMigration(), true);
        }

        $this->newLine();
        $this->components->info('OpenReceive is scaffolded. Next:');
        $this->line('  1. php artisan migrate                     — creates openreceive_payments and openreceive_meta in your database');
        $this->line('  2. NWC_URI=<receive-only NWC code> in .env — https://openreceive.org/get_a_nwc_code_to_receive_payments');
        $this->line('  3. Fill in app/OpenReceive/Host.php        — authorize, amountFor, onPaid against YOUR order model');
        $this->line('  4. Render <openreceive-checkout reference="{{ $order->id }}"> — https://openreceive.org/guides/quickstart-laravel.md');
        $this->line('  php artisan openreceive:doctor reports every step as set/unset, and never prints a secret.');
        return self::SUCCESS;
    }

    /** The app's PSR-4 root from composer.json (`App` when the app path is not the composer-mapped one, as in tests). */
    private function appNamespace(): string
    {
        try {
            return rtrim($this->laravel->getNamespace(), '\\');
        } catch (\RuntimeException) {
            return 'App';
        }
    }

    /** The Host scaffold, from stubs/Host.php.stub. */
    public static function renderHost(string $appNamespace = 'App'): string
    {
        $stub = (string) file_get_contents(__DIR__ . '/../../stubs/Host.php.stub');
        $note = implode("\n", array_map(
            static fn (string $line): string => $line === '' ? ' *' : ' * ' . $line,
            array_map(static fn (string $line): string => str_replace('{{table}}', PaymentsSchema::DEFAULT_TABLE, $line), FulfillmentNote::TEMPLATE),
        ));
        return str_replace(['{{ namespace }}', '{{ fulfillment_note }}'], [$appNamespace . '\\OpenReceive', $note], $stub);
    }

    /** The migration, from database/migrations/create_openreceive_tables.php.stub. */
    public static function renderMigration(): string
    {
        return (string) file_get_contents(__DIR__ . '/../../database/migrations/create_openreceive_tables.php.stub');
    }

    private function write(Filesystem $files, string $path, string $contents, bool $force): void
    {
        $relative = str_replace($this->laravel->basePath() . '/', '', $path);
        if ($files->exists($path) && !$force) {
            $this->components->twoColumnDetail($relative, '<fg=yellow>exists</> (pass --force to overwrite)');
            return;
        }
        $files->ensureDirectoryExists(dirname($path));
        $files->put($path, $contents);
        $this->components->twoColumnDetail($relative, '<fg=green>written</>');
    }
}
