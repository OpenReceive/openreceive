<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use Brick\Math\BigInteger;
use OpenReceive\Http\HttpTransport;
use OpenReceive\Http\TransportException;
use OpenReceive\Support\Records;

/**
 * The FixedFloat public XML rates export (GET /rates/fixed.xml): no API key,
 * no weight budget. OpenReceive keeps only Lightning-payout pairs that match
 * its pay-in asset list, in process memory, and derives indicative quotes and
 * min/max locally; /create remains authoritative. All amount math is exact
 * integer fixed-point on BigInteger — never binary floats.
 */
final class FixedFloatRates
{
    private const DECIMAL_PATTERN = '/\A[0-9]+(\.[0-9]+)?\z/';
    public const SATS_PER_BTC = 100_000_000;
    public const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
    /** How often a warm rates blob is refreshed from the bulk feed. */
    public const REFRESH_SECONDS = 15;
    public const MAX_STALE_SECONDS = self::REFRESH_SECONDS;

    public static function pairKey(string $from, string $to): string
    {
        return strtoupper(trim($from)) . ':' . strtoupper(trim($to));
    }

    public static function xmlPath(string $rateType = 'fixed'): string
    {
        return "/rates/{$rateType}.xml";
    }

    public static function ratesMetaKey(string $providerName, string $rateType = 'fixed'): string
    {
        return "swap_rates:{$providerName}:{$rateType}";
    }

    /**
     * @param callable(): int $now
     * @return array{fetched_at: int, pairs: array<string, array<string, string>>}
     */
    public static function fetchIndex(string $baseUrl, callable $now, HttpTransport $http, string $rateType = 'fixed', int $requestTimeoutMs = 10_000): array
    {
        $url = rtrim($baseUrl, '/') . self::xmlPath($rateType);
        try {
            $response = $http->request('GET', $url, ['Accept' => 'application/xml, text/xml, */*'], null, $requestTimeoutMs);
        } catch (TransportException $e) {
            throw new \RuntimeException($e->timedOut
                ? "FixedFloat rates {$rateType}.xml request timed out."
                : "FixedFloat rates {$rateType}.xml request failed before a response was received.", 0, $e);
        }
        if ($response['status'] < 200 || $response['status'] > 299) {
            throw new \RuntimeException("FixedFloat rates {$rateType}.xml failed with HTTP {$response['status']}.");
        }
        // Provider dumps include thousands of non-LN market pairs; payout is always Lightning.
        return ['fetched_at' => $now(), 'pairs' => self::retainLightningPayoutPairs(self::parseXml($response['body']))];
    }

    /** @param array<string, array<string, string>> $pairs @return array<string, array<string, string>> */
    public static function retainLightningPayoutPairs(array $pairs): array
    {
        return array_filter($pairs, static fn (array $pair): bool => Assets::isLightningNetwork($pair['to']));
    }

    /**
     * @param array{fetched_at: int, pairs: array<string, array<string, string>>} $index
     * @param list<string> $pairKeys
     * @return array{fetched_at: int, pairs: array<string, array<string, string>>}
     */
    public static function retainPairsForKeys(array $index, array $pairKeys): array
    {
        $pairs = [];
        foreach ($pairKeys as $key) {
            if (isset($index['pairs'][$key])) {
                $pairs[$key] = $index['pairs'][$key];
            }
        }
        return ['fetched_at' => $index['fetched_at'], 'pairs' => $pairs];
    }

    /** @return array<string, array<string, string>> */
    public static function parseXml(string $xml): array
    {
        $pairs = [];
        foreach (self::matchTags($xml, 'item') as $itemXml) {
            $fields = [];
            foreach (['from', 'to', 'in', 'out', 'amount', 'minamount', 'maxamount'] as $tag) {
                $fields[$tag] = self::readTagText($itemXml, $tag);
            }
            if (in_array(null, $fields, true)) {
                continue;
            }
            $pair = [
                'from' => trim((string) $fields['from']),
                'to' => trim((string) $fields['to']),
                'in' => self::stripCurrencySuffix((string) $fields['in']),
                'out' => self::stripCurrencySuffix((string) $fields['out']),
                'amount' => self::stripCurrencySuffix((string) $fields['amount']),
                'minamount' => self::stripCurrencySuffix((string) $fields['minamount']),
                'maxamount' => self::stripCurrencySuffix((string) $fields['maxamount']),
            ];
            $tofee = self::readTagText($itemXml, 'tofee');
            if ($tofee !== null) {
                $pair['tofee'] = trim($tofee);
            }
            $pairs[self::pairKey($pair['from'], $pair['to'])] = $pair;
        }
        return $pairs;
    }

