<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\Repository;
use OpenReceive\Laravel\Wallet\CachedWalletInfo;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Service;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase as PlainTestCase;

final class CachedWalletInfoTest extends PlainTestCase
{
    public function testTheSecondServiceInTheSameCacheSkipsTheLivePreflight(): void
    {
        $counting = new class implements ReceiveNwcClient {
            public int $preflights = 0;
            private readonly FakeWallet $inner;

            public function __construct()
            {
                $this->inner = new FakeWallet();
            }

            public function preflight(): array
            {
                $this->preflights++;
                return $this->inner->preflight();
            }

            public function makeInvoice(array $request): array
            {
                return $this->inner->makeInvoice($request);
            }

            public function listTransactions(array $request): array
            {
                return $this->inner->listTransactions($request);
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
                $this->inner->subscribeNotifications($handler, $onIdle);
            }
        };
        $cache = new Repository(new ArrayStore());
        $build = static fn (): Service => new Service(new CachedWalletInfo($counting, $cache, 'k', 600), false, [], ['USD']);

        $build();
        $build();
        $third = $build();
        self::assertSame(1, $counting->preflights, 'one live get_info per TTL, however many requests boot the engine');
        self::assertSame(['make_invoice', 'list_transactions'], $cache->get('k')['methods']);
        // Requests still go to the wallet: the cache holds the info event only.
        self::assertSame(str_repeat('0', 63) . '1', $third->createCheckout(['reference' => 'r', 'amount' => ['sats' => 2000]])['payment_hash']);

        // TTL 0 = every construction preflights.
        new Service(new CachedWalletInfo($counting, $cache, 'k', 0), false, [], ['USD']);
        self::assertSame(2, $counting->preflights);
    }
}
