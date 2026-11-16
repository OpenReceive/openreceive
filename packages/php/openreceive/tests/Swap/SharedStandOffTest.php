<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Swap;

use OpenReceive\Support\FileSharedCache;
use OpenReceive\Support\SharedCache;
use OpenReceive\Swap\SwapProviderLimits;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Swap\WeightBudgetError;
use OpenReceive\Tests\Support\MemorySharedCache;
use PHPUnit\Framework\TestCase;

/**
 * A provider's 429 stand-off is kept in the SharedCache, so the guard the
 * next request builds refuses the call the provider just refused. Only the
 * two stand-off end times are kept there; the counts never are.
 */
final class SharedStandOffTest extends TestCase
{
    private const KEY = 'openreceive:swap_backoff:lightning-swap-com';

    private int $now = 1_700_000_000;
    private MemorySharedCache $cache;

    protected function setUp(): void
    {
        $this->cache = new MemorySharedCache();
    }

    /** The guard one request builds: fresh memory, the shared cache. */
    private function guard(?SwapProviderLimits $limits = null, SharedCache|false|null $cache = null): WeightBudget
    {
        return new WeightBudget(
            'lightning-swap-com',
            fn (): int => $this->now,
            $limits ?? SwapProviderLimits::lightningSwap(),
            $cache === false ? null : ($cache ?? $this->cache),
        );
    }

    /** @return array<string, mixed>|null the denial, or null when the guard allows the call */
    private static function denial(callable $call): ?array
    {
        try {
            $call();
            return null;
        } catch (WeightBudgetError $e) {
            return $e->denial;
        }
    }

    /** @return array<string, mixed> */
    private function stored(): array
    {
        return json_decode($this->cache->entries[self::KEY]['value'], true, 512, JSON_THROW_ON_ERROR);
    }

    private function store(string $value): void
    {
        $this->cache->entries[self::KEY] = ['value' => $value, 'ttl' => 60];
    }

    public function testTheNextRequestsGuardRefusesWhatTheProviderJustRefused(): void
    {
        self::assertSame(self::KEY, WeightBudget::sharedKey('lightning-swap-com'));
        $told = $this->guard();
        $told->markRateLimited('create', 30);
        // Only the stand-off end is kept, for as long as it runs.
        self::assertSame(['create_backoff_until' => $this->now + 30], $this->stored());
        self::assertSame(30 + WeightBudget::SHARED_TTL_MARGIN_SECONDS, $this->cache->entries[self::KEY]['ttl']);
        self::assertSame([self::KEY], array_keys($this->cache->entries));

        // The same denial the guard that was told gives, from one that was not.
        $own = self::denial(static fn () => $told->reserve('create'));
        foreach (['assertAvailable', 'reserve'] as $check) {
            $next = $this->guard();
            $denied = self::denial(static fn () => $next->{$check}('create'));
            self::assertSame($own, $denied, $check);
            self::assertSame('backoff', $denied['reason'] ?? null);
            self::assertSame($this->now + 30, $denied['backoff_until'] ?? null);
            self::assertSame("Swap provider API is in backoff until {$denied['backoff_until']}.", $denied['message'] ?? null);
            // Lightning Swap counts new swaps apart: the swaps that exist can still be read and refunded.
            $next->reserve('order');
            $next->reserve('emergency');
        }
        $this->now += 29;
        self::assertSame('backoff', self::denial(fn () => $this->guard()->reserve('create'))['reason'] ?? null);
        $this->now += 1;
        $this->guard()->reserve('create');
    }

    public function testAFixedFloatStandOffStopsEveryCallInTheNextRequest(): void
    {
        $limits = SwapProviderLimits::fixedFloat();
        $this->guard($limits)->markRateLimited('create');
        self::assertSame(['backoff_until' => $this->now + 60], $this->stored());
        self::assertSame(61, $this->cache->entries[self::KEY]['ttl']);
        foreach (['create', 'order', 'emergency', 'ccies', 'price'] as $path) {
            $denied = self::denial(fn () => $this->guard($limits)->reserve($path));
            self::assertSame('backoff', $denied['reason'] ?? null, $path);
            self::assertSame($this->now + 60, $denied['backoff_until'] ?? null, $path);
        }
        $this->now += 60;
        $this->guard($limits)->reserve('create');
        $this->guard($limits)->reserve('order');
    }

