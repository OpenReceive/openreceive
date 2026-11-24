<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * How the request guard (WeightBudget) treats one provider. The provider
 * remains the authority: its 429 always starts a stand-off. Only FixedFloat's
 * own host also gets a local count (SwapProviderLocalBudget), because
 * FixedFloat blocks a key for going over; every other provider limits its own
 * accounts and says so with a 429. Port of the JS SwapProviderLimits; the
 * numbers and the host rule are pinned by the swap-provider-limits vector.
 */
final class SwapProviderLimits
{
    public const FIXEDFLOAT = 'fixedfloat';
    public const PROVIDER_ONLY = 'provider-only';
    public const FIXEDFLOAT_HOST = 'ff.io';

    /**
     * @param string $profile `fixedfloat` for FixedFloat's own host; `provider-only` for every other
     * @param SwapProviderLocalBudget|null $localBudget the per-window count, or null when the guard keeps none and
     *                                                  only obeys the provider's 429
     * @param int $backoffSeconds stand-off after a 429 that names no wait
     * @param int $minBackoffSeconds shortest stand-off a 429's own wait is honored for
     * @param int $maxBackoffSeconds longest stand-off a 429's own wait is honored for
     * @param bool $createBackoffOnly true when the provider counts new swaps apart from its other calls, so a 429
     *                                answering a create stops creates only; status and refund calls for swaps that
     *                                already exist keep working
     */
    public function __construct(
        public readonly string $profile,
        public readonly ?SwapProviderLocalBudget $localBudget,
        public readonly int $backoffSeconds,
        public readonly int $minBackoffSeconds,
        public readonly int $maxBackoffSeconds,
        public readonly bool $createBackoffOnly,
    ) {
    }

    /**
     * FixedFloat: 250 weight a minute per key, a create costs 50, and going
     * over blocks the key for longer each time. So the guard counts: 200
     * weight a minute in all, of which the calls that are not creates may use
     * 50. At least three creates a minute always fit, four when nothing else
     * ran. A 429 stops every call for at least a minute.
     */
    public static function fixedFloat(): self
    {
        return new self(
            profile: self::FIXEDFLOAT,
            localBudget: new SwapProviderLocalBudget(softCap: 200, nonCreateCap: 50, createWeight: 50, defaultWeight: 1),
            backoffSeconds: WeightBudget::BACKOFF_SECONDS,
            minBackoffSeconds: WeightBudget::BACKOFF_SECONDS,
            maxBackoffSeconds: 3_600,
            createBackoffOnly: false,
        );
    }

    /**
     * Every other provider (Lightning Swap, one this library does not know, a
     * test fake): no local count. The provider limits its own accounts and
     * says so with a 429; a count of this library's own could only refuse
     * payers the provider would have accepted. A 429 that answered a create
     * stops creates only, for the wait it names (1 to 300 seconds; a minute
     * when it names none). Lightning Swap answers this way: it counts new
     * swaps apart from its other calls, per account, and names the wait in
     * Retry-After.
     */
    public static function providerOnly(): self
    {
        return new self(
            profile: self::PROVIDER_ONLY,
            localBudget: null,
            backoffSeconds: 60,
            minBackoffSeconds: 1,
            maxBackoffSeconds: 300,
            createBackoffOnly: true,
        );
    }

    /**
     * The limits to guard a provider API with, chosen by its HTTPS host:
     * ff.io or any subdomain of it, in any case, is FixedFloat's. Every other
     * host, a look-alike and a value that is not a URL only obey the
     * provider's 429.
     */
    public static function forBaseUrl(string $baseUrl): self
    {
        // parse_url is lenient where a browser-grade parser refuses; a value
        // with whitespace or a backslash is not a URL this library would call.
        $parts = preg_match('/[\s\\\\]/', $baseUrl) === 1 ? false : parse_url($baseUrl);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host'])) {
            return self::providerOnly();
        }
        $host = strtolower($parts['host']);
        return $host === self::FIXEDFLOAT_HOST || str_ends_with($host, '.' . self::FIXEDFLOAT_HOST)
            ? self::fixedFloat()
            : self::providerOnly();
    }
}
