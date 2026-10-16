<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support\Commands;

use App\Models\Setting;
use Illuminate\Console\Command;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Support\Facades\Route;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Swap\SwapProvider;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

/**
 * `php artisan openreceive:doctor` — the install state in one command: the
 * gateway, the PHP requirements, each code as set or unset (never its
 * value), the tables, the routes, the wallet, the price feed, each swap
 * provider and the scheduled reconcile pass. Exits 1 when a check fails.
 */
final class DoctorCommand extends Command
{
    protected $signature = 'openreceive:doctor';

    protected $description = 'Check OpenReceive\'s install: gateway, codes (set or unset only), tables, routes, wallet, prices, swaps, schedule';

    /** @var list<string> */
    private array $lines = [];

    private bool $ok = true;

    public function handle(): int
    {
        $gateway = null;
        $this->check('Paymenter gateway', static function () use (&$gateway): string {
            $gateway = Runtime::gateway();
            if ($gateway === null) {
                throw new \RuntimeException('none. Run php artisan app:extension:install gateway OpenReceive');
            }
            return "\"{$gateway->name}\" (id {$gateway->id})";
        });
        $this->check('Requirements', static function (): string {
            $missing = array_keys(array_filter(['64-bit PHP' => PHP_INT_SIZE < 8, 'gmp' => !extension_loaded('gmp'), 'sodium' => !extension_loaded('sodium')]));
            if ($missing !== []) {
                throw new \RuntimeException('missing ' . implode(', ', $missing) . '. The web server\'s PHP and the command-line PHP both need them.');
            }
            return '64-bit PHP with GMP and sodium';
        });
        $this->check('Codes', function () use (&$gateway): string {
            $env = Runtime::environment($gateway);
            foreach (Runtime::SECRET_KEYS as $name) {
                $this->lines[] = '  ' . $name . ': ' . ($env[$name] === '' ? 'unset' : 'set');
            }
            if ($env['NWC_URI'] === '') {
                throw new \RuntimeException('NWC_URI is not set. Pipe the code in: php artisan openreceive:configure --nwc-uri=-');
            }
            return 'readable';
        });
        $this->check('Tables', function (): string {
            $repository = Runtime::repository();
            $attention = $repository->connection()->query('SELECT reference FROM ' . PaymentsSchema::DEFAULT_TABLE . ' WHERE status = ? ORDER BY id LIMIT 50', ['attention']);
            $this->lines[] = '  invoices needing attention (first 50): ' . (implode(', ', array_column($attention, 'reference')) ?: 'none');
            return 'schema ' . PaymentsSchema::SCHEMA_VERSION;
        });
        $this->check('Routes', static function (): string {
            if (!Route::has('extensions.gateways.openreceive.api')) {
                throw new \RuntimeException('not registered. Paymenter boots the extension only while its gateway exists.');
            }
            return '/' . Runtime::PREFIX;
        });
        $service = null;
        $this->check('Wallet preflight', static function () use (&$service, &$gateway): string {
            $service = Runtime::service($gateway);
            return 'passed (receive-only)';
        });
        if ($service instanceof Service) {
            $this->check('Price feed', static function () use ($service): string {
                $currencies = Runtime::currencies();
                $service->listRates(['currencies' => $currencies]);
                return 'available for ' . implode(', ', $currencies);
            });
            foreach ($service->swapProviders() as $provider) {
                $this->check('Swap provider ' . $provider->name(), static fn (): string => self::swapProviderStatus($provider));
            }
        } else {
            $this->lines[] = 'Price feed: not checked, because the wallet check failed';
        }
        $this->check('Reconcile', static function (): string {
            $scheduled = collect(app(Schedule::class)->events())->contains(static fn ($event): bool => str_contains((string) $event->command, ReconcileCommand::NAME));
            if (!$scheduled) {
                throw new \RuntimeException('not on Paymenter\'s schedule.');
            }
            $last = Setting::where('key', 'last_scheduler_run')->value('value');
            return 'every minute on Paymenter\'s scheduler (its last run: ' . ($last ?: 'never — is Paymenter\'s cron job running?') . ')';
        });

        foreach ($this->lines as $line) {
            $this->line($line);
        }
        $this->line($this->ok ? 'OpenReceive is ready.' : 'OpenReceive is not ready: fix each FAILED line above.');
        return $this->ok ? self::SUCCESS : self::FAILURE;
    }

    private function check(string $name, callable $probe): void
    {
        try {
            $this->lines[] = $name . ': ' . $probe();
        } catch (\Throwable $error) {
            $this->ok = false;
            $this->lines[] = $name . ': FAILED — ' . Runtime::errorMessage($error);
        }
    }

    /** A set code proves nothing about the provider, so ask it for the catalog checkout offers. */
    private static function swapProviderStatus(SwapProvider $provider): string
    {
        $catalog = $provider->payInAssetCatalog();
        $offered = array_filter($catalog, static fn (array $row): bool => ($row['available'] ?? true) !== false);
        if ($offered === []) {
            throw new \RuntimeException('answered with no available assets, so checkout offers no swaps through it.');
        }
        return sprintf('answered, %d of %d assets available', count($offered), count($catalog));
    }
}
