<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Server\ClientIp;
use PHPUnit\Framework\TestCase;

/** Mirrors the JS clientIpBucket cases in tests/rate-limit.test.mjs. */
final class ClientIpTest extends TestCase
{
    public function testBucketsMatchTheJsRules(): void
    {
        self::assertSame('203.0.113.7', ClientIp::bucket('203.0.113.7'));
        self::assertSame('203.0.113.7', ClientIp::bucket('::ffff:203.0.113.7'));
        self::assertSame('2001:db8:1:2::/64', ClientIp::bucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
        self::assertSame('2001:db8:1:2::/64', ClientIp::bucket('2001:DB8:1:2::1'));
        self::assertSame('2001:db8:1:2::/64', ClientIp::bucket('2001:db8:1:2::/64'), 'idempotent');
        self::assertSame('fe80:0:0:0::/64', ClientIp::bucket('fe80::1%eth0'));
        self::assertSame('0:0:0:0::/64', ClientIp::bucket('::1'));
        self::assertSame('64:ff9b:0:0::/64', ClientIp::bucket('64:ff9b::192.0.2.33'));
        self::assertSame('not-an-ip:zz', ClientIp::bucket('not-an-ip:zz'), 'unparsable input passes through');
        self::assertNull(ClientIp::attributed('   '));
        self::assertNull(ClientIp::attributed(null));
        self::assertSame('203.0.113.7', ClientIp::attributed(' 203.0.113.7 '));
    }
}
