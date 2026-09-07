<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use OpenReceive\Laravel\Tests\Fixtures\ShopHost;

final class WorkerCommandsTest extends TestCase
{
    protected function defineOpenReceiveEnvironment(Application $app): void
    {
        $app['env'] = 'local';
    }

    protected function setUp(): void
    {
        parent::setUp();
        ShopHost::reset();
        $this->migrateOpenReceiveTables();
    }

    private function mintAttempt(): string
    {
        $this->withSession(['user_id' => 'u1']);
        $token = $this->app->make('session')->token();
        $created = $this->postJson('/openreceive/checkouts', ['reference' => 'order-1'], ['X-CSRF-TOKEN' => $token]);
        $created->assertStatus(201);
        return (string) $created->json('checkout.payment_hash');
    }

    public function testReconcileSettlesAPendingAttemptTheWalletReportsPaid(): void
    {
        $hash = $this->mintAttempt();
        $this->wallet->settleInvoice(['payment_hash' => $hash]);
        $this->artisan('openreceive:reconcile')
            ->expectsOutput('openreceive:reconcile checked 1 pending attempt(s)')
            ->assertSuccessful();
        self::assertCount(1, ShopHost::$paid);
        self::assertSame($hash, ShopHost::$paid[0]->paymentHash);
    }

    public function testTheNotificationsWorkerRunsItsPeriodicPassAndEndsWhenToldTo(): void
    {
        $hash = $this->mintAttempt();
        $this->wallet->settleInvoice(['payment_hash' => $hash]);
        $this->artisan('openreceive:notifications', ['--iterations' => 1])
            ->expectsOutputToContain('listening for NWC-02 payment_received and reconciling every 15s')
            ->assertSuccessful();
        self::assertCount(1, ShopHost::$paid);
    }
}
