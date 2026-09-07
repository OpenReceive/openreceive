<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Money\Money;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class AmountBoundariesTest extends TestCase
{
    use VectorSupport;

    public function testBoundedMsatsAcceptanceMatchesTheSharedVectors(): void
    {
        $family = self::vector('amount-boundaries');
        self::assertSame($family['amount_msats']['minimum'], \OpenReceive\Kernel::MIN_AMOUNT_MSATS);
        self::assertSame($family['amount_msats']['maximum'], \OpenReceive\Kernel::MAX_AMOUNT_MSATS);
        foreach ($family['cases'] as $case) {
            try {
                Money::boundedMsats($case['amount_msats']);
                $valid = true;
            } catch (\InvalidArgumentException) {
                $valid = false;
            }
            self::assertSame($case['valid'], $valid, $case['name']);
        }
    }

    public function testFloatsAreRefusedAsAmounts(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Money::boundedMsats(1000.5);
    }
}