    /**
     * The cache blob for an index (only fetched_at and pairs are kept).
     *
     * @param array<string, mixed> $index
     */
    public static function serializeIndex(array $index): string
    {
        return json_encode(['fetched_at' => $index['fetched_at'] ?? null, 'pairs' => $index['pairs'] ?? []], JSON_THROW_ON_ERROR);
    }

    /** @return array{fetched_at: int, pairs: array<string, array<string, string>>} */
    public static function deserializeIndex(string $value): array
    {
        $parsed = json_decode($value, true);
        $fetchedAt = is_array($parsed) ? ($parsed['fetched_at'] ?? null) : null;
        $rawPairs = is_array($parsed) ? ($parsed['pairs'] ?? null) : null;
        if (!is_int($fetchedAt) || !is_array($rawPairs)) {
            throw new \RuntimeException('Invalid FixedFloat rates cache blob.');
        }
        $pairs = [];
        foreach ($rawPairs as $key => $raw) {
            $pair = self::readStoredPair($raw);
            if ($pair !== null) {
                $pairs[(string) $key] = $pair;
            }
        }
        return ['fetched_at' => $fetchedAt, 'pairs' => $pairs];
    }

    /**
     * Indicative pay-in amount for a Lightning payout of the invoice amount:
     * pay_from = (invoice_btc + tofee_btc) × (in / out), rounded UP at 8
     * decimals so the UI never understates what /create will require.
     *
     * @param array<string, string> $pair
     */
    public static function quotePayAmount(array $pair, int $invoiceAmountMsats): ?string
    {
        if ($invoiceAmountMsats <= 0) {
            return null;
        }
        $rateIn = self::parsePositiveDecimal($pair['in'] ?? null);
        $rateOut = self::parsePositiveDecimal($pair['out'] ?? null);
        if ($rateIn === null || $rateOut === null) {
            return null;
        }
        $invoiceSats = intdiv($invoiceAmountMsats + 999, 1000);
        $tofeeSats = self::parseTofeeBtcSats($pair['tofee'] ?? null) ?? 0;
        $totalSats = BigInteger::of($invoiceSats + $tofeeSats);
        // ceil(total_sats × in / out) as an 8-decimal fixed-point integer of the from currency.
        $payAt8dp = self::ceilDiv(
            $totalSats->multipliedBy($rateIn[0])->multipliedBy($rateOut[1]),
            $rateIn[1]->multipliedBy($rateOut[0])
        );
        return self::formatDecimal($payAt8dp, BigInteger::of(self::SATS_PER_BTC), 8);
    }

    /**
     * XML from-side min/max mapped into invoice-side msats. Minimum rounds up,
     * maximum rounds down, so borderline invoices are never inside a range the
     * provider rejects.
     *
     * @param array<string, string> $pair
     * @return array<string, mixed>
     */
    public static function invoiceLimits(array $pair): array
    {
        $limits = ['minimum_pay_amount' => $pair['minamount'], 'maximum_pay_amount' => $pair['maxamount']];
        $minimum = self::payAmountToInvoiceMsats($pair, $pair['minamount'], true);
        $maximum = self::payAmountToInvoiceMsats($pair, $pair['maxamount'], false);
        if ($minimum !== null) {
            $limits['minimum_invoice_amount_msats'] = $minimum;
        }
        if ($maximum !== null) {
            $limits['maximum_invoice_amount_msats'] = $maximum;
        }
        return $limits;
    }

    /** -1/0/1, or null when either side is not a positive decimal. */
    public static function compareDecimalAmounts(mixed $left, mixed $right): ?int
    {
        $a = self::parsePositiveDecimal($left);
        $b = self::parsePositiveDecimal($right);
        if ($a === null || $b === null) {
            return null;
        }
        return $a[0]->multipliedBy($b[1])->compareTo($b[0]->multipliedBy($a[1]));
    }

    /** @param array<string, string> $pair */
    public static function payAmountToInvoiceMsats(array $pair, mixed $payAmount, bool $ceil): ?int
    {
        $pay = self::parsePositiveDecimal($payAmount);
        $rateIn = self::parsePositiveDecimal($pair['in'] ?? null);
        $rateOut = self::parsePositiveDecimal($pair['out'] ?? null);
        if ($pay === null || $rateIn === null || $rateOut === null) {
            return null;
        }
        $numerator = $pay[0]->multipliedBy($rateOut[0])->multipliedBy(self::SATS_PER_BTC)->multipliedBy($rateIn[1]);
        $denominator = $pay[1]->multipliedBy($rateOut[1])->multipliedBy($rateIn[0]);
        if (!$denominator->isPositive()) {
            return null;
        }
        $invoiceSats = $ceil ? self::ceilDiv($numerator, $denominator) : $numerator->quotient($denominator);
        if (!$invoiceSats->isPositive() || $invoiceSats->isGreaterThan(self::MAX_SAFE_INTEGER)) {
            return null;
        }
        $msats = $invoiceSats->multipliedBy(1000);
        return $msats->isGreaterThan(self::MAX_SAFE_INTEGER) ? null : $msats->toInt();
    }

