<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use OpenReceive\Laravel\Tests\Fixtures\PlaceholderHost;

final class DoctorCommandTest extends TestCase
{
    private const SENTINEL = 'sentinel-connection-value-that-must-never-be-printed';

    protected string $hostClass = PlaceholderHost::class;

    protected function defineOpenReceiveEnvironment(Application $app): void
    {
        $app->make('config')->set('openreceive.nwc_uri', self::SENTINEL);
        $app->make('config')->set('openreceive.lsc_uri_primary', null);
    }

    public function testItReportsPresenceOnlyAndNeverAValue(): void
    {
        $this->artisan('openreceive:doctor', ['--no-wallet' => true])
            ->expectsOutputToContain('NWC_URI:          set')
            ->expectsOutputToContain('LSC_URI_PRIMARY:  unset')
            ->expectsOutputToContain('host:             ' . PlaceholderHost::class)
            ->expectsOutputToContain('authorize:        the generated placeholder (allow-all) — replace it')
            ->expectsOutputToContain('on_paid:          the generated placeholder (logging-only) — replace it')
            ->expectsOutputToContain('engine mounted:   at /openreceive')
            ->expectsOutputToContain('wallet preflight: skipped')
            ->doesntExpectOutputToContain(self::SENTINEL)
            ->assertSuccessful();
    }

    public function testTheWalletCheckRunsThePreflightThroughTheBoundClient(): void
    {
        $this->artisan('openreceive:doctor')
            ->expectsOutputToContain('wallet preflight: ok — the wallet answered and is receive-only')
            ->doesntExpectOutputToContain(self::SENTINEL)
            ->assertSuccessful();
    }
}
