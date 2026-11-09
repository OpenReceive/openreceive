<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Payments\Reconciliation;
use OpenReceive\Tests\Support\AttemptStateMachineRunner;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** The generated attempt-state-machine vectors, replayed against the real repository and reconciler. */
final class AttemptStateMachineTest extends TestCase
{
    use VectorSupport;

    /** @return iterable<string, array{0: array<string, mixed>}> */
    public static function sequences(): iterable
    {
        foreach (self::vector('attempt-state-machine')['sequences'] as $sequence) {
            yield $sequence['name'] => [$sequence];
        }
    }

    public function testTheVectorConstantsMatchTheEngine(): void
    {
        $family = self::vector('attempt-state-machine');
        self::assertSame($family['expiry_grace_seconds'], Reconciliation::EXPIRY_GRACE_SECONDS);
        self::assertSame($family['reuse_buffer_seconds'], \OpenReceive\Storage\SqlPaymentRepository::REUSE_BUFFER_SECONDS);
    }

    /** @param array<string, mixed> $sequence */
    #[DataProvider('sequences')]
    public function testSequence(array $sequence): void
    {
        $result = AttemptStateMachineRunner::runSequence($sequence);
        self::assertTrue($result['ok'], json_encode($result, JSON_THROW_ON_ERROR) . ' at step ' . json_encode($sequence['steps'][$result['step'] ?? 0] ?? null));
    }
}
