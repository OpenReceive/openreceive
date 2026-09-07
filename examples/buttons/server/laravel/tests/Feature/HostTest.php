<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\ShopOrder;
use App\Models\ShopProduct;
use App\Models\ShopUser;
use App\OpenReceive\Host;
use App\Support\CatalogSeed;
use Tests\TestCase;

final class HostTest extends TestCase
{
    public function testAmountForIsADecimalStringFromTheOrderRowOrNull(): void
    {
        CatalogSeed::apply();
        $user = ShopUser::query()->create(['first_seen_at' => now(), 'last_seen_at' => now()]);
        $order = ShopOrder::createFromLines([
            ['product' => ShopProduct::activeBySku('midnight-navy'), 'quantity' => 3],
        ], $user);

        $host = new Host();
        self::assertSame(['currency' => 'USD', 'value' => '9.00', 'description' => 'OpenReceive buttons: Midnight Navy ×3'], $host->amountFor($order->id));
        self::assertNull($host->amountFor('00000000-0000-0000-0000-000000000000'));
        self::assertNull($host->amountFor('not-a-uuid'));
    }

    public function testClaimPaidIsIdempotent(): void
    {
        CatalogSeed::apply();
        $user = ShopUser::query()->create(['first_seen_at' => now(), 'last_seen_at' => now()]);
        $order = ShopOrder::createFromLines([['product' => ShopProduct::activeBySku('safety-orange'), 'quantity' => 1]], $user);

        self::assertTrue(ShopOrder::claimPaid($order->id, 1_700_000_000, str_repeat('a', 64)));
        self::assertFalse(ShopOrder::claimPaid($order->id, 1_700_000_001, str_repeat('b', 64)), 'the WHERE clause is the lock');
        $paid = $order->fresh();
        self::assertSame('paid', $paid->state);
        self::assertSame(str_repeat('a', 64), $paid->payment_hash);
        self::assertSame(1_700_000_000, $paid->paid_at->getTimestamp());
    }

    public function testSeedingIsIdempotent(): void
    {
        self::assertSame(6, CatalogSeed::apply());
        self::assertSame(6, CatalogSeed::apply());
        self::assertSame(6, ShopProduct::query()->count());
        self::assertSame(100, ShopProduct::activeBySku('safety-orange')?->price_cents);
    }
}
