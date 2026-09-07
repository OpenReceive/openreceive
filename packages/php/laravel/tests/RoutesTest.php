<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use OpenReceive\Laravel\Tests\Fixtures\ShopHost;

/**
 * The mount: one catch-all under the configured prefix and the `web` group.
 * The app runs as `local` here, not `testing`, because Laravel's
 * VerifyCsrfToken skips itself under unit tests — and the CSRF behaviour is
 * exactly what these tests are about.
 */
final class RoutesTest extends TestCase
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

    public function testAPostWithoutTheCsrfHeaderIs419UnderTheWebGroup(): void
    {
        $this->withSession(['user_id' => 'u1'])
            ->postJson('/openreceive/checkouts/prepare', ['reference' => 'order-1'])
            ->assertStatus(419);
        self::assertSame([], ShopHost::$authorized, 'the engine must not run before the CSRF check');
    }

    public function testThePostSucceedsWithTheSessionTokenInXCsrfToken(): void
    {
        $this->withSession(['user_id' => 'u1']);
        $token = $this->app->make('session')->token();
        $response = $this->postJson('/openreceive/checkouts/prepare', ['reference' => 'order-1'], ['X-CSRF-TOKEN' => $token]);
        $response->assertStatus(200);
        // $1.00 at the static $50,000 rate: the one fixture every stack shares.
        self::assertSame(2_000_000, $response->json('amount_msats'));
        self::assertSame('One button', $response->json('description'));
    }

    public function testAuthorizeReceivesTheIlluminateRequestWithItsSession(): void
    {
        $this->withSession(['user_id' => 'u1']);
        $token = $this->app->make('session')->token();
        $this->postJson('/openreceive/checkouts', ['reference' => 'order-1'], ['X-CSRF-TOKEN' => $token])->assertStatus(201);

        self::assertCount(1, ShopHost::$authorized);
        $context = ShopHost::$authorized[0];
        self::assertSame('checkout.create', $context->action);
        self::assertInstanceOf(Request::class, $context->request);
        self::assertSame('u1', $context->request->session()->get('user_id'));
        self::assertSame('order-1', $context->reference());
    }

    public function testAnotherSessionIsForbidden(): void
    {
        $this->withSession(['user_id' => 'someone-else']);
        $token = $this->app->make('session')->token();
        $response = $this->postJson('/openreceive/checkouts/prepare', ['reference' => 'order-1'], ['X-CSRF-TOKEN' => $token]);
        $response->assertStatus(403);
        self::assertSame('FORBIDDEN', $response->json('code'));
    }

    public function testRatesIsAnUnauthenticatedGet(): void
    {
        $response = $this->getJson('/openreceive/rates');
        $response->assertStatus(200);
        self::assertSame('50000.00', $response->json('bitcoin.usd'));
    }

    public function testTheHandlerDecides404And405InsideThePrefix(): void
    {
        $this->getJson('/openreceive/nothing-here')->assertStatus(404)->assertJsonPath('code', 'NOT_FOUND');
        $this->getJson('/openreceive/checkouts')->assertStatus(405);
    }

    public function testACommittedAttemptSettlesThroughPaymentsCheckAndRunsOnPaidOnce(): void
    {
        $this->withSession(['user_id' => 'u1']);
        $token = $this->app->make('session')->token();
        $created = $this->postJson('/openreceive/checkouts', ['reference' => 'order-1'], ['X-CSRF-TOKEN' => $token]);
        $created->assertStatus(201);
        $hash = $created->json('checkout.payment_hash');
        self::assertSame(str_repeat('0', 63) . '1', $hash);

        $this->wallet->settleInvoice(['payment_hash' => $hash]);
        $check = $this->postJson('/openreceive/payments/check', ['reference' => 'order-1', 'payment_hash' => $hash], ['X-CSRF-TOKEN' => $token]);
        $check->assertStatus(200);
        self::assertSame('settled', $check->json('status'));
        self::assertCount(1, ShopHost::$paid);
        self::assertSame('order-1', ShopHost::$paid[0]->reference);
        self::assertNotNull(ShopHost::$paid[0]->connection, 'onPaid runs inside the settlement transaction');
        self::assertCount(1, ShopHost::$afterPaid);
        self::assertNull(ShopHost::$afterPaid[0]->connection, 'afterPaid runs after COMMIT');

        // A second check is served from the row: no second fulfillment.
        $this->postJson('/openreceive/payments/check', ['reference' => 'order-1', 'payment_hash' => $hash], ['X-CSRF-TOKEN' => $token])->assertStatus(200);
        self::assertCount(1, ShopHost::$paid);
    }
}
