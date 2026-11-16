<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Server\ClientIp;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * rate-limit-address.json: the per-IP limit never counts a proxy's or the
 * host's own address. Every case is classified as the raw value and as the
 * bucket the limiter counts and stores, and the two must agree.
 */
final class RateLimitAddressTest extends TestCase
{
    use VectorSupport;

    public function testEveryAddressClassifiesTheSameRawAndBucketed(): void
    {
        $family = self::vector('rate-limit-address');
        self::assertGreaterThan(30, count($family['cases']));
        foreach ($family['cases'] as $case) {
            self::assertSame($case['expected']['payer'], ClientIp::isPayer($case['address']), $case['name']);
            self::assertSame($case['expected']['payer'], ClientIp::isPayer(ClientIp::bucket($case['address'])), "{$case['name']} (bucketed)");
            // What the engine hands the limiter: trimmed, lower-cased, bucketed.
            self::assertSame($case['expected']['payer'], ClientIp::isPayer((string) ClientIp::attributed($case['address'])), "{$case['name']} (attributed)");
        }
    }
}
