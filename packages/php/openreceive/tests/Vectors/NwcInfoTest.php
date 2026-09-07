<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Nwc\Info;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class NwcInfoTest extends TestCase
{
    use VectorSupport;

    public function testCapabilitySummariesMatchTheSharedVectors(): void
    {
        foreach (self::vector('nwc-info')['cases'] as $case) {
            $summary = Info::summarize($case['raw_info']);
            $expected = $case['expected'];
            self::assertSame($expected['methods'], $summary['methods'], $case['name']);
            self::assertSame($expected['encryption'], $summary['encryption'], $case['name']);
            self::assertSame($expected['spend_capability_advertised'], $summary['spend_capability_advertised'], $case['name']);
            self::assertSame($expected['receive_checkout_ready'], $summary['receive_checkout_ready'], $case['name']);
            // Same extraction the JS test uses: the warned method name is quoted inside each warning.
            $warned = [];
            foreach ($summary['warnings'] as $warning) {
                if (preg_match("/'([^']+)'/", $warning, $match) === 1) {
                    $warned[] = $match[1];
                }
            }
            self::assertSame($expected['warning_methods'], $warned, $case['name']);
        }
    }

    public function testAnAdvertisedListWithNoSpeakableModeIsNull(): void
    {
        self::assertNull(Info::chooseEncryptionMode(['nip99']));
        self::assertSame('nip44_v2', Info::chooseEncryptionMode(['NIP-44']));
    }
}
