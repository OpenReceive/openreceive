<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Swap\LscUri;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class LscUriTest extends TestCase
{
    use VectorSupport;

    public function testValidAndInvalidUrisMatchTheSharedVectors(): void
    {
        $family = self::vector('lsc-uri');
        foreach ($family['valid'] as $case) {
            self::assertSameRecord($case['expected'], LscUri::parse($case['uri']), $case['name']);
        }
        foreach ($family['invalid'] as $case) {
            try {
                LscUri::parse($case['uri']);
                self::fail("{$case['name']} was accepted");
            } catch (\InvalidArgumentException) {
                self::assertTrue(true);
            }
        }
    }

    public function testEnvironmentReadingKeepsPrimaryFirstAndRefusesDuplicateIds(): void
    {
        $connections = LscUri::readEnvironment([
            'LSC_URI_PRIMARY' => 'lightning+swapconnect://ff.example/?key=k&secret=s',
            'LSC_URI_BACKUP' => 'lightning+swapconnect://swap.example/v1?key=k2&secret=s2',
        ]);
        self::assertSame(['ff-example', 'swap-example-v1'], array_column($connections, 'provider_id'));
        self::assertSame([], LscUri::readEnvironment([]));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('LSC_URI_BACKUP is invalid');
        LscUri::readEnvironment([
            'LSC_URI_PRIMARY' => 'lightning+swapconnect://ff.example/?key=k&secret=s',
            'LSC_URI_BACKUP' => 'lightning+swapconnect://ff.example/?key=k2&secret=s2',
        ]);
    }
}
