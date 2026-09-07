<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Swap\StateTable;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class SwapStateTest extends TestCase
{
    use VectorSupport;

    public function testTheProductionNormalizerMatchesTheSharedVectors(): void
    {
        $family = self::vector('swap-state');
        self::assertSame('fixedfloat', $family['provider']);
        foreach ($family['cases'] as $case) {
            $actual = StateTable::normalizeStatus(
                $case['status'],
                $case['emergency'] ?? [],
                $case['refund_tx_present'] ? 'refund-tx' : null,
            );
            self::assertSameRecord($case['expected'], $actual, $case['name']);
        }
    }
}
