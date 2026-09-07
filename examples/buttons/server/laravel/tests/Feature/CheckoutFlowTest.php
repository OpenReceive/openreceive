<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ShopOrder;
use App\Support\CatalogSeed;
use App\Support\Visitor;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * The whole bridge, end to end, with the wallet stubbed: bootstrap → order →
 * the mounted engine mints against the fake wallet → the wallet settles →
 * payments/check runs onPaid inside the settlement transaction → the order
 * row is paid and the download unlocks. Another browser sees none of it.
 */
final class CheckoutFlowTest extends TestCase
{
    private string $visitorCookie = '';

    protected function setUp(): void
    {
        parent::setUp();
        CatalogSeed::apply();
        // The bootstrap mints the visitor; its cookie is what every later request carries.
        $bootstrap = $this->getJson('/shop/bootstrap');
        $bootstrap->assertOk();
        $cookie = $bootstrap->getCookie(Visitor::COOKIE);
        self::assertNotNull($cookie);
        $this->visitorCookie = (string) $cookie->getValue();
    }

    /** @param array<string, mixed> $body */
    private function asVisitor(string $method, string $uri, array $body = []): TestResponse
    {
        // getCookie() decrypted the value; the test client encrypts it again on the
        // way out — and only sends cookies on a JSON request with withCredentials().
        return $this->withCredentials()->withCookie(Visitor::COOKIE, $this->visitorCookie)->json($method, $uri, $body);
    }

    public function testBootstrapCarriesTheServerPricedCatalogAndTheMountPrefix(): void
    {
        $response = $this->asVisitor('GET', '/shop/bootstrap');
        $response->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        self::assertSame('/openreceive', $response->json('shop.openreceive_prefix'));
        self::assertCount(6, $response->json('shop.catalog'));
        self::assertSame(['sku' => 'safety-orange', 'name' => 'Safety Orange', 'price_cents' => 100, 'image_url' => '/images/openreceive-safety-orange-button.webp'], $response->json('shop.catalog.0'));
        self::assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $response->json('shop.visitor.public_ref'));
    }

    public function testACartIsPricedFromTheProductRowsNeverFromTheWire(): void
    {
        $created = $this->asVisitor('POST', '/shop/orders', ['items' => [
            ['sku' => 'safety-orange', 'quantity' => 2, 'price_cents' => 1],
            ['sku' => 'classic-black', 'quantity' => 1],
            ['sku' => 'not-a-product', 'quantity' => 5],
            ['sku' => 'signal-red', 'quantity' => 99],
        ]]);
        $created->assertStatus(201);
        self::assertSame('awaiting_payment', $created->json('state'));
        // 2 × $1.00 + $5.00 + 10 (clamped) × $10.00
        self::assertSame(10_700, $created->json('total_cents'));
        self::assertSame('107.00', $created->json('total_amount'));
        self::assertSame('OpenReceive buttons: Safety Orange ×2, Classic Black, Signal Red ×10', $created->json('description'));
        self::assertNull($created->json('items.0.download_path'));

        $this->asVisitor('POST', '/shop/orders', ['items' => []])->assertStatus(422)->assertJsonPath('error', 'Your cart is empty.');
    }

    public function testTheLightningCheckoutSettlesThroughTheThreeHooks(): void
    {
        $reference = (string) $this->asVisitor('POST', '/shop/orders', ['items' => [['sku' => 'safety-orange', 'quantity' => 1]]])->json('reference');

        // The mounted engine: authorize (this visitor owns the order) → amountFor ($1.00 → 2,000 sats) → mint.
        $checkout = $this->asVisitor('POST', '/openreceive/checkouts', ['reference' => $reference]);
        $checkout->assertStatus(201);
        $hash = (string) $checkout->json('checkout.payment_hash');
        self::assertSame(str_repeat('0', 63).'1', $hash);
        self::assertSame(2_000_000, $checkout->json('checkout.amount_msats'));
        self::assertSame('OpenReceive button: Safety Orange', $checkout->json('description'));
        self::assertStringStartsWith('lnbcopenreceive', (string) $checkout->json('checkout.bolt11'));

        // Still unpaid: no download.
        self::assertSame('awaiting_payment', $this->asVisitor('GET', "/shop/orders/{$reference}")->json('state'));
        $this->asVisitor('GET', "/shop/orders/{$reference}/downloads/safety-orange")->assertStatus(403);

        // The wallet reports the payment; the next status poll settles it and runs onPaid ONCE.
        $this->wallet->settleInvoice(['payment_hash' => $hash]);
        $check = $this->asVisitor('POST', '/openreceive/payments/check', ['reference' => $reference, 'payment_hash' => $hash]);
        $check->assertOk();
        self::assertSame('settled', $check->json('status'));

        $order = $this->asVisitor('GET', "/shop/orders/{$reference}");
        self::assertSame('paid', $order->json('state'));
        self::assertSame("/shop/orders/{$reference}/downloads/safety-orange", $order->json('items.0.download_path'));
        self::assertSame($hash, ShopOrder::query()->findOrFail($reference)->payment_hash);

        $download = $this->asVisitor('GET', "/shop/orders/{$reference}/downloads/safety-orange");
        $download->assertOk();
        self::assertSame('image/webp', $download->headers->get('Content-Type'));

        // A second payment can never re-fulfill: the engine refuses a new checkout under a settled reference.
        $this->asVisitor('POST', '/openreceive/checkouts', ['reference' => $reference])->assertStatus(409);

        // The public feed shows the paid order, attributed to the PUBLIC handle, and never the order id.
        $feed = $this->getJson('/shop/recent_orders');
        $feed->assertOk()->assertHeader('Cache-Control', 'max-age=10, public');
        self::assertSame(1, $feed->json('totals.paid_orders'));
        self::assertSame(1, $feed->json('totals.buttons_sold'));
        self::assertSame('Safety Orange', $feed->json('orders.0.items.0.name'));
        self::assertStringNotContainsString($reference, $feed->getContent());
    }

    public function testAnotherBrowserCannotSeeOrPayForThisOrder(): void
    {
        $reference = (string) $this->asVisitor('POST', '/shop/orders', ['items' => [['sku' => 'safety-orange', 'quantity' => 1]]])->json('reference');

        // No cookie: a NEW visitor, who does not own the order. 404, never 403 — do not confirm the id exists.
        $this->defaultCookies = [];
        $this->withCredentials = false;
        $this->getJson("/shop/orders/{$reference}")->assertStatus(404);
        // And the engine's authorize hook says no before any wallet call.
        $stranger = $this->postJson('/openreceive/checkouts/prepare', ['reference' => $reference]);
        $stranger->assertStatus(403);
        self::assertSame('FORBIDDEN', $stranger->json('code'));
        self::assertSame([], $this->wallet->listInvoices());
    }

    public function testTheArtworkIsServedFromTheOneImagesDirectory(): void
    {
        $this->get('/images/openreceive-safety-orange-button.webp')->assertOk()->assertHeader('Content-Type', 'image/webp');
        $this->get('/images/nope.webp')->assertStatus(404);
    }
}
