<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Http\HttpTransport;

/** Provider factories from LSC connections, and the payer-facing availability copy shared with JS and Ruby. */
final class Swap
{
    /**
     * One provider per parsed LSC connection, in env order (primary first, backup second).
     *
     * @param list<array{provider_id: string, base_url: string, key: string, secret: string}> $connections
     * @param (callable(): int)|null $now
     * @return list<FixedFloatProvider>
     */
    public static function providersFromConnections(array $connections, ?HttpTransport $http = null, ?callable $now = null): array
    {
        return array_map(static fn (array $connection): FixedFloatProvider => new FixedFloatProvider(
            key: $connection['key'],
            secret: $connection['secret'],
            id: $connection['provider_id'],
            baseUrl: $connection['base_url'],
            http: $http,
            now: $now,
        ), $connections);
    }

    /** @param array<string, mixed> $env @param (callable(): int)|null $now @return list<FixedFloatProvider> */
    public static function providersFromEnvironment(array $env, ?HttpTransport $http = null, ?callable $now = null): array
    {
        return self::providersFromConnections(LscUri::readEnvironment($env), $http, $now);
    }

    public static function availabilityMessage(string $reason): string
    {
        return match ($reason) {
            'amount_too_small' => 'This invoice is below the provider minimum.',
            'amount_too_large' => 'This invoice is above the provider maximum.',
            'provider_rate_limited' => 'The swap provider is rate limited.',
            'provider_unreachable' => 'The swap provider is temporarily unreachable.',
            default => 'This payment route is temporarily unavailable.',
        };
    }

    /** Map a quote-path failure to a SwapAvailabilityReason. */
    public static function classifyQuoteError(\Throwable $error): string
    {
        if ($error instanceof WeightBudgetError) {
            return 'provider_rate_limited';
        }
        if ($error instanceof FixedFloatApiError) {
            if ($error->kind === 'rate_limited' || $error->httpStatus === 429) {
                return 'provider_rate_limited';
            }
            if (in_array($error->kind, ['timeout', 'network', 'invalid_json'], true) || ($error->httpStatus !== null && $error->httpStatus >= 500)) {
                return 'provider_unreachable';
            }
            $message = strtolower($error->fixedfloatMessage ?? $error->getMessage());
            if (self::isAmountTooSmallMessage($message)) {
                return 'amount_too_small';
            }
            if (self::isAmountTooLargeMessage($message)) {
                return 'amount_too_large';
            }
            return 'pair_temporarily_unavailable';
        }
        $message = strtolower($error->getMessage());
        if (str_contains($message, 'rate') || str_contains($message, '429') || str_contains($message, 'weight budget')) {
            return 'provider_rate_limited';
        }
        if (str_contains($message, 'fetch') || str_contains($message, 'network') || str_contains($message, 'timeout')) {
            return 'provider_unreachable';
        }
        if (self::isAmountTooSmallMessage($message)) {
            return 'amount_too_small';
        }
        if (self::isAmountTooLargeMessage($message)) {
            return 'amount_too_large';
        }
        return 'pair_temporarily_unavailable';
    }

    private static function isAmountTooSmallMessage(string $message): bool
    {
        return str_contains($message, 'min') || str_contains($message, 'small') || str_contains($message, 'out of limits') || str_contains($message, 'limit_min');
    }

    private static function isAmountTooLargeMessage(string $message): bool
    {
        return str_contains($message, 'max') || str_contains($message, 'large') || str_contains($message, 'limit_max');
    }
}
