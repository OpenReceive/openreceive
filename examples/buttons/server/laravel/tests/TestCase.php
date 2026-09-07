<?php

declare(strict_types=1);

namespace Tests;

use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Rates\PriceProvider;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;

/**
 * Every feature test runs the production wiring against the engine's fakes,
 * bound through the same three container seams testkit mode uses — but bound
 * HERE, per test, not through DEMO_WALLET: the test environment must prove the
 * control surface is off (TestkitOffTest).
 */
abstract class TestCase extends BaseTestCase
{
    // DatabaseMigrations, not RefreshDatabase: the latter wraps each test in an
    // open transaction, and the engine's settlement path opens its own on the
    // same PDO — the same reason a host must not wrap onPaid in DB::transaction().
    use DatabaseMigrations;

    protected FakeWallet $wallet;
    protected FakeSwapProvider $swapProvider;

    protected function setUp(): void
    {
        parent::setUp();
        $this->wallet = new FakeWallet();
        $this->swapProvider = new FakeSwapProvider();
        $this->app->singleton(ReceiveNwcClient::class, fn (): ReceiveNwcClient => $this->wallet);
        $this->app->singleton(PriceProvider::class, static fn (): PriceProvider => new StaticPriceProvider());
        $this->app->singleton(OpenReceiveServiceProvider::SWAP_PROVIDERS, fn (): array => [$this->swapProvider]);
    }
}
