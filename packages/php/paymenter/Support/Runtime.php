<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use App\Models\Currency;
use App\Models\Gateway;
use App\Models\Invoice;
use Illuminate\Console\Application as Artisan;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Database\Migrations\Migrator;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\View;
use OpenReceive\Nwc\Errors;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\SqlPaymentRepository;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Commands\ConfigureCommand;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Commands\DoctorCommand;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Commands\ReconcileCommand;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Commands\TestInvoiceCommand;

/**
 * Everything the extension wires into Paymenter: the routes, the checkout
 * view, the artisan commands, the reconcile pass on Paymenter's scheduler,
 * the engine's tables and the engine itself.
 */
final class Runtime
{
    public const VERSION = '0.4.29';

    /** The extension's class and folder name, and the `extension` column of its gateway row. */
    public const EXTENSION = 'OpenReceive';

    /** Where the payment routes mount, relative to Paymenter's root URL. */
    public const PREFIX = 'extensions/openreceive';

    public const ASSET_PREFIX = 'extensions/openreceive-assets';

    /** Gateway settings that hold a code. Paymenter stores them encrypted. */
    public const SECRET_KEYS = ['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY'];

    public const DEFAULT_NAME = 'Bitcoin Lightning';

    public const SWAP_NAME = 'Bitcoin & stablecoins';

    private static bool $booted = false;

    private static ?Engine $engine = null;

    public static function boot(): void
    {
        if (self::$booted) {
            return;
        }
        self::$booted = true;
        require dirname(__DIR__) . '/routes.php';
        View::addNamespace('gateways.openreceive', dirname(__DIR__) . '/resources/views');
        if (!app()->runningInConsole()) {
            return;
        }
        Artisan::starting(static function (Artisan $artisan): void {
            $artisan->resolveCommands([ConfigureCommand::class, DoctorCommand::class, ReconcileCommand::class, TestInvoiceCommand::class]);
        });
        // Settlement is found on the checkout's own requests. This pass also
        // finds a payment whose buyer closed the page before it settled.
        app()->booted(static function (): void {
            app(Schedule::class)->command(ReconcileCommand::NAME)
                ->description('Records OpenReceive payments whose buyer left the page')
                ->everyMinute()->withoutOverlapping()->onOneServer();
        });
    }

    public static function gateway(): ?Gateway
    {
        return Gateway::where('extension', self::EXTENSION)->with('settings')->orderBy('id')->first();
    }

    /**
     * The gateway row, created when missing. Paymenter boots an extension
     * (its routes, its artisan commands) only while a gateway of it exists.
     * Until a wallet code is saved, checkout does not offer it.
     */
    public static function ensureGateway(): Gateway
    {
        return self::gateway() ?? Gateway::create(['name' => self::DEFAULT_NAME, 'extension' => self::EXTENSION, 'type' => 'gateway', 'enabled' => true]);
    }

    /**
     * The engine's environment: the process environment for OpenReceive's
     * optional knobs, with the codes only from the gateway's settings, which
     * Paymenter decrypts as it reads them.
     *
     * @return array<string, mixed>
     */
    public static function environment(?Gateway $gateway = null): array
    {
        $env = Service::processEnvironment();
        $settings = ($gateway ?? self::gateway())?->settings->pluck('value', 'key')->all() ?? [];
        foreach (self::SECRET_KEYS as $key => $name) {
            $env[$name] = trim((string) ($settings[$key] ?? ''));
        }
        unset($env['LSC_URI_BACKUP']);
        return $env;
    }

    /** @return list<string> */
    public static function currencies(): array
    {
        $codes = Currency::query()->pluck('code')->map(static fn (mixed $code): string => strtoupper((string) $code))->values()->all();
        return $codes === [] ? ['USD'] : $codes;
    }

    /**
     * PHP builds the service on every request. Paymenter's cache keeps the
     * wallet's info event, the BTC price and the swap provider's catalog
     * between requests, so a checkout route does not fetch them each time.
     */
    public static function service(?Gateway $gateway = null): Service
    {
        return Service::fromEnvironment(self::environment($gateway), self::currencies(), logger: new LaravelLogger(), sharedCache: new LaravelCache(Cache::store()));
    }

    public static function repository(): SqlPaymentRepository
    {
        $repository = new SqlPaymentRepository(new LaravelConnection(DB::connection()));
        if ($repository->meta()->storedSchemaVersion() !== PaymentsSchema::SCHEMA_VERSION) {
            throw new \RuntimeException('The OpenReceive tables are missing. Run php artisan openreceive:configure, or save the gateway again in the admin area.');
        }
        return $repository;
    }

    public static function engine(): Engine
    {
        return self::$engine ??= new Engine(
            new Host(),
            self::repository(),
            self::service(),
            clientIp: static fn (mixed $request): ?string => $request instanceof Request ? $request->ip() : Engine::defaultClientIp($request),
            logger: new LaravelLogger(),
            prefix: '/' . self::PREFIX,
        );
    }

    /** One gated reconcile pass; nothing to do before a wallet code is saved. */
    public static function reconcile(): void
    {
        if (self::environment()['NWC_URI'] === '') {
            return;
        }
        self::engine()->maybeReconcile();
    }

    /** Creates the engine's two tables in Paymenter's database. Safe to repeat. */
    public static function migrate(): void
    {
        app(Migrator::class)->run([dirname(__DIR__) . '/database/migrations']);
    }

    /**
     * After the admin creates or saves the gateway: make sure the tables
     * exist, and store the codes encrypted. Paymenter encrypts a setting only
     * when the edit page saves it, so a newly created gateway's codes would
     * otherwise sit in the database in plain text.
     */
    public static function afterSave(Gateway $gateway): void
    {
        self::migrate();
        foreach ($gateway->settings()->whereIn('key', array_keys(self::SECRET_KEYS))->get() as $setting) {
            if (!$setting->encrypted && is_string($setting->value) && $setting->value !== '') {
                $setting->encrypted = true;
                $setting->save();
            }
        }
    }

    /**
     * The checkout for the invoice's payment dialog. Its URLs are paths on
     * the page's own origin, so a Paymenter reached under another host name
     * than its saved app URL still loads the script and reaches the routes.
     */
    public static function checkoutView(Invoice $invoice): \Illuminate\Contracts\View\View
    {
        $asset = static fn (string $file): string => route('extensions.gateways.openreceive.asset', ['file' => $file], false) . '?v=' . self::VERSION;
        return view('gateways.openreceive::pay', [
            'invoice' => $invoice,
            'prefix' => rtrim((string) parse_url(url(self::PREFIX), PHP_URL_PATH), '/'),
            'script' => $asset('openreceive-checkout.js'),
            'style' => $asset('openreceive-checkout.css'),
            'returnUrl' => route('invoices.show', $invoice, false) . '?checkPayment=true',
        ]);
    }

    /** An error's message with every saved code removed, safe for a log line or a terminal. */
    public static function errorMessage(\Throwable $error): string
    {
        $message = $error->getMessage();
        try {
            foreach (self::SECRET_KEYS as $name) {
                $value = self::environment()[$name] ?? '';
                if (is_string($value) && strlen($value) > 4) {
                    $message = str_replace($value, '[REDACTED]', $message);
                }
            }
        } catch (\Throwable) {
            // A database or decryption failure has no code in its text.
        }
        return Errors::redactErrorText($message);
    }
}
