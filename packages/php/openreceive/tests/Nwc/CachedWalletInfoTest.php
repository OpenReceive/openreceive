<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Nwc;

use dsbaars\nostr\Nip47\NwcClient;
use dsbaars\nostr\Nip47\Response\GetInfoResponse;
use OpenReceive\Nwc\CachedWalletInfo;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Server\Errors\SpendCapableWalletError;
use OpenReceive\Server\Service;
use OpenReceive\Support\SharedCache;
use OpenReceive\Tests\Support\MemorySharedCache;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * PHP builds the engine per request, so the receive-only preflight would ask
 * the wallet on every request. The wrapper asks once per TTL and still runs
 * every preflight refusal on what it remembered.
 */
final class CachedWalletInfoTest extends TestCase
{
    use VectorSupport;

    private const RECEIVE_ONLY = ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip44_v2', 'nip04'], 'notifications' => ['payment_received']];

    private int $infoReads = 0;
    /** @var list<?string> */
    private array $encryptions = [];

    /** One request's wallet client: a fresh adapter over a stub that counts get_info. */
    private function client(array $info = self::RECEIVE_ONLY): NostrPhpNwcReceiveClient
    {
        $stub = new class ($info, $this->infoReads, $this->encryptions) extends NwcClient {
            /** @param array<string, mixed> $info @param list<?string> $encryptions */
            public function __construct(private readonly array $info, private int &$reads, private array &$encryptions)
            {
                // Deliberately not calling the parent: no relay, no keys.
                $this->encryptions[] = null;
            }

            public function getWalletInfo(): GetInfoResponse
            {
                $this->reads++;
                return new GetInfoResponse('get_info', $this->info);
            }

            public function setEncryption(string $method): void
            {
                $this->encryptions[array_key_last($this->encryptions)] = $method;
            }
        };
        return new NostrPhpNwcReceiveClient(self::uri(), null, $stub);
    }

    private static function uri(): string
    {
        return self::vector('nwc-uri-parse')['cases'][0]['uri'];
    }

    public function testRequestsAfterTheFirstReadTheInfoFromTheCache(): void
    {
        $cache = new MemorySharedCache();
        $request = fn (): Service => new Service(new CachedWalletInfo($this->client(), $cache, CachedWalletInfo::keyFor(self::uri())), false, []);
        $request();
        $request();
        $request();
        self::assertSame(1, $this->infoReads, 'one get_info per TTL, however many requests build the engine');
        self::assertSame(['nip44_v2', 'nip44_v2', 'nip44_v2'], $this->encryptions, 'a primed client picks the same encryption as a live preflight');
        $entry = $cache->entries[CachedWalletInfo::keyFor(self::uri())];
        self::assertSame(CachedWalletInfo::TTL_SECONDS, $entry['ttl']);
        self::assertStringNotContainsString(explode('secret=', self::uri())[1], implode(' ', array_keys($cache->entries)) . $entry['value'], 'the code never reaches the cache');
    }

    public function testRememberedInfoStillFacesEveryPreflightRefusal(): void
    {
        $cache = new MemorySharedCache();
        $cache->set(CachedWalletInfo::keyFor(self::uri()), json_encode(['methods' => ['make_invoice', 'list_transactions', 'pay_invoice']], JSON_THROW_ON_ERROR), 600);
        $this->expectException(SpendCapableWalletError::class);
        new Service(new CachedWalletInfo($this->client(), $cache, CachedWalletInfo::keyFor(self::uri())), false, []);
    }

    public function testABrokenCacheFallsBackToTheLivePreflight(): void
    {
        $broken = new class implements SharedCache {
            public function get(string $key): ?string
            {
                throw new \RuntimeException('cache down');
            }

            public function set(string $key, string $value, int $ttlSeconds): void
            {
                throw new \RuntimeException('cache down');
            }
        };
        new Service(new CachedWalletInfo($this->client(), $broken, 'k'), false, []);
        new Service(new CachedWalletInfo($this->client(), $broken, 'k'), false, []);
        self::assertSame(2, $this->infoReads);
    }

    public function testFromEnvironmentKeepsTheInfoInTheCacheItIsGiven(): void
    {
        $cache = new MemorySharedCache();
        $cache->set(CachedWalletInfo::keyFor(self::uri()), json_encode(self::RECEIVE_ONLY, JSON_THROW_ON_ERROR), 600);
        // No relay is reachable here: the service boots only because the info is cached.
        $service = Service::fromEnvironment(['NWC_URI' => self::uri()], priceProvider: false, swapProviders: [], sharedCache: $cache);
        self::assertInstanceOf(CachedWalletInfo::class, $service->nwcClient());
        self::assertNotSame(CachedWalletInfo::keyFor(self::uri()), CachedWalletInfo::keyFor(self::uri() . 'x'), 'a new code asks the wallet again');
    }
}
