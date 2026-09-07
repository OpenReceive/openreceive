<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Console;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Route;
use OpenReceive\Host;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Server\Doctor;
use OpenReceive\Server\Service;

/**
 * `php artisan openreceive:doctor` — Step 0 of the agent directions in one
 * command: every credential as set/unset, the host class and which of its
 * hooks are still the generated placeholders, the route mount, and the
 * receive-only wallet preflight. PRESENCE ONLY: no value is ever printed.
 */
final class DoctorCommand extends Command
{
    protected $signature = 'openreceive:doctor {--no-wallet : Skip the wallet preflight (no network)}';

    protected $description = "Report OpenReceive's install state: credentials (set/unset only), host hooks, route mount, wallet preflight";

    public function handle(): int
    {
        $config = (array) $this->laravel->make('config')->get('openreceive');
        $env = OpenReceiveServiceProvider::engineEnvironment($config);

        $host = null;
        $hostClass = $config['host'] ?? null;
        if (is_string($hostClass) && class_exists($hostClass)) {
            try {
                $host = $this->laravel->make(Host::class);
            } catch (\Throwable) {
                $host = null;
            }
        }

        $mountedAt = Route::has(OpenReceiveServiceProvider::ROUTE_NAME)
            ? '/' . trim((string) ($config['route_prefix'] ?? 'openreceive'), '/')
            : null;
        $walletCheck = $this->option('no-wallet') ? null : function (): void {
            $this->laravel->make(Service::class);
        };

        $lines = Doctor::report($env, $host, $walletCheck, $mountedAt);
        if ($host === null) {
            $lines = array_map(
                static fn (string $line): string => str_starts_with($line, '  host:')
                    ? '  host:             NOT CONFIGURED — run `php artisan openreceive:install`, then point config/openreceive.php host at your class'
                    : $line,
                $lines,
            );
        }
        if ($mountedAt === null) {
            $lines = array_map(
                static fn (string $line): string => str_starts_with($line, '  engine mounted:')
                    ? '  engine mounted:   no — the OpenReceiveServiceProvider did not register its routes (is package discovery disabled?)'
                    : $line,
                $lines,
            );
        }
        foreach ($lines as $line) {
            $this->line($line);
        }
        return self::SUCCESS;
    }
}
