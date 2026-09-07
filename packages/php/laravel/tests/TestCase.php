<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\DB;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Laravel\Tests\Fixtures\ShopHost;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Rates\PriceProvider;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;
use Orchestra\Testbench\TestCase as Testbench;

/**
 * Testbench base: the package provider, an in-memory sqlite default
 * connection, and the three container seams bound to the engine's fakes (the
 * same seams the demo's testkit mode uses) — so every test runs the real
 * provider, routes and engine with no wallet and no network.
 */
abstract class TestCase extends Testbench
{
    protected FakeWallet $wallet;
    protected FakeSwapProvider $swapProvider;

    /** @var class-string */
    protected string $hostClass = ShopHost::class;

    protected function getPackageProviders($app): array
    {
        return [OpenReceiveServiceProvider::class];
    }

    protected function defineEnvironment($app): void
    {
        $this->wallet = new FakeWallet();
        $this->swapProvider = new FakeSwapProvider();
        $app->singleton(ReceiveNwcClient::class, fn (): ReceiveNwcClient => $this->wallet);
        $app->singleton(PriceProvider::class, static fn (): PriceProvider => new StaticPriceProvider());
        $app->singleton(OpenReceiveServiceProvider::SWAP_PROVIDERS, fn (): array => [$this->swapProvider]);

        $config = $app->make('config');
        $config->set('app.key', 'base64:' . base64_encode(random_bytes(32)));
        $config->set('database.default', 'testing');
        $config->set('openreceive.host', $this->hostClass);
        $this->defineOpenReceiveEnvironment($app);
    }

    /** Per-test-class overrides, applied before the providers boot. */
    protected function defineOpenReceiveEnvironment(Application $app): void
    {
    }

    /** The engine's two tables on the default connection (what the published migration does for a host). */
    protected function migrateOpenReceiveTables(): void
    {
        PaymentsSchema::migrate(new PdoConnection(DB::connection()->getPdo()));
    }
}