    /** "0.0004967000 BTC" / "0.0005 BTCLN" → whole sats (ceil); non-BTC fees are ignored. */
    public static function parseTofeeBtcSats(mixed $tofee): ?int
    {
        if ($tofee === null) {
            return null;
        }
        if (preg_match('/\A([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?\z/', trim((string) $tofee), $match) !== 1) {
            return null;
        }
        $unit = strtoupper($match[2] ?? 'BTC');
        if (!in_array($unit, ['BTC', 'BTCLN'], true)) {
            return null;
        }
        $parsed = self::parsePositiveDecimal($match[1]);
        if ($parsed === null) {
            return null;
        }
        return self::ceilDiv($parsed[0]->multipliedBy(self::SATS_PER_BTC), $parsed[1])->toInt();
    }

    /**
     * [integer, scale] for a positive decimal string, else null.
     *
     * @return array{0: BigInteger, 1: BigInteger}|null
     */
    public static function parsePositiveDecimal(mixed $value): ?array
    {
        if (!is_string($value) || preg_match(self::DECIMAL_PATTERN, $value) !== 1) {
            return null;
        }
        [$whole, $fraction] = array_pad(explode('.', $value, 2), 2, '');
        $integer = BigInteger::of(ltrim($whole . $fraction, '0') === '' ? '0' : ltrim($whole . $fraction, '0'));
        if (!$integer->isPositive()) {
            return null;
        }
        return [$integer, BigInteger::of(10)->power(strlen($fraction))];
    }

    public static function formatDecimal(BigInteger $integer, BigInteger $scale, int $maxFractionDigits): string
    {
        $whole = $integer->quotient($scale);
        $fraction = $integer->remainder($scale);
        $targetScale = BigInteger::of(10)->power(max(0, $maxFractionDigits));
        if ($scale->isGreaterThan($targetScale)) {
            $divisor = $scale->quotient($targetScale);
            $remainder = $fraction->remainder($divisor);
            $fraction = $fraction->quotient($divisor);
            if ($remainder->isPositive()) {
                $fraction = $fraction->plus(1);
            }
            if ($fraction->isGreaterThanOrEqualTo($targetScale)) {
                return self::formatDecimal($whole->multipliedBy($targetScale)->plus($fraction), $targetScale, $maxFractionDigits);
            }
        } elseif ($scale->isLessThan($targetScale)) {
            $fraction = $fraction->multipliedBy($targetScale->quotient($scale));
        }
        $fractionText = rtrim(str_pad((string) $fraction, $maxFractionDigits, '0', STR_PAD_LEFT), '0');
        return $fractionText === '' ? (string) $whole : "{$whole}.{$fractionText}";
    }

    public static function ceilDiv(BigInteger $numerator, BigInteger $denominator): BigInteger
    {
        return $numerator->plus($denominator)->minus(1)->quotient($denominator);
    }

    private static function stripCurrencySuffix(string $value): string
    {
        return preg_match('/\A([0-9]+(?:\.[0-9]+)?)/', trim($value), $match) === 1 ? $match[1] : trim($value);
    }

    /** @return list<string> */
    private static function matchTags(string $xml, string $tag): array
    {
        preg_match_all("#<{$tag}\\b[^>]*>(.*?)</{$tag}>#is", $xml, $matches);
        return $matches[1];
    }

    private static function readTagText(string $xml, string $tag): ?string
    {
        if (preg_match("#<{$tag}\\b[^>]*>(.*?)</{$tag}>#is", $xml, $match) !== 1) {
            return null;
        }
        $text = trim($match[1]);
        return $text === '' ? null : $text;
    }

    /** @return array<string, string>|null */
    private static function readStoredPair(mixed $value): ?array
    {
        if (!Records::isRecord($value)) {
            return null;
        }
        $record = Records::asArray($value);
        $pair = [];
        foreach (['from', 'to', 'in', 'out', 'amount', 'minamount', 'maxamount'] as $key) {
            if (!is_string($record[$key] ?? null)) {
                return null;
            }
            $pair[$key] = $record[$key];
        }
        if (is_string($record['tofee'] ?? null)) {
            $pair['tofee'] = $record['tofee'];
        }
        return $pair;
    }
}
