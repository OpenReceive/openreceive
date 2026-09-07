<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Testkit\Testkit;
use Tests\TestCase;

/**
 * THE OFF STATE IS THE ASSERTION HERE. The route is declared unconditionally,
 * so the only thing between a production boot and a surface that can settle
 * invoices is Testkit::enabled() — and the test environment does not set
 * DEMO_WALLET, which makes this suite the honest place to prove it.
 */
final class TestkitOffTest extends TestCase
{
    public function testDemoWalletIsNotSetInTheTestEnvironment(): void
    {
        self::assertFalse(Testkit::enabled());
    }

    public function testEveryActionIsAJson404OutsideTestkitWalletMode(): void
    {
        foreach (['settle', 'expire', 'swap-step', 'state'] as $action) {
            $response = $this->postJson("/__testkit/{$action}", ['payment_hash' => str_repeat('a', 64)]);
            $response->assertStatus(404);
            self::assertSame('NOT_FOUND', $response->json('code'), "{$action} answered {$response->status()}");
            // JSON, never the SPA shell: a control surface that answered with a page would look like a route that exists.
            self::assertStringStartsWith('application/json', (string) $response->headers->get('Content-Type'));
        }
        $this->get('/__testkit/state')->assertStatus(404);
    }

    public function testTheControlDispatcherRefusesEveryActionWhenTheModeIsOff(): void
    {
        [$status, $body] = Testkit::control('settle', ['payment_hash' => str_repeat('a', 64)]);
        self::assertSame(404, $status);
        self::assertSame('NOT_FOUND', $body['code']);
    }
}
