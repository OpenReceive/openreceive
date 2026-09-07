<?php

declare(strict_types=1);

namespace OpenReceive\Laravel;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use OpenReceive\ConfigurationError;
use OpenReceive\Host;
use OpenReceive\Http\HttpTransport;
use OpenReceive\Http\Psr18Transport;
use OpenReceive\Kernel;
use OpenReceive\Laravel\Console\DoctorCommand;
use OpenReceive\Laravel\Console\InstallCommand;
use OpenReceive\Laravel\Console\NotificationsCommand;
use OpenReceive\Laravel\Console\ReconcileCommand;
use OpenReceive\Laravel\Http\OpenReceiveController;
use OpenReceive\Laravel\Wallet\CachedWalletInfo;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Nwc\NwcUriParseError;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Rates\PriceProvider;
use OpenReceive\Server\Doctor;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Swap\SwapProvider;
use Psr\Log\LoggerInterface;

/**
 * The Laravel binding of the engine: config → Host (by class name), the
 * repository over the app's own database connection, the Service (wallet from
 * NWC_URI unless a client is bound), the routes under the configured prefix
 * and middleware, the artisan commands, and the boot-time checks Rails has —
 * placeholder warnings, and in production an eager wallet preflight.
 *
 * Container seams a host (or a test, or the demo's testkit mode) may bind
 * BEFORE the engine is first resolved:
 *   ReceiveNwcClient::class   the wallet client (replaces NWC_URI)
 *   PriceProvider::class      the fiat price source (StaticPriceProvider in tests)
 *   'openreceive.swap_providers'  list<SwapProvider> (replaces the LSC_URI_* auto-build; [] = none)
 */
final class OpenReceiveServiceProvider extends ServiceProvider
{
    public const SWAP_PROVIDERS = 'openreceive.swap_providers';
    public const ROUTE_NAME = 'openreceive.mount';

    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/openreceive.php', 'openreceive');

        $this->app->singleton(Host::class, function (Application $app): Host {
            $class = $app->make('config')->get('openreceive.host');
            if (!is_string($class) || !class_exists($class)) {
                throw new ConfigurationError(
                    "config('openreceive.host') must name a class implementing OpenReceive\\Host "
                    . '(a class NAME, not a closure — config:cache cannot serialize closures). '
                    . 'Run `php artisan openreceive:install` to scaffold app/OpenReceive/Host.php. https://openreceive.org/guides/quickstart-laravel.md'
                );
            }
            $host = $app->make($class);
            if (!$host instanceof Host) {
                throw new ConfigurationError("{$class} must implement OpenReceive\\Host.");
            }
            return $host;
        });

        $this->app->singleton(Service::class, fn (Application $app): Service => $this->buildService($app));

        $this->app->singleton(Engine::class, function (Application $app): Engine {
            $config = (array) $app->make('config')->get('openreceive');
            $connection = $app->make('db')->connection($config['connection'] ?? null);
            $repository = new SqlPaymentRepository(new PdoConnection($connection->getPdo()));
            return new Engine(
                $app->make(Host::class),
                $repository,
                $app->make(Service::class),
                $config['opportunistic_reconcile'] ?? true,
                $config['rate_limiting'] ?? false,
                null,
                // The Illuminate request reaches the extractor (RequestHandler::HOST_REQUEST_ATTRIBUTE),
                // so Laravel's TrustProxies decides who the payer is.
                static fn (mixed $request): ?string => $request instanceof Request ? $request->ip() : Engine::defaultClientIp($request),
                $app->make(LoggerInterface::class),
                '/' . trim((string) ($config['route_prefix'] ?? 'openreceive'), '/'),
            );
        });

