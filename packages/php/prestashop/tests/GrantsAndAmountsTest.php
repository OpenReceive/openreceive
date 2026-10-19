<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Tests;

use PHPUnit\Framework\TestCase;
use PrestaShop\Module\OpenReceive\Amounts;
use PrestaShop\Module\OpenReceive\Grants;

/**
 * The cookie's list of orders a browser may pay, the checkout's token check,
 * and order totals as exact decimals.
 */
final class GrantsAndAmountsTest extends TestCase
{
    public function testAGrantListKeepsTheNewestOrdersOnce(): void
    {
        $value = '';
        foreach ([3, 5, 3, 7] as $order) {
            $value = Grants::add($value, $order);
        }
        $this->assertSame('5,3,7', $value);
        $this->assertTrue(Grants::allows($value, 3));
        $this->assertFalse(Grants::allows($value, 4));
        $this->assertFalse(Grants::allows($value, 0));

        for ($order = 100; $order < 100 + Grants::MAX + 5; $order++) {
            $value = Grants::add($value, $order);
        }
        $this->assertCount(Grants::MAX, Grants::parse($value));
        $this->assertFalse(Grants::allows($value, 7), 'the oldest grants fall off');
        $this->assertTrue(Grants::allows($value, 100 + Grants::MAX + 4));
    }

    public function testAGrantListIgnoresAnythingButOrderIds(): void
    {
        $this->assertSame([12, 9], Grants::parse('12,abc,,-3,0,9,1e3, 4'));
        $this->assertFalse(Grants::allows('1,2', -1));
    }

    public function testTheTokenMustMatchExactly(): void
    {
        $token = str_repeat('ab', 32);
        $this->assertTrue(Grants::tokenMatches($token, $token));
        $this->assertFalse(Grants::tokenMatches($token, strtoupper($token)));
        $this->assertFalse(Grants::tokenMatches($token, null));
        $this->assertFalse(Grants::tokenMatches($token, ''));
        // No token in the cookie yet matches nothing, not even an empty header.
        $this->assertFalse(Grants::tokenMatches('', ''));
    }

    public function testTotalsSumAndRoundAsDecimals(): void
    {
        $this->assertSame('12.50', Amounts::total(['12.500000'], 2));
        $this->assertSame('0.30', Amounts::total(['0.100000', '0.200000'], 2));
        $this->assertSame('10.01', Amounts::total(['10.005000'], 2));
        $this->assertSame('1235', Amounts::total(['1234.500000'], 0));
        $this->assertSame('7.000', Amounts::total(['7'], 3));
        $this->assertTrue(Amounts::isPositive('0.01'));
        $this->assertFalse(Amounts::isPositive('0.000000'));
    }

    public function testATotalMustBeANonNegativeDecimal(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Amounts::total(['-1.00'], 2);
    }
}