    public function testALaterShorterWaitNeverShortensAStoredStandOffAndBothKindsAreKept(): void
    {
        $this->guard()->markRateLimited('create', 200);
        $this->now += 10;
        // Another request is told to wait five seconds: the 200 stand.
        $this->guard()->markRateLimited('create', 5);
        self::assertSame(['create_backoff_until' => 1_700_000_200], $this->stored());
        self::assertSame(191, $this->cache->entries[self::KEY]['ttl']);
        // A 429 on another call stops every call; the create stand-off stays next to it.
        $this->guard()->markRateLimited('order', 30);
        self::assertSame(['backoff_until' => 1_700_000_040, 'create_backoff_until' => 1_700_000_200], $this->stored());
        self::assertSame(1_700_000_040, self::denial(fn () => $this->guard()->reserve('order'))['backoff_until'] ?? null);
        self::assertSame(1_700_000_040, self::denial(fn () => $this->guard()->reserve('create'))['backoff_until'] ?? null);
        // A longer wait does move the end out.
        $this->guard()->markRateLimited('order', 60);
        self::assertSame(1_700_000_070, $this->stored()['backoff_until']);
        $this->now = 1_700_000_070;
        $this->guard()->reserve('order');
        self::assertSame(1_700_000_200, self::denial(fn () => $this->guard()->reserve('create'))['backoff_until'] ?? null);
        // A stand-off that has ended is not written back.
        $this->guard()->markRateLimited('create', 1);
        self::assertSame(['create_backoff_until' => 1_700_000_200], $this->stored());
    }

    public function testTheCountsAreNeverShared(): void
    {
        $limits = SwapProviderLimits::fixedFloat();
        $busy = $this->guard($limits);
        for ($i = 0; $i < 3; $i++) {
            $busy->reserve('create');
        }
        self::assertSame('exhausted', self::denial(static fn () => $busy->reserve('create'))['reason'] ?? null);
        self::assertSame([], $this->cache->entries, 'reaching the per-minute limit stores nothing');
        // The next request starts with fresh counts.
        $next = $this->guard($limits);
        for ($i = 0; $i < 3; $i++) {
            $next->reserve('create');
        }
        // A stand-off stored by a guard that has counted calls does not hand its counts or window on either.
        $counted = $this->guard();
        for ($i = 0; $i < 5; $i++) {
            $counted->reserve('create');
            $counted->reserve('order');
        }
        $counted->markRateLimited('create', 90);
        self::assertSame(['create_backoff_until' => $this->now + 90], $this->stored());
        $afterIt = $this->guard();
        for ($i = 0; $i < 30; $i++) {
            $afterIt->reserve('order');
        }
        $this->now += 90;
        for ($i = 0; $i < 30; $i++) {
            $afterIt->reserve('create');
        }
    }

