<?php

declare(strict_types=1);

namespace OpenReceive\Rates;

use Brick\Math\BigDecimal;
use OpenReceive\Http\HttpTransport;
use OpenReceive\Money\Money;
use OpenReceive\Support\Records;

/**
 * The built-in BTC price feed: static provider plus cached live feed with
 * primary/fallback failover. Constants mirror spec/data/rates/price-sources.json
 * (drift-checked by RatesTest) and the JS/Ruby engines.
 */
final class Rates
{
    public const PRICE_FEED_CACHE_SECONDS = 60;
    public const INVOICE_QUOTE_TTL_SECONDS = 600;
    /** A cache stamp this far in the future means the clock stepped backwards: stale, not "fresh until wall-clock catches up". */
    public const PRICE_FEED_CLOCK_SKEW_SECONDS = 5;
    public const PRICE_FEED_PRIMARY_TIMEOUT_MS = 5000;
    public const STATIC_PRICE_SOURCE_ID = 'static_mock';
    public const STATIC_BTC_FIAT_RATES = ['bitcoin' => ['usd' => '50000.00']];
    public const PRICE_FEED_VS_CURRENCIES = 'usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vnd,zar';
    public const SIMPLE_PRICE_BASE_URL = 'https://api.coingecko.com/api/v3/simple/price';
    public const PRIMARY_PRICE_FEED_URL = self::SIMPLE_PRICE_BASE_URL . '?ids=bitcoin&vs_currencies=' . self::PRICE_FEED_VS_CURRENCIES;
    public const FALLBACK_PRICE_FEED_URL = 'https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=' . self::PRICE_FEED_VS_CURRENCIES;
    public const PRICE_FEED_PRIMARY_URL_ENV = 'OPENRECEIVE_PRICE_FEED_PRIMARY_URL';
    public const PRICE_FEED_FALLBACK_URL_ENV = 'OPENRECEIVE_PRICE_FEED_FALLBACK_URL';

    public static function normalizeFiatCurrency(mixed $currency): string
    {
        if (!is_string($currency) || preg_match('/\A[A-Z]{3}\z/', $currency) !== 1) {
            throw new \InvalidArgumentException('fiat.currency must be an ISO 4217 uppercase code');
        }
        return strtolower($currency);
    }

    public static function staticBtcFiatPrice(string $currency): string
    {
        $rate = self::STATIC_BTC_FIAT_RATES['bitcoin'][self::normalizeFiatCurrency($currency)] ?? null;
        if ($rate === null) {
            throw new \InvalidArgumentException("unsupported static fiat currency: {$currency}");
        }
        return $rate;
    }

    /**
     * Strict select: every requested currency must be present and well formed.
     *
     * @param list<string> $currencies
     * @return array{bitcoin: array<string, string>}
     */
    public static function parseSimplePriceResponse(mixed $response, array $currencies): array
    {
        $bitcoin = Records::requireArray(Records::requireArray($response, 'price response')['bitcoin'] ?? null, 'bitcoin');
        $rates = [];
        foreach ($currencies as $currency) {
            $key = self::normalizeFiatCurrency($currency);
            $rates[$key] = self::normalizeBtcFiatRate($bitcoin[$key] ?? null, "bitcoin.{$key}");
        }
        return ['bitcoin' => $rates];
    }

    /**
     * Tolerant parse for caching the whole feed: keeps every well-formed currency, raises only when nothing usable.
     *
     * @return array{bitcoin: array<string, string>}
     */
    public static function parseAvailableSimplePriceResponse(mixed $response): array
    {
        $bitcoin = Records::requireArray(Records::requireArray($response, 'price response')['bitcoin'] ?? null, 'bitcoin');
        $rates = [];
        foreach ($bitcoin as $key => $value) {
            $rateKey = strtolower((string) $key);
            if (preg_match('/\A[a-z]{3}\z/', $rateKey) !== 1) {
                continue;
            }
            try {
                $rates[$rateKey] = self::normalizeBtcFiatRate($value, "bitcoin.{$key}");
            } catch (\InvalidArgumentException) {
                // Skip a currency the upstream returned in an unusable form.
            }
        }
        if ($rates === []) {
            throw new \InvalidArgumentException('price response contained no usable BTC fiat rates');
        }
        return ['bitcoin' => $rates];
    }

    /**
     * A JSON number or decimal string as a plain decimal string. Numbers are
     * expanded from their JSON text through BigDecimal (never via float
     * arithmetic); a float that arrived through json_decode is re-rendered
     * with 17 significant digits, the exact round-trip of its JSON source.
     */
    public static function normalizeBtcFiatRate(mixed $value, string $field): string
    {
        if (is_int($value)) {
            if ($value <= 0) {
                throw new \InvalidArgumentException("{$field} must be a positive number");
            }
            return (string) $value;
        }
        if (is_float($value)) {
            if (!is_finite($value) || $value <= 0) {
                throw new \InvalidArgumentException("{$field} must be a positive number");
            }
            $normalized = self::numberToPlainDecimalString($value);
            Money::decimal($normalized, $field);
            return $normalized;
        }
        if (is_string($value)) {
            Money::decimal($value, $field);
            return $value;
        }
        throw new \InvalidArgumentException("{$field} must be a number or decimal string");
    }

    /**
     * Plain decimal notation (never exponent form) for a JSON number, matching
     * the JS numberToPlainDecimalString: the float's shortest round-trip text
     * (what json_encode emits) is expanded through BigDecimal, never through
     * float arithmetic.
     */
    public static function numberToPlainDecimalString(float|int $value): string
    {
        if (is_int($value)) {
            return (string) $value;
        }
        $shortest = json_encode($value);
        $decimal = BigDecimal::of($shortest === false ? sprintf('%.17G', $value) : $shortest)->strippedOfTrailingZeros();
        return $decimal->getScale() <= 0 ? (string) $decimal->toBigInteger() : (string) $decimal;
    }

    /**
     * Host-side helper: non-empty URL overrides from the well-known env names.
     *
     * @param array<string, mixed> $env
     * @return array{primary_url: ?string, fallback_url: ?string}
     */
    public static function readPriceFeedUrlOverrides(array $env): array
    {
        $presence = static function (mixed $value): ?string {
            $text = trim(is_scalar($value) ? (string) $value : '');
            return $text === '' ? null : $text;
        };
        return [
            'primary_url' => $presence($env[self::PRICE_FEED_PRIMARY_URL_ENV] ?? null),
            'fallback_url' => $presence($env[self::PRICE_FEED_FALLBACK_URL_ENV] ?? null),
        ];
    }

    /** @param list<string> $currencies @param (callable(): int)|null $clock */
    public static function createCachedLivePriceFeed(
        array $currencies,
        ?HttpTransport $http = null,
        ?callable $clock = null,
        ?int $cacheSeconds = null,
        ?string $primaryUrl = null,
        ?string $fallbackUrl = null,
        ?int $primaryTimeoutMs = null,
    ): CachedPriceFeed {
        return new CachedPriceFeed(
            $currencies,
            new HttpSimplePriceProvider($primaryUrl ?? self::PRIMARY_PRICE_FEED_URL, 'primary', $http, $primaryTimeoutMs ?? self::PRICE_FEED_PRIMARY_TIMEOUT_MS),
            new HttpSimplePriceProvider($fallbackUrl ?? self::FALLBACK_PRICE_FEED_URL, 'fallback', $http),
            $cacheSeconds,
            $clock,
        );
    }
}