        $this->commands([InstallCommand::class, DoctorCommand::class, ReconcileCommand::class, NotificationsCommand::class]);
    }

    public function boot(): void
    {
        $this->publishes([__DIR__ . '/../config/openreceive.php' => $this->app->configPath('openreceive.php')], 'openreceive-config');
        $this->registerRoutes();
        $this->app->booted(function (): void {
            $this->warnAboutPlaceholders();
            if ($this->shouldPreflightEagerly()) {
                $this->eagerPreflight();
            }
        });
    }

    /**
     * The PSR-15 handler decides 404/405 inside the prefix, so one catch-all
     * route under the configured middleware group is the whole mount.
     */
    private function registerRoutes(): void
    {
        $config = (array) $this->app->make('config')->get('openreceive');
        $prefix = trim((string) ($config['route_prefix'] ?? 'openreceive'), '/');
        Route::group(['prefix' => $prefix, 'middleware' => $config['middleware'] ?? ['web']], static function () use ($prefix): void {
            Route::any('{openreceivePath?}', OpenReceiveController::class)
                ->where('openreceivePath', '.*')
                ->name(self::ROUTE_NAME)
                ->defaults('openreceivePrefix', '/' . $prefix);
        });
    }

    /** Build the Service the way Rails' Configuration#service does: a bound client wins, otherwise NWC_URI. */
    private function buildService(Application $app): Service
    {
        $config = (array) $app->make('config')->get('openreceive');
        $env = self::engineEnvironment($config);
        $currencies = array_values(array_map('strval', (array) ($config['price_currencies'] ?? ['USD'])));
        $priceProvider = $app->bound(PriceProvider::class) ? $app->make(PriceProvider::class) : null;
        /** @var list<SwapProvider>|null $swapProviders */
        $swapProviders = $app->bound(self::SWAP_PROVIDERS) ? array_values((array) $app->make(self::SWAP_PROVIDERS)) : null;
        $allowSpend = (bool) ($config['allow_spend_capable_wallet'] ?? false);
        $logger = $app->make(LoggerInterface::class);
        $http = self::httpTransport();

        $client = $app->bound(ReceiveNwcClient::class)
            ? $app->make(ReceiveNwcClient::class)
            : $this->clientFromEnvironment($app, $env, $config, $logger);
        return new Service($client, $priceProvider, $swapProviders, $currencies, null, $allowSpend, $env, $logger, $http);
    }

    /**
     * The bundled nostr-php client from NWC_URI (the same refusals Service::fromEnvironment makes),
     * with its info event remembered in the app's cache across requests.
     *
     * @param array<string, mixed> $env
     * @param array<string, mixed> $config
     */
    private function clientFromEnvironment(Application $app, array $env, array $config, LoggerInterface $logger): ReceiveNwcClient
    {
        $connection = trim((string) ($env['NWC_URI'] ?? ''));
        if ($connection === '') {
            throw new ConfigurationError(
                "OpenReceive needs a receive-only NWC code to receive payments.\n"
                . "Set NWC_URI in .env to your receive-only Nostr Wallet Connect connection string.\n"
                . 'Get one here: ' . Kernel::NWC_CODE_HELP_URL
            );
        }
        try {
            $client = new NostrPhpNwcReceiveClient($connection, $logger);
        } catch (NwcUriParseError $e) {
            throw new ConfigurationError(
                "NWC_URI is set, but it is not a valid NWC code.\nReason: {$e->getMessage()}\n"
                . 'Get a receive-only NWC code here: ' . Kernel::NWC_CODE_HELP_URL,
                0,
                $e,
            );
        }
        $ttl = (int) ($config['wallet_info_cache_seconds'] ?? 600);
        if ($ttl <= 0) {
            return $client;
        }
        return new CachedWalletInfo($client, $app->make('cache')->store(), CachedWalletInfo::keyFor($client), $ttl, $logger);
    }

    /**
     * The environment the engine reads, with the config-cached secrets laid
     * over the process environment: under `config:cache` Laravel never loads
     * .env, so env('NWC_URI') is only reliable through config.
     *
     * @param array<string, mixed> $config
     * @return array<string, mixed>
     */
    public static function engineEnvironment(array $config): array
    {
        $env = Service::processEnvironment();
        foreach (['nwc_uri' => 'NWC_URI', 'lsc_uri_primary' => 'LSC_URI_PRIMARY', 'lsc_uri_backup' => 'LSC_URI_BACKUP'] as $key => $name) {
            $value = $config[$key] ?? null;
            if (is_string($value) && trim($value) !== '') {
                $env[$name] = $value;
            }
        }
        return $env;
    }

    /** Guzzle when the app ships it (Laravel does), the engine's stream transport otherwise. */
    private static function httpTransport(): ?HttpTransport
    {
        if (class_exists(\GuzzleHttp\Client::class) && class_exists(\Nyholm\Psr7\Factory\Psr17Factory::class)) {
            $factory = new \Nyholm\Psr7\Factory\Psr17Factory();
            return new Psr18Transport(new \GuzzleHttp\Client(['http_errors' => false]), $factory, $factory);
        }
        return null;
    }

    /** Boot-time warnings while the scaffolded placeholders are still wired (cheap: resolves the host, not the wallet). */
    private function warnAboutPlaceholders(): void
    {
        $class = $this->app->make('config')->get('openreceive.host');
        if (!is_string($class) || !class_exists($class)) {
            return;
        }
        $logger = $this->app->make(LoggerInterface::class);
        foreach (Doctor::placeholderWarnings($this->app->make(Host::class)) as $warning) {
            $logger->warning($warning);
        }
    }

    /**
     * Artisan commands that legitimately run without the wallet's secret in
     * the environment — a Docker build step, `migrate` before the app has its
     * .env. Every other production process (the web SAPI, a queue worker, the
     * OpenReceive workers) preflights on boot.
     */
    public const SECRETLESS_COMMANDS = [
        'config:cache', 'config:clear', 'route:cache', 'route:clear', 'view:cache', 'view:clear', 'event:cache',
        'optimize', 'optimize:clear', 'package:discover', 'vendor:publish', 'key:generate', 'storage:link',
        'migrate', 'migrate:install', 'migrate:status', 'migrate:rollback', 'migrate:fresh', 'migrate:refresh', 'migrate:reset',
        'db:seed', 'openreceive:install', 'about', 'list', 'help',
    ];

    /**
     * Rails' precedent: check the wallet when a production process boots so a
     * bad NWC_URI stops the deploy instead of the first checkout. The known
     * secretless build-step commands skip it (Rails skips `assets:precompile`
     * the same way); the commands that need the wallet build the Service on
     * first use anyway.
     */
    public function shouldPreflightEagerly(): bool
    {
        if (!(bool) $this->app->make('config')->get('openreceive.eager_preflight', true)) {
            return false;
        }
        if (!$this->app->environment('production')) {
            return false;
        }
        if (!$this->app->runningInConsole()) {
            return true;
        }
        $command = $_SERVER['argv'][1] ?? null;
        return !is_string($command) || !in_array($command, self::SECRETLESS_COMMANDS, true);
    }

    /** Builds the Service now — and with it the receive-only wallet preflight, which throws on a missing, dead or spend-capable wallet. */
    public function eagerPreflight(): void
    {
        $this->app->make(Service::class);
    }
}