    public function testAStoredEndTooFarAwayOrNotOursIsNoStandOff(): void
    {
        $lightning = SwapProviderLimits::lightningSwap();
        $fixedFloat = SwapProviderLimits::fixedFloat();
        $ignored = [
            'further than the longest stand-off' => [$lightning, json_encode(['create_backoff_until' => $this->now + 301])],
            'an all-call end further than the longest' => [$lightning, json_encode(['backoff_until' => $this->now + 301])],
            'further than an hour for FixedFloat' => [$fixedFloat, json_encode(['backoff_until' => $this->now + 3_601])],
            'a year away' => [$fixedFloat, json_encode(['backoff_until' => $this->now + 31_536_000, 'create_backoff_until' => PHP_INT_MAX])],
            'already over' => [$lightning, json_encode(['backoff_until' => $this->now, 'create_backoff_until' => $this->now - 5])],
            'not JSON' => [$lightning, 'wait a while'],
            'an empty value' => [$lightning, ''],
            'a JSON string' => [$lightning, '"1700000100"'],
            'a JSON number' => [$lightning, '1700000100'],
            'a list' => [$lightning, '[1700000100, 1700000100]'],
            'a string end' => [$lightning, '{"backoff_until":"1700000100","create_backoff_until":"1700000100"}'],
            'a fractional end' => [$lightning, '{"backoff_until":1700000100.5,"create_backoff_until":1.7000001e9}'],
            'null ends' => [$lightning, '{"backoff_until":null,"create_backoff_until":null}'],
            'a nested end' => [$lightning, '{"backoff_until":{"until":1700000100},"create_backoff_until":[1700000100]}'],
            'another entry' => [$lightning, '{"value":"{}","fetched_at":1700000000}'],
        ];
        foreach ($ignored as $name => [$limits, $value]) {
            $this->store((string) $value);
            $guard = $this->guard($limits);
            $guard->assertAvailable('create');
            $guard->reserve('create');
            $guard->reserve('order');
        }
        // The longest stand-off the profile ever sets is honored.
        $this->store((string) json_encode(['create_backoff_until' => $this->now + 300]));
        self::assertSame($this->now + 300, self::denial(fn () => $this->guard($lightning)->reserve('create'))['backoff_until'] ?? null);
        $this->store((string) json_encode(['backoff_until' => $this->now + 3_600]));
        self::assertSame($this->now + 3_600, self::denial(fn () => $this->guard($fixedFloat)->reserve('order'))['backoff_until'] ?? null);
        // A damaged entry is replaced by the next real stand-off, not merged into it.
        $this->store((string) json_encode(['backoff_until' => $this->now + 31_536_000]));
        $this->guard($lightning)->markRateLimited('create', 12);
        self::assertSame(['create_backoff_until' => $this->now + 12], $this->stored());
    }

    public function testACacheThatThrowsNeverRaisesAndNeverRefuses(): void
    {
        foreach ([[true, true], [true, false], [false, true]] as [$failReads, $failWrites]) {
            $cache = new class ($failReads, $failWrites) implements SharedCache {
                public int $reads = 0;
                public int $writes = 0;
                /** @var array<string, string> */
                public array $entries = [];

                public function __construct(private readonly bool $failReads, private readonly bool $failWrites)
                {
                }

                public function get(string $key): ?string
                {
                    $this->reads++;
                    if ($this->failReads) {
                        throw new \RuntimeException('the cache is down');
                    }
                    return $this->entries[$key] ?? null;
                }

                public function set(string $key, string $value, int $ttlSeconds): void
                {
                    $this->writes++;
                    if ($this->failWrites) {
                        throw new \RuntimeException('the cache is read-only');
                    }
                    $this->entries[$key] = $value;
                }
            };
            $guard = $this->guard(null, $cache);
            $guard->reserve('create');
            $guard->markRateLimited('create', 30);
            self::assertGreaterThan(0, $cache->reads);
            self::assertSame(1, $cache->writes);
            // The process that was told still stands off, as it did before there was a cache.
            self::assertSame($this->now + 30, self::denial(static fn () => $guard->reserve('create'))['backoff_until'] ?? null);
            $guard->reserve('order');
            // The next request never learned of the stand-off, and the cache's failure refuses nothing by itself.
            $next = $this->guard(null, $cache);
            $next->assertAvailable('create');
            $next->reserve('create');
            $next->markRateLimited('order');
        }
    }

    public function testWithoutASharedCacheAStandOffEndsWithTheProcessThatWasTold(): void
    {
        $told = $this->guard(null, false);
        $told->markRateLimited('create', 30);
        self::assertSame('backoff', self::denial(static fn () => $told->reserve('create'))['reason'] ?? null);
        $this->guard(null, false)->reserve('create');
        self::assertSame([], $this->cache->entries);
    }

    public function testTheStandOffSurvivesTheDefaultFileCache(): void
    {
        $directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'openreceive-test-' . bin2hex(random_bytes(6));
        try {
            // The file cache expires on the real clock, so this guard runs on it too.
            $guard = static fn (): WeightBudget => new WeightBudget('fixedfloat', static fn (): int => time(), SwapProviderLimits::fixedFloat(), new FileSharedCache($directory));
            $guard()->markRateLimited('create', 600);
            $denied = self::denial(static fn () => $guard()->assertAvailable('order'));
            self::assertSame('backoff', $denied['reason'] ?? null);
            self::assertEqualsWithDelta(time() + 600, $denied['backoff_until'] ?? 0, 2);
        } finally {
            foreach (glob($directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
                unlink($file);
            }
            @rmdir($directory);
        }
    }
}
