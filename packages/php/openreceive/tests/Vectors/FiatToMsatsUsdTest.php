<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Money\Money;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class FiatToMsatsUsdTest extends TestCase
{
    use VectorSupport;

    public function testQuotesMatchTheSharedCeilToWholeSatRule(): void
    {
        $family = self::vector('fiat-to-msats.usd');
        foreach ($family['cases'] as $case) {
            self::assertSame($case['expected']['amount_sats'], Money::quoteFiatToSats($case['fiat']['value'], $family['btc_fiat_price']), $case['name']);
            self::assertSame($case['expected']['amount_msats'], Money::quoteFiatToMsats($case['fiat']['value'], $family['btc_fiat_price']), $case['name']);
        }
        foreach ($family['invalid_cases'] as $case) {
            try {
                $got = Money::quoteFiatToMsats($case['fiat']['value'], $family['btc_fiat_price']);
                self::fail("{$case['name']} was accepted (got {$got})");
            } catch (\InvalidArgumentException) {
                self::assertTrue(true);
            }
        }
    }

    public function testDirectAmountsResolveToWholeSats(): void
    {
        self::assertSame(1_000_000, Money::directToMsats('SATS', 1000));
        self::assertSame(1_000_000, Money::directToMsats('SAT', '1000'));
        self::assertSame(100_000_000, Money::directToMsats('BTC', '0.001'));
        $this->expectException(\InvalidArgumentException::class);
        Money::directToMsats('BTC', '0.000000001');
    }
}
