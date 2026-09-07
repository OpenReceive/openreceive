<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * Address checks for swap deposit/refund networks, shared with the JS and Ruby
 * engines through spec/test-vectors/swap-address.json. These are CHECKSUM
 * checks, not shape guards: a refund goes to whatever address the payer
 * typed, so a transposed character must be refused here rather than sent
 * somewhere unrecoverable. Tron is Base58Check (double-SHA-256 tail over the
 * 0x41-prefixed payload), Ethereum is verified against EIP-55 whenever the
 * address carries mixed case, and Solana must decode to exactly 32 bytes.
 */
final class SwapAddress
{
    public const ETH_ADDRESS_PATTERN = '/\A0x[0-9a-fA-F]{40}\z/';
    public const TRON_ADDRESS_PATTERN = '/\AT[1-9A-HJ-NP-Za-km-z]{33}\z/';
    public const SOLANA_ADDRESS_PATTERN = '/\A[1-9A-HJ-NP-Za-km-z]{32,44}\z/';
    private const TRON_ADDRESS_PREFIX = 0x41;
    private const BASE58CHECK_CHECKSUM_BYTES = 4;

    public static function isValidSolanaAddress(string $address): bool
    {
        if (preg_match(self::SOLANA_ADDRESS_PATTERN, $address) !== 1) {
            return false;
        }
        $decoded = Base58::decode($address);
        return $decoded !== null && count($decoded) === 32;
    }

    public static function isValidTronAddress(string $address): bool
    {
        if (preg_match(self::TRON_ADDRESS_PATTERN, $address) !== 1) {
            return false;
        }
        $decoded = Base58::decode($address);
        if ($decoded === null || count($decoded) !== 21 + self::BASE58CHECK_CHECKSUM_BYTES || $decoded[0] !== self::TRON_ADDRESS_PREFIX) {
            return false;
        }
        $payload = pack('C*', ...array_slice($decoded, 0, 21));
        $expected = array_values(unpack('C*', hash('sha256', hash('sha256', $payload, true), true)) ?: []);
        return array_slice($decoded, 21, self::BASE58CHECK_CHECKSUM_BYTES) === array_slice($expected, 0, self::BASE58CHECK_CHECKSUM_BYTES);
    }

    public static function isValidEthereumAddress(string $address): bool
    {
        if (preg_match(self::ETH_ADDRESS_PATTERN, $address) !== 1) {
            return false;
        }
        $body = substr($address, 2);
        $lowercase = strtolower($body);
        // No mixed case means no EIP-55 bits to verify.
        if ($body === $lowercase || $body === strtoupper($body)) {
            return true;
        }
        $digest = Keccak256::digest($lowercase);
        for ($index = 0; $index < 40; $index++) {
            $character = $lowercase[$index];
            if ($character < 'a' || $character > 'f') {
                continue;
            }
            $byte = ord($digest[intdiv($index, 2)]);
            $nibble = $index % 2 === 0 ? ($byte >> 4) : ($byte & 0x0f);
            if (($nibble >= 8) !== ($body[$index] === strtoupper($character))) {
                return false;
            }
        }
        return true;
    }

    public static function isValidForNetwork(string $network, string $address): bool
    {
        if (strlen($address) > 200 || preg_match('/\s/', $address) === 1) {
            return false;
        }
        return match ($network) {
            'ETH' => self::isValidEthereumAddress($address),
            'SOL' => self::isValidSolanaAddress($address),
            'TRX', 'TRON' => self::isValidTronAddress($address),
            // An unknown network has no rule to apply, so nothing may be accepted for it.
            default => false,
        };
    }

    /** USDT_ETH → ETH, USDT_TRON → TRX, SOL_SOL → SOL, else null. */
    public static function networkForPayInAsset(string $payInAsset): ?string
    {
        $parts = explode('_', $payInAsset);
        $suffix = strtoupper((string) end($parts));
        return match ($suffix) {
            'ETH' => 'ETH',
            'SOL' => 'SOL',
            'TRON', 'TRX' => 'TRX',
            default => null,
        };
    }

    public static function isValidForPayInAsset(string $payInAsset, string $address): bool
    {
        $network = self::networkForPayInAsset($payInAsset);
        if ($network === null) {
            $length = strlen($address);
            return $length >= 5 && $length <= 200 && preg_match('/\s/', $address) !== 1;
        }
        return self::isValidForNetwork($network, $address);
    }

    /** User-facing refund address error, or null when empty (callers keep required handling) or valid. Copy mirrors JS exactly. */
    public static function refundAddressError(string $payInAsset, string $address, string $networkLabel): ?string
    {
        $trimmed = trim($address);
        if ($trimmed === '' || self::isValidForPayInAsset($payInAsset, $trimmed)) {
            return null;
        }
        $network = self::networkForPayInAsset($payInAsset);
        if ($network === 'ETH') {
            return preg_match(self::ETH_ADDRESS_PATTERN, $trimmed) === 1
                ? "That {$networkLabel} address failed its checksum. Copy it again from your wallet."
                : "That doesn't look like an {$networkLabel} address. Use a 0x address.";
        }
        if ($network === 'TRX') {
            return preg_match(self::TRON_ADDRESS_PATTERN, $trimmed) === 1
                ? "That {$networkLabel} address failed its checksum. Copy it again from your wallet."
                : "That doesn't look like a {$networkLabel} address. Use an address starting with T.";
        }
        return "That doesn't look like a {$networkLabel} address. Check you pasted the full address.";
    }
}
