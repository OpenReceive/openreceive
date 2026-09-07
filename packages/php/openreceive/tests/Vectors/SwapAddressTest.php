<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Swap\Keccak256;
use OpenReceive\Swap\SwapAddress;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class SwapAddressTest extends TestCase
{
    use VectorSupport;

    public function testChecksumValidationMatchesTheSharedVectors(): void
    {
        foreach (self::vector('swap-address')['cases'] as $case) {
            self::assertSame($case['expected']['valid'], SwapAddress::isValidForNetwork($case['network'], $case['address']), $case['name']);
        }
    }

    public function testKeccak256IsNotSha3(): void
    {
        // Known Keccak-256 vectors (Ethereum's hash of the empty string and of "abc").
        self::assertSame('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', Keccak256::hex(''));
        self::assertSame('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45', Keccak256::hex('abc'));
        self::assertNotSame(hash('sha3-256', 'abc'), Keccak256::hex('abc'));
        // A message longer than one rate block exercises multi-block absorption.
        self::assertSame(64, strlen(Keccak256::hex(str_repeat('a', 200))));
    }

    public function testRefundAddressErrorsUseTheSharedCopy(): void
    {
        self::assertNull(SwapAddress::refundAddressError('USDT_TRON', '', 'Tron'));
        self::assertSame(
            'That Tron address failed its checksum. Copy it again from your wallet.',
            SwapAddress::refundAddressError('USDT_TRON', 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg', 'Tron')
        );
        self::assertSame(
            "That doesn't look like an Ethereum address. Use a 0x address.",
            SwapAddress::refundAddressError('USDC_ETH', 'nope', 'Ethereum')
        );
        self::assertSame('TRX', SwapAddress::networkForPayInAsset('USDT_TRON'));
        self::assertNull(SwapAddress::networkForPayInAsset('XYZ_ABC'));
    }
}
