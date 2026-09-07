<?php

declare(strict_types=1);

namespace App\Providers;

use App\Testkit\Testkit;
use Illuminate\Support\ServiceProvider;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Rates\PriceProvider;
use OpenReceive\Rates\StaticPriceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // TESTKIT WALLET MODE, and the only branch in this app's wiring.
        //
        // `DEMO_WALLET=testkit` binds the three container seams the OpenReceive
        // provider reads — the wallet client, the price provider and the swap
        // provider list — to the engine's in-memory fakes, so the whole shop
        // can be clicked through (Lightning, a swap deposit, a refund) with no
        // NWC_URI, no FixedFloat keys and no network. Everything else is the
        // production wiring: the engine, the three hooks, the migrations, the
        // controllers and the SPA run exactly as they do in compose.
        //
        // BTC at a fixed $50,000, the same constant every stack's testkit uses,
        // so a $1.00 button is 2,000 sats on every stack.
        if (Testkit::enabled()) {
            $this->app->singleton(ReceiveNwcClient::class, static fn (): ReceiveNwcClient => Testkit::wallet());
            $this->app->singleton(PriceProvider::class, static fn (): PriceProvider => new StaticPriceProvider());
            $this->app->singleton(OpenReceiveServiceProvider::SWAP_PROVIDERS, static fn (): array => [Testkit::swapProvider()]);
            // PHP starts every request from nothing: the fakes' state is
            // snapshotted after each response and restored before the next.
            $this->app->terminating(static fn () => Testkit::save());
        }
    }

    public function boot(): void
    {
        //
    }
}
