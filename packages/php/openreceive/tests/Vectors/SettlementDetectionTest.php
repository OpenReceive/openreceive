<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Settlement\Settlement;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class SettlementDetectionTest extends TestCase
{
    use VectorSupport;

    public function testTheFinalityRuleAndFourWayStatusMatchTheSharedVectors(): void
    {
        foreach (self::vector('settlement-detection')['cases'] as $case) {
            self::assertSame($case['expected']['settled'], Settlement::isSettled($case['transaction']), $case['name']);
            if (isset($case['expected']['status'])) {
                self::assertSame($case['expected']['status'], Settlement::status($case['transaction']), $case['name']);
            }
        }
    }
}
