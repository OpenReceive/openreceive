<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Laravel\Tests\Fixtures\SpendCapableWallet;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Errors\SpendCapableWalletError;

/**
 * Rails' precedent, in Laravel: a production boot checks the wallet and fails
 * closed on one that can spend. Testbench boots the app itself, so the check
 * is driven through the provider's two public steps rather than by catching an
 * exception out of setUp().
 */
final class EagerPreflightTest extends TestCase
{
    protected function defineOpenReceiveEnvironment(Application $app): void
    {
        $app['env'] = 'production';
        // A wallet advertising pay_invoice, in place of the receive-only fake.
        $app->singleton(ReceiveNwcClient::class, static fn (): ReceiveNwcClient => new SpendCapableWallet());
        // Boot must not run the preflight before the assertions below own it.
        $app->make('config')->set('openreceive.eager_preflight', false);
    }

    public function testProductionBootFailsClosedOnASpendCapableWallet(): void
    {
        $this->app->make('config')->set('openreceive.eager_preflight', true);
        $provider = new OpenReceiveServiceProvider($this->app);
        self::assertTrue($provider->shouldPreflightEagerly());
        $this->expectException(SpendCapableWalletError::class);
        $provider->eagerPreflight();
    }

    public function testTheExplicitOverrideLetsItBoot(): void
    {
        $this->app->make('config')->set('openreceive.eager_preflight', true);
        $this->app->make('config')->set('openreceive.allow_spend_capable_wallet', true);
        (new OpenReceiveServiceProvider($this->app))->eagerPreflight();
        $this->addToAssertionCount(1);
    }

    public function testOutsideProductionTheWalletIsBuiltLazily(): void
    {
        $this->app['env'] = 'local';
        $this->app->make('config')->set('openreceive.eager_preflight', true);
        self::assertFalse((new OpenReceiveServiceProvider($this->app))->shouldPreflightEagerly());
    }
}
