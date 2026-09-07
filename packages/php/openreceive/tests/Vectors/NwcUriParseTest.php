<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Nwc\NwcUriParseError;
use OpenReceive\Nwc\Uri;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class NwcUriParseTest extends TestCase
{
    use VectorSupport;

    public function testParseResultsAndErrorCodesMatchTheSharedVectors(): void
    {
        foreach (self::vector('nwc-uri-parse')['cases'] as $case) {
            if (isset($case['expected_error'])) {
                try {
                    Uri::parse($case['uri']);
                    self::fail("{$case['name']} did not raise");
                } catch (NwcUriParseError $e) {
                    self::assertSame($case['expected_error'], $e->errorCode, $case['name']);
                    self::assertStringNotContainsString('secret=b', (string) $e->redacted);
                }
                continue;
            }
            $parsed = Uri::parse($case['uri']);
            $expected = $case['expected'];
            self::assertSame($expected['wallet_pubkey'], $parsed['wallet_pubkey'], $case['name']);
            self::assertSame($expected['relays'], $parsed['relays'], $case['name']);
            self::assertSame($expected['secret_present'], $parsed['client_secret'] !== '', $case['name']);
            self::assertSame($expected['lud16'], $parsed['lud16'] ?? null, $case['name']);
            self::assertSame($expected['redacted'], $parsed['redacted'], $case['name']);
        }
    }

    public function testRedactionDecodesThePercentEncodedKey(): void
    {
        $redacted = Uri::redact('nostr+walletconnect://abc?relay=wss%3A%2F%2Fr.example&%73ecret=deadbeef#frag');
        self::assertSame('nostr+walletconnect://abc?relay=wss%3A%2F%2Fr.example&%73ecret=[REDACTED]#frag', $redacted);
    }
}
