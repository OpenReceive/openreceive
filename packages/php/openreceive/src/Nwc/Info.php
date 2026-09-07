<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Generated\Tables;
use OpenReceive\Support\Records;

/**
 * NIP-47 wallet service info normalization (the kind 13194 info payload or a
 * get_info result), ported from the JS summarizeWalletCapabilities and locked
 * to spec/test-vectors/nwc-info.json: method-name normalization, encryption
 * mode choice, spend-capability detection and receive readiness are identical
 * in every engine.
 */
final class Info
{
    public const REQUIRED_RECEIVE_METHODS = Tables::NWC_REQUIRED_RECEIVE_METHODS;
    public const SPEND_METHODS = Tables::NWC_SPEND_METHODS;

    /**
     * @return array{methods: list<string>, encryption: ?string, spend_capability_advertised: bool, receive_checkout_ready: bool, warnings: list<string>}
     */
    public static function summarize(mixed $rawInfo): array
    {
        $unwrapped = Requests::unwrap($rawInfo);
        $info = Records::asArray($unwrapped);
        $rawMethods = null;
        foreach (['methods', 'capabilities', 'supported_methods', 'supportedMethods'] as $key) {
            if (isset($info[$key])) {
                $rawMethods = $info[$key];
                break;
            }
        }
        if ($rawMethods === null && is_string($unwrapped)) {
            $rawMethods = $unwrapped;
        }
        $methods = array_map([self::class, 'normalizeMethodName'], self::stringList($rawMethods));
        $encryption = self::chooseEncryptionMode(
            self::stringList(array_key_exists('encryption', $info) ? $info['encryption'] : ($info['encryptions'] ?? null))
        );
        $spend = array_values(array_filter($methods, static fn (string $name): bool => in_array($name, self::SPEND_METHODS, true)));
        $missing = array_filter(self::REQUIRED_RECEIVE_METHODS, static fn (string $name): bool => !in_array($name, $methods, true));
        return [
            'methods' => $methods,
            'encryption' => $encryption,
            'spend_capability_advertised' => $spend !== [],
            'receive_checkout_ready' => $missing === [],
            'warnings' => array_map(
                static fn (string $name): string => "Wallet advertises spend method '{$name}'; OpenReceive checkout will not expose it.",
                $spend
            ),
        ];
    }

    /**
     * Preference order from the kernel table: nip44_v2 when advertised, nip04
     * when advertised or when nothing is advertised at all (the NIP-47
     * baseline), null when the list names no mode we speak so preflight can
     * fail loudly instead of failing cryptically at RPC time.
     *
     * @param list<string> $modes
     */
    public static function chooseEncryptionMode(array $modes): ?string
    {
        $normalized = array_map(static fn (string $mode): string => str_replace(['-', ' '], '_', strtolower($mode)), $modes);
        if (array_intersect($normalized, ['nip44_v2', 'nip44', 'nip_44']) !== []) {
            return 'nip44_v2';
        }
        if ($normalized === [] || in_array('nip04', $normalized, true) || in_array('nip_04', $normalized, true)) {
            return 'nip04';
        }
        return null;
    }

    /** @return list<string> */
    public static function stringList(mixed $value): array
    {
        if (is_array($value)) {
            $items = array_filter($value, 'is_string');
        } elseif (is_string($value)) {
            $items = preg_split('/[,\s]+/', $value) ?: [];
        } else {
            return [];
        }
        $items = array_map('trim', $items);
        return array_values(array_filter($items, static fn (string $item): bool => $item !== ''));
    }

    public static function normalizeMethodName(string $value): string
    {
        $snake = preg_replace('/([a-z0-9])([A-Z])/', '$1_$2', trim($value)) ?? trim($value);
        return strtolower(preg_replace('/[-\s]+/', '_', $snake) ?? $snake);
    }
}
