<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Payments\Reconciliation;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class AttemptReconciliationTest extends TestCase
{
    use VectorSupport;

    public function testClosureDecisionsMatchTheSharedVectors(): void
    {
        $family = self::vector('attempt-reconciliation');
        self::assertSame($family['expiry_grace_seconds'], Reconciliation::EXPIRY_GRACE_SECONDS, 'attempt expiry grace drifted from the shared vectors');
        foreach ($family['vectors'] as $vector) {
            $actual = Reconciliation::transition(
                $vector['attempt']['expires_at'],
                $vector['status'],
                $vector['observed_at'],
                $vector['transaction_state'] ?? null,
            );
            self::assertSame($vector['expected'], $actual, $vector['name']);
        }
    }

    public function testAnUnknownStatusIsAProgrammingError(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Reconciliation::transition(2000, 'settled', 3000);
    }
}
