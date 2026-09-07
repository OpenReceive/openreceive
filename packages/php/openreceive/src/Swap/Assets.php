<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Generated\Tables;

/**
 * The pay-in asset catalog is kernel vocabulary (spec/data/kernel-tables.json)
 * rendered into Generated\Tables; this class adds the lookups and the provider
 * network matching the FixedFloat provider uses to map /ccies rows.
 */
final class Assets
{
    public const PAY_IN_ASSETS = Tables::SWAP_PAY_IN_ASSETS;
    public const ASSET_INFO = Tables::SWAP_ASSET_INFO;

    public static function isPayInAsset(mixed $value): bool
    {
        return is_string($value) && in_array($value, self::PAY_IN_ASSETS, true);
    }

    /** @return array{pay_in_asset: string, label: string, network_label: string, coin: string, network: string} */
    public static function info(string $payInAsset): array
    {
        if (!isset(self::ASSET_INFO[$payInAsset])) {
            throw new \InvalidArgumentException("unknown pay-in asset {$payInAsset}");
        }
        return self::ASSET_INFO[$payInAsset];
    }

    /** @return list<array{pay_in_asset: string, label: string, network_label: string, coin: string, network: string}> */
    public static function listInfo(): array
    {
        return array_map(static fn (string $asset): array => self::ASSET_INFO[$asset], self::PAY_IN_ASSETS);
    }

    public static function normalizeNetwork(mixed $value): string
    {
        return preg_replace('/[^A-Z0-9]+/', '', strtoupper(is_scalar($value) ? (string) $value : '')) ?? '';
    }

    public static function networkMatches(string $expected, mixed $actual): bool
    {
        $normalizedExpected = self::normalizeNetwork($expected);
        $normalizedActual = self::normalizeNetwork($actual);
        if ($normalizedActual === $normalizedExpected) {
            return true;
        }
        return match ($normalizedExpected) {
            'TRX' => in_array($normalizedActual, ['TRON', 'TRC20', 'TRC'], true),
            'ETH' => in_array($normalizedActual, ['ETHEREUM', 'ERC20', 'ERC'], true),
            'SOL' => $normalizedActual === 'SOLANA',
            default => false,
        };
    }

    public static function isLightningNetwork(mixed $value): bool
    {
        return in_array(self::normalizeNetwork($value), ['LN', 'LIGHTNING', 'LIGHTNINGNETWORK', 'BTCLN', 'BTCBOLT11'], true);
    }
}
