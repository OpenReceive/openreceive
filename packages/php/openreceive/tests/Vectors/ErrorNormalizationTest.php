<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Nwc\Errors;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class ErrorNormalizationTest extends TestCase
{
    use VectorSupport;

    public function testWalletFailuresNormalizeToCanonicalCodes(): void
    {
        foreach (self::vector('error-normalization')['cases'] as $case) {
            $actual = Errors::normalizeWalletError($case['raw_error']);
            foreach ($case['expected'] as $key => $value) {
                self::assertSame($value, $actual[$key] ?? null, "{$case['name']} {$key}");
            }
        }
    }

    public function testThrowablesNormalizeByShortClassNameAndChain(): void
    {
        $error = new \RuntimeException('Relay closed', 0, new \RuntimeException('connection refused'));
        $normalized = Errors::normalizeWalletError($error);
        self::assertSame('OTHER', $normalized['code']);
        self::assertSame('Relay closed', $normalized['message']);
        self::assertFalse($normalized['retryable']);

        $timeout = Errors::normalizeWalletError(new class ('slow') extends \RuntimeException {
            public function __construct(string $m)
            {
                parent::__construct($m);
            }
        });
        self::assertSame('OTHER', $timeout['code']);
        self::assertSame('TIMEOUT', Errors::normalizeWalletError('TIMED_OUT')['code']);
        self::assertSame('WALLET_UNAVAILABLE', Errors::normalizeWalletError(['name' => 'RelayConnectionError', 'message' => 'x'])['code']);
    }
}
