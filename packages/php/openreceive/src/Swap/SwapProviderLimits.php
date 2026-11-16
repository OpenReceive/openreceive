<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * What one provider allows an API key per window, as far as the request guard
 * (WeightBudget) needs to know it. The guard exists so a busy site stays
 * inside the provider's limits; the provider remains the authority and its
 * 429 always wins. Port of the JS SwapProviderLimits; the numbers and the
 * host rule are pinned by the swap-provider-limits vector.
 */
final class SwapProviderLimits
{
    public const FIXEDFLOAT = 'fixedfloat';
    public const LIGHTNING_SWAP = 'lightning-swap';
    public const LIGHTNING_SWAP_HOST = 'lightning-swap.com';

    /**
     * @param string $profile whose published limits these are
     * @param int $softCap weight every call in one window may add up to
     * @param int $createGate weight a create may bring the window up to
     * @param int|null $createLimit creates per window, for a provider that counts them on their own
     * @param int $backoffSeconds stand-off after a 429 that names no wait
     * @param int $minBackoffSeconds shortest stand-off a 429's own wait is honored for
     * @param int $maxBackoffSeconds longest stand-off a 429's own wait is honored for
     * @param bool $createBackoffOnly true when the provider counts new swaps apart from its other calls, so a 429
     *                                answering a create stops creates only; status and refund calls for swaps that
     *                                already exist keep working
     */
    public function __construct(
        public readonly string $profile,
        public readonly int $softCap,
        public readonly int $createGate,
        public readonly int $createWeight,
        public readonly int $defaultWeight,
        public readonly ?int $createLimit,
        public readonly int $backoffSeconds,
        public readonly int $minBackoffSeconds,
        public readonly int $maxBackoffSeconds,
        public readonly bool $createBackoffOnly,
    ) {
    }

    /**
     * FixedFloat: 250 weight a minute per key, a create costs 50, and going
     * over blocks the key for longer each time. The guard stops well short:
     * three creates a minute, 200 weight in all. Also the default for a
     * provider this library does not know, because it is the stricter of the
     * two.
     */
    public static function fixedFloat(): self
    {
        return new self(
            profile: self::FIXEDFLOAT,
            softCap: WeightBudget::SOFT_CAP,
            createGate: WeightBudget::CREATE_GATE,
            createWeight: WeightBudget::CREATE_WEIGHT,
            defaultWeight: WeightBudget::DEFAULT_WEIGHT,
            createLimit: null,
            backoffSeconds: WeightBudget::BACKOFF_SECONDS,
            minBackoffSeconds: WeightBudget::BACKOFF_SECONDS,
            maxBackoffSeconds: 3_600,
            createBackoffOnly: false,
        );
    }

    /**
     * Lightning Swap: per account, 30 new swaps and 400 API calls a minute
     * once the account has completed a swap, every call counting as one. It
     * refuses with a 429 that says how long to wait and never blocks a key
     * for going over, so the guard sits at the limit itself. An account on
     * lower limits (one that has not completed a swap yet) is held to them by
     * the provider's own 429, which the guard then obeys.
     */
    public static function lightningSwap(): self
    {
        return new self(
            profile: self::LIGHTNING_SWAP,
            softCap: 400,
            createGate: 400,
            createWeight: 1,
            defaultWeight: 1,
            createLimit: 30,
            backoffSeconds: 60,
            minBackoffSeconds: 1,
            maxBackoffSeconds: 300,
            createBackoffOnly: true,
        );
    }

    /**
     * The limits to guard a provider API with, chosen by its HTTPS host:
     * lightning-swap.com or any subdomain of it, in any case. Every other
     * host, a look-alike and a value that is not a URL get the FixedFloat
     * limits.
     */
    public static function forBaseUrl(string $baseUrl): self
    {
        // parse_url is lenient where a browser-grade parser refuses; a value
        // with whitespace or a backslash is not a URL this library would call.
        $parts = preg_match('/[\s\\\\]/', $baseUrl) === 1 ? false : parse_url($baseUrl);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return self::fixedFloat();
        }
        $host = strtolower($parts['host']);
        return $host === self::LIGHTNING_SWAP_HOST || str_ends_with($host, '.' . self::LIGHTNING_SWAP_HOST)
            ? self::lightningSwap()
            : self::fixedFloat();
    }
}
