<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Http\HttpTransport;
use OpenReceive\Http\StreamTransport;
use OpenReceive\Rates\Rates;
use OpenReceive\Support\Records;

/**
 * The production FixedFloat(-compatible) swap provider: HMAC-signed API calls
 * over the injectable HTTP transport, quote/create/status/refund flows, and
 * the same order normalization as the JS and Ruby engines. The status → state
 * mapping itself is the generated decision table, interpreted by StateTable.
 */
final class FixedFloatProvider implements SwapProvider, SwapProviderRuntime
{
    public const DEFAULT_BASE_URL = 'https://ff.io';
    public const DEFAULT_CCIES_CACHE_SECONDS = 24 * 60 * 60;
    public const DEFAULT_RATES_CACHE_SECONDS = FixedFloatRates::REFRESH_SECONDS;
    public const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
    public const DEFAULT_DEPOSIT_WINDOW_SECONDS = 10 * 60;
    public const DEFAULT_SETTLEMENT_SLA_SECONDS = 15 * 60;
    /** Margin above deposit_window + settlement_sla: keeps the shadow invoice alive through a plausible 30-minute order. */
    public const DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS = 5 * 60;
    public const PROVIDER_ID_PATTERN = '/\A[a-z0-9][a-z0-9_-]{0,63}\z/';

    private readonly string $name;
    private readonly string $baseUrl;
    private readonly ?string $lightningCcy;
    private readonly HttpTransport $http;
    /** @var callable(): int */
    private $now;
    private readonly int $cacheSeconds;
    private readonly int $ratesCacheSeconds;
    private readonly int $requestTimeoutMs;
    private readonly int $invoiceExpirySeconds;
    private ?TransientCache $cache = null;
    private ?WeightBudget $weightBudget = null;
    /** @var (callable(array<string, mixed>): void)|null */
    private $apiRequestLogger = null;
    /** @var (callable(array<string, mixed>): void)|null */
    private $apiResponseLogger = null;

    /** @param (callable(): int)|null $now */
    public function __construct(
        private readonly string $key,
        private readonly string $secret,
        string $id = 'fixedfloat',
        ?string $baseUrl = null,
        ?string $lightningCcy = null,
        ?HttpTransport $http = null,
        ?callable $now = null,
        ?int $cacheSeconds = null,
        ?int $ratesCacheSeconds = null,
        ?int $requestTimeoutMs = null,
        ?int $invoiceExpirySeconds = null,
        ?int $depositWindowSeconds = null,
        ?int $settlementSlaSeconds = null,
        ?int $invoiceExpiryMarginSeconds = null,
    ) {
        $this->name = self::readProviderId($id);
        if (trim($key) === '') {
            throw new \InvalidArgumentException('FixedFloat-compatible API key must not be empty.');
        }
        if (trim($secret) === '') {
            throw new \InvalidArgumentException('FixedFloat-compatible API secret must not be empty.');
        }
        $this->baseUrl = rtrim($baseUrl ?? self::DEFAULT_BASE_URL, '/');
        $this->lightningCcy = trim((string) $lightningCcy) === '' ? null : trim((string) $lightningCcy);
        $this->http = $http ?? new StreamTransport();
        $this->now = $now ?? static fn (): int => time();
        $this->cacheSeconds = $cacheSeconds ?? self::DEFAULT_CCIES_CACHE_SECONDS;
        $this->ratesCacheSeconds = $ratesCacheSeconds ?? self::DEFAULT_RATES_CACHE_SECONDS;
        if ($this->ratesCacheSeconds <= 0) {
            throw new \InvalidArgumentException('FixedFloat ratesCacheSeconds must be a positive safe integer.');
        }
        $this->requestTimeoutMs = $requestTimeoutMs ?? self::DEFAULT_REQUEST_TIMEOUT_MS;
        if ($this->requestTimeoutMs <= 0) {
            throw new \InvalidArgumentException('FixedFloat requestTimeoutMs must be a positive safe integer.');
        }
        $depositWindow = $depositWindowSeconds ?? self::DEFAULT_DEPOSIT_WINDOW_SECONDS;
        $settlementSla = $settlementSlaSeconds ?? self::DEFAULT_SETTLEMENT_SLA_SECONDS;
        $expiryMargin = $invoiceExpiryMarginSeconds ?? self::DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS;
        foreach (['depositWindowSeconds' => $depositWindow, 'settlementSlaSeconds' => $settlementSla, 'invoiceExpiryMarginSeconds' => $expiryMargin] as $label => $value) {
            if ($value < 0) {
                throw new \InvalidArgumentException("FixedFloat {$label} must be a non-negative safe integer.");
            }
        }
        $minimumExpiry = $depositWindow + $settlementSla + $expiryMargin;
        $this->invoiceExpirySeconds = $invoiceExpirySeconds ?? $minimumExpiry;
        if ($this->invoiceExpirySeconds < $minimumExpiry) {
            throw new \InvalidArgumentException(
                "FixedFloat provider \"{$this->name}\": invoiceExpirySeconds ({$this->invoiceExpirySeconds}) must be at least {$minimumExpiry} = "
                . "deposit_window({$depositWindow}) + settlement_sla({$settlementSla}) + margin({$expiryMargin}). Omit invoiceExpirySeconds to auto-derive it, or raise it above that floor."
            );
        }
    }

    public static function readProviderId(string $id): string
    {
        $normalized = trim($id);
        if (preg_match(self::PROVIDER_ID_PATTERN, $normalized) !== 1) {
            throw new \InvalidArgumentException('FixedFloat-compatible provider id must use lowercase letters, numbers, underscores, or hyphens.');
        }
        return $normalized;
    }

    public function name(): string
    {
        return $this->name;
    }

    public function attachSwapCache(TransientCache $cache): void
    {
        $this->cache = $cache;
    }

    public function attachWeightBudget(WeightBudget $budget): void
    {
        $this->weightBudget = $budget;
    }

    /**
     * Sinks for outbound API requests/responses. The caller sanitizes nested
     * secrets (the order token on status/refund bodies); the API key and HMAC
     * signature live in headers and are never logged.
     *
     * @param callable(array<string, mixed>): void $logger
     */
    public function attachApiRequestLogger(callable $logger): void
    {
        $this->apiRequestLogger = $logger;
    }

    /** @param callable(array<string, mixed>): void $logger */
    public function attachApiResponseLogger(callable $logger): void
    {
        $this->apiResponseLogger = $logger;
    }

    public function supportedPayInAssets(): array
    {
        return array_keys($this->resolveCurrencies()['pay_in']);
    }

    public function payInAssetCatalog(): array
    {
        $resolution = $this->resolveCurrencies();
        // /ccies carries no amount limits; per-pair min/max come from the XML rates export.
        $rates = $this->resolveRatesIndex($resolution);
        $catalog = [];
        foreach ($resolution['pay_in'] as $payInAsset => $currency) {
            $pair = $rates['pairs'][FixedFloatRates::pairKey($currency['code'], $resolution['lightning']['code'])] ?? null;
            $catalog[] = $pair === null
                ? [
                    'pay_asset' => $payInAsset,
                    'available' => false,
                    'unavailable_reason' => 'pair_temporarily_unavailable',
                    'unavailable_message' => Swap::availabilityMessage('pair_temporarily_unavailable'),
                ]
                : ['pay_asset' => $payInAsset, ...FixedFloatRates::invoiceLimits($pair)];
        }
        return $catalog;
    }

    public function invoiceExpirySeconds(?string $payInAsset = null): int
    {
        return $this->invoiceExpirySeconds;
    }

    public function quote(string $payInAsset, int $invoiceAmountMsats): array
    {
        // Indicative quote from the process-local XML rates cache; /create is
        // still the binding rate. Rates refresh failures raise (fail closed) so
        // the service can skip this provider and try the next LSC connection.
        $resolution = $this->resolveCurrencies();
        $fromCcy = $this->requiredCurrency($resolution, $payInAsset);
        $rates = $this->resolveRatesIndex($resolution);
        try {
            $pair = $rates['pairs'][FixedFloatRates::pairKey($fromCcy, $resolution['lightning']['code'])] ?? null;
            if ($pair === null) {
                return $this->unavailableQuote($payInAsset, 'pair_temporarily_unavailable');
            }
            $limits = FixedFloatRates::invoiceLimits($pair);
            $payAmount = FixedFloatRates::quotePayAmount($pair, $invoiceAmountMsats);
            if ($payAmount === null) {
                return $this->unavailableQuote($payInAsset, 'pair_temporarily_unavailable', $limits);
            }
            $payBelowMin = FixedFloatRates::compareDecimalAmounts($payAmount, $limits['minimum_pay_amount']) === -1;
            $payAboveMax = FixedFloatRates::compareDecimalAmounts($payAmount, $limits['maximum_pay_amount']) === 1;
            $minimumMsats = $limits['minimum_invoice_amount_msats'] ?? null;
            $maximumMsats = $limits['maximum_invoice_amount_msats'] ?? null;
            $tooSmall = $payBelowMin || ($minimumMsats !== null && $invoiceAmountMsats < $minimumMsats);
            $tooLarge = $payAboveMax || ($maximumMsats !== null && $invoiceAmountMsats > $maximumMsats);
            if ($tooSmall || $tooLarge) {
                return $this->unavailableQuote($payInAsset, $tooSmall ? 'amount_too_small' : 'amount_too_large', $limits);
            }
            return ['pay_amount' => $payAmount, 'pay_asset' => $payInAsset, 'available' => true, 'provider' => $this->name, ...$limits];
        } catch (\Throwable $e) {
            return $this->unavailableQuote($payInAsset, Swap::classifyQuoteError($e));
        }
    }

    public function createSwap(string $payInAsset, string $bolt11, int $invoiceAmountMsats): array
    {
        $resolution = $this->resolveCurrencies();
        $fromCcy = $this->requiredCurrency($resolution, $payInAsset);
        $toCcy = $resolution['lightning']['code'];
        $data = $this->post('create', [
            'type' => 'fixed',
            'fromCcy' => $fromCcy,
            'toCcy' => $toCcy,
            'direction' => 'to',
            'amount' => self::amountMsatsToBtcString($invoiceAmountMsats),
            'toAddress' => $bolt11,
        ]);
        $order = $this->normalizeOrder($data, $payInAsset);
        if (isset($order['fee'])) {
            return $order;
        }
        // Backfill the USD equivalents from a best-effort /price lookup; a failure just leaves the fee off.
        $fee = $this->fetchOrderFee($fromCcy, $toCcy, $invoiceAmountMsats);
        return $fee === null ? $order : [...$order, 'fee' => $fee];
    }

    public function getStatus(array $order): array
    {
        $stored = Records::asArray($order);
        $data = $this->post('order', ['id' => self::requiredStoredString($stored, 'provider_order_id'), 'token' => self::requiredStoredString($stored, 'provider_token')]);
        $payInAsset = is_string($stored['pay_in_asset'] ?? null) ? $stored['pay_in_asset'] : '';
        return [...$stored, ...$this->normalizeOrder($data, $payInAsset, $stored)];
    }

    public function requestRefund(array $order, string $refundAddress): void
    {
        $stored = Records::asArray($order);
        $this->post('emergency', [
            'id' => self::requiredStoredString($stored, 'provider_order_id'),
            'token' => self::requiredStoredString($stored, 'provider_token'),
            'choice' => 'REFUND',
            'address' => $refundAddress,
        ]);
    }

    public static function amountMsatsToBtcString(int $amountMsats): string
    {
        if ($amountMsats <= 0) {
            throw new \InvalidArgumentException('invoice_amount_msats must be a positive safe integer.');
        }
        $sats = intdiv($amountMsats + 999, 1000);
        $whole = intdiv($sats, 100_000_000);
        $fraction = rtrim(str_pad((string) ($sats % 100_000_000), 8, '0', STR_PAD_LEFT), '0');
        return $fraction === '' ? (string) $whole : "{$whole}.{$fraction}";
    }

    /** @param array<string, mixed> $limits @return array<string, mixed> */
    private function unavailableQuote(string $payInAsset, string $reason, array $limits = []): array
    {
        return [
            'pay_asset' => $payInAsset,
            'available' => false,
            'unavailable_reason' => $reason,
            'unavailable_message' => Swap::availabilityMessage($reason),
            'provider' => $this->name,
            ...$limits,
        ];
    }

    /** @return array{currency: string, pay_in_fiat: string, payout_fiat: string}|null */
    private function fetchOrderFee(string $fromCcy, string $toCcy, int $invoiceAmountMsats): ?array
    {
        try {
            $data = $this->post('price', [
                'type' => 'fixed', 'fromCcy' => $fromCcy, 'toCcy' => $toCcy, 'direction' => 'to',
                'amount' => self::amountMsatsToBtcString($invoiceAmountMsats),
            ]);
            return self::readOrderFee(Records::asArray($data));
        } catch (\Throwable) {
            return null;
        }
    }

    /** @param array<string, mixed> $body */
    private function post(string $path, array $body): mixed
    {
        $this->weightBudget?->reserve($path);
        // An empty body is the JSON object `{}` (the signature covers the exact bytes sent).
        $bodyString = $body === [] ? '{}' : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        $this->logApiRequest($path, $body);
        try {
            $response = $this->http->request('POST', "{$this->baseUrl}/api/v2/{$path}", [
                'Content-Type' => 'application/json; charset=UTF-8',
                'X-API-KEY' => $this->key,
                'X-API-SIGN' => hash_hmac('sha256', $bodyString, $this->secret),
            ], $bodyString, $this->requestTimeoutMs);
        } catch (\Throwable $e) {
            $apiError = FixedFloatApiError::fromTransportError($path, $e);
            $this->logApiResponse($path, 0, false, null, $apiError->getMessage());
            throw $apiError;
        }
        $status = $response['status'];
        $ok = $status >= 200 && $status <= 299;
        $parsed = null;
        if (trim($response['body']) !== '') {
            $parsed = json_decode($response['body'], true);
            if ($parsed === null && json_last_error() !== JSON_ERROR_NONE) {
                $this->logApiResponse($path, $status, false, null, "FixedFloat {$path} returned invalid JSON.");
                throw new FixedFloatApiError($path, 'invalid_json', "FixedFloat {$path} returned invalid JSON.", $status);
            }
        }
        $parsed = is_array($parsed) ? $parsed : [];
        $this->logApiResponse($path, $status, $ok, $parsed['code'] ?? null, $parsed['msg'] ?? null, $parsed['data'] ?? null);
        if (!$ok) {
            if ($status === 429) {
                $this->weightBudget?->markRateLimited();
            }
            throw new FixedFloatApiError(
                $path,
                $status === 429 ? 'rate_limited' : 'http',
                self::formatApiErrorMessage($path, $status, $parsed['msg'] ?? null),
                $status,
                null,
                self::readString($parsed['msg'] ?? null),
            );
        }
        if (($parsed['code'] ?? null) !== 0) {
            $message = is_string($parsed['msg'] ?? null) ? $parsed['msg'] : "FixedFloat {$path} failed.";
            throw new FixedFloatApiError($path, 'api', $message, null, $parsed['code'] ?? null, self::readString($parsed['msg'] ?? null));
        }
        return $parsed['data'] ?? null;
    }

    /** @param array<string, mixed> $body */
    private function logApiRequest(string $path, array $body = []): void
    {
        try {
            if ($this->apiRequestLogger !== null) {
                ($this->apiRequestLogger)(['provider' => $this->name, 'path' => $path, 'body' => $body]);
            }
        } catch (\Throwable) {
            // Diagnostics never affect the call.
        }
    }

    private function logApiResponse(string $path, int $status, bool $ok, mixed $code = null, mixed $msg = null, mixed $data = null): void
    {
        try {
            if ($this->apiResponseLogger !== null) {
                ($this->apiResponseLogger)(['provider' => $this->name, 'path' => $path, 'status' => $status, 'ok' => $ok, 'code' => $code, 'msg' => $msg, 'data' => $data]);
            }
        } catch (\Throwable) {
            // Diagnostics never affect the call.
        }
    }

    /** @return array{fetched_at: int, pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} */
    private function resolveCurrencies(): array
    {
        if ($this->cache === null) {
            return $this->fetchCurrencyResolution();
        }
        /** @var array{fetched_at: int, pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} $resolution */
        $resolution = $this->cache->resolve(
            TransientCache::limitsMetaKey($this->name),
            $this->cacheSeconds,
            max(TransientCache::MAX_STALE_SECONDS, $this->cacheSeconds),
            fn (): array => $this->fetchCurrencyResolution(),
            static fn (array $resolution): string => json_encode($resolution, JSON_THROW_ON_ERROR),
            static fn (string $value): array => json_decode($value, true, 512, JSON_THROW_ON_ERROR),
        );
        return $resolution;
    }

    /** @param array{fetched_at: int, pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} $resolution @return array{fetched_at: int, pairs: array<string, array<string, string>>} */
    private function resolveRatesIndex(array $resolution): array
    {
        if ($this->cache === null) {
            return $this->fetchRatesIndex($resolution);
        }
        /** @var array{fetched_at: int, pairs: array<string, array<string, string>>} $index */
        $index = $this->cache->resolve(
            FixedFloatRates::ratesMetaKey($this->name, 'fixed'),
            $this->ratesCacheSeconds,
            max(FixedFloatRates::MAX_STALE_SECONDS, $this->ratesCacheSeconds),
            fn (): array => $this->fetchRatesIndex($resolution),
            static fn (array $index): string => FixedFloatRates::serializeIndex($index),
            static fn (string $value): array => FixedFloatRates::deserializeIndex($value),
            TransientCache::REFRESH_CLAIM_SECONDS,
            // Crypto rates must not linger after a failed refresh — fail closed.
            false,
        );
        return $index;
    }

    /** @param array{fetched_at: int, pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} $resolution @return array{fetched_at: int, pairs: array<string, array<string, string>>} */
    private function fetchRatesIndex(array $resolution): array
    {
        $path = ltrim(FixedFloatRates::xmlPath('fixed'), '/');
        $this->logApiRequest($path);
        try {
            $fetched = FixedFloatRates::fetchIndex($this->baseUrl, $this->now, $this->http, 'fixed', $this->requestTimeoutMs);
            $index = FixedFloatRates::retainPairsForKeys($fetched, self::ratePairKeys($resolution));
            $this->logApiResponse($path, 200, true, null, null, ['pair_count' => count($index['pairs'])]);
            return $index;
        } catch (\Throwable $e) {
            $this->logApiResponse($path, 0, false, null, $e->getMessage());
            throw $e;
        }
    }

    /** @return array{fetched_at: int, pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} */
    private function fetchCurrencyResolution(): array
    {
        $now = ($this->now)();
        $currencies = self::readCurrencies($this->post('ccies', []));
        $payIn = [];
        foreach (Assets::listInfo() as $asset) {
            foreach ($currencies as $currency) {
                // /ccies recv=false means the provider will not accept deposits for this currency.
                if (strtoupper($currency['coin']) === $asset['coin'] && Assets::networkMatches($asset['network'], $currency['network']) && ($currency['recv'] ?? null) !== false) {
                    $payIn[$asset['pay_in_asset']] = $currency;
                    break;
                }
            }
        }
        $lightning = null;
        foreach ($currencies as $currency) {
            $matches = $this->lightningCcy === null
                ? strtoupper($currency['coin']) === 'BTC' && Assets::isLightningNetwork($currency['network'])
                : $currency['code'] === $this->lightningCcy;
            // Payout side must be sendable to the merchant's bolt11.
            if ($matches && ($currency['send'] ?? null) !== false) {
                $lightning = $currency;
                break;
            }
        }
        if ($lightning === null) {
            throw new \RuntimeException('FixedFloat /ccies did not include a BTC Lightning payout currency.');
        }
        return ['fetched_at' => $now, 'pay_in' => $payIn, 'lightning' => $lightning];
    }

    /** @param array{pay_in: array<string, array<string, mixed>>} $resolution */
    private function requiredCurrency(array $resolution, string $payInAsset): string
    {
        $currency = $resolution['pay_in'][$payInAsset] ?? null;
        if ($currency === null) {
            throw new \RuntimeException("FixedFloat does not currently support {$payInAsset}.");
        }
        return (string) $currency['code'];
    }

    /** @param array<string, mixed>|null $fallback @return array<string, mixed> */
    private function normalizeOrder(mixed $data, string $payInAsset, ?array $fallback = null): array
    {
        $fallback ??= [];
        $record = Records::asArray($data);
        $from = Records::asArray($record['from'] ?? null);
        $time = Records::asArray($record['time'] ?? null);
        $refundTxId = self::readNestedString($record, ['back', 'tx', 'id'])
            ?? self::readNestedString($record, ['refund', 'tx', 'id'])
            ?? (is_string($fallback['refund_tx_id'] ?? null) ? $fallback['refund_tx_id'] : null);
        $rawStatus = self::readString($record['status'] ?? null);
        // A thin poll body with no "status" keeps the state already persisted
        // VERBATIM: StateTable speaks FixedFloat statuses, not OpenReceive states.
        $normalized = $rawStatus === null && $fallback !== []
            ? self::persistedStatus($fallback)
            : StateTable::normalizeStatus($rawStatus ?? 'NEW', Records::asArray($record['emergency'] ?? null), $refundTxId);
        $order = [
            'provider' => $this->name,
            'provider_order_id' => self::readString($record['id'] ?? null) ?? $fallback['provider_order_id'] ?? self::requiredString($record['id'] ?? null, 'id'),
            'provider_token' => self::readString($record['token'] ?? null) ?? $fallback['provider_token'] ?? self::requiredString($record['token'] ?? null, 'token'),
            'pay_in_asset' => $payInAsset,
            'deposit_address' => self::readString($from['address'] ?? null) ?? $fallback['deposit_address'] ?? self::requiredString($from['address'] ?? null, 'from.address'),
            'deposit_amount' => self::readString($from['amount'] ?? null) ?? $fallback['deposit_amount'] ?? self::requiredString($from['amount'] ?? null, 'from.amount'),
            // No invented deadline: the provider states the expiry, or the persisted one stands.
            'expires_at' => self::requiredExpiresAt(self::readUnixSeconds($time['expiration'] ?? null) ?? $fallback['expires_at'] ?? null),
            'state' => $normalized['state'],
        ];
        $order = [...$order, ...$this->optionalOrderFields($record, $normalized, $refundTxId, $fallback)];
        $order['raw'] = $data;
        return $order;
    }

    /**
     * Every order field that is OMITTED rather than sent as null when the
     * provider did not report it, compacted in one place.
     *
     * @param array<string, mixed> $record
     * @param array<string, mixed> $normalized
     * @param array<string, mixed> $fallback
     * @return array<string, mixed>
     */
    private function optionalOrderFields(array $record, array $normalized, ?string $refundTxId, array $fallback): array
    {
        $from = Records::asArray($record['from'] ?? null);
        $emergencyRepeat = self::readEmergencyRepeat(Records::asArray($record['emergency'] ?? null));
        return Records::compact([
            'deposit_memo' => self::readString($from['tag'] ?? null) ?? $fallback['deposit_memo'] ?? null,
            'deposit_tx_id' => self::readNestedString($record, ['from', 'tx', 'id']) ?? $fallback['deposit_tx_id'] ?? null,
            'payout_tx_id' => self::readNestedString($record, ['to', 'tx', 'id']) ?? $fallback['payout_tx_id'] ?? null,
            'refund_tx_id' => $refundTxId,
            'attention' => $normalized['attention'] ?? null,
            'attention_reason' => $normalized['attention_reason'] ?? null,
            'refund_reason' => $normalized['refund_reason'] ?? (StateTable::isRefundPathState($normalized['state']) ? ($fallback['refund_reason'] ?? null) : null),
            'deposit_received_amount' => self::readDecimalAmount(self::readNestedString($record, ['from', 'tx', 'amount']), 'from.tx.amount') ?? $fallback['deposit_received_amount'] ?? null,
            'refund_amount' => self::readDecimalAmount(self::readNestedString($record, ['back', 'amount']), 'back.amount') ?? $fallback['refund_amount'] ?? null,
            'emergency_repeat' => $emergencyRepeat ?? $fallback['emergency_repeat'] ?? null,
            'fee' => self::readOrderFee($record) ?? $fallback['fee'] ?? null,
        ]);
    }

    public static function formatApiErrorMessage(string $path, int $status, mixed $msg): string
    {
        $message = self::readString($msg);
        return $message === null ? "FixedFloat {$path} failed with HTTP {$status}." : "FixedFloat {$path} failed with HTTP {$status}: {$message}";
    }

    /**
     * The USD equivalents of both sides; their gap is the swap fee the payer absorbs.
     *
     * @param array<string, mixed> $record
     * @return array{currency: string, pay_in_fiat: string, payout_fiat: string}|null
     */
    public static function readOrderFee(array $record): ?array
    {
        $payIn = self::readNestedString($record, ['from', 'usd']);
        $payout = self::readNestedString($record, ['to', 'usd']);
        if ($payIn === null || $payout === null) {
            return null;
        }
        return ['currency' => 'USD', 'pay_in_fiat' => $payIn, 'payout_fiat' => $payout];
    }

    /** Absent means absent; present-but-unparsable is a provider contract break. */
    public static function readDecimalAmount(?string $value, string $label): ?string
    {
        if ($value === null) {
            return null;
        }
        if (preg_match('/\A[0-9]+(\.[0-9]+)?\z/', $value) !== 1) {
            throw new \RuntimeException("FixedFloat {$label} is not a decimal amount.");
        }
        return $value;
    }

    private static function requiredExpiresAt(mixed $expiresAt): int
    {
        if (!is_int($expiresAt)) {
            throw new \RuntimeException('FixedFloat order is missing time.expiration.');
        }
        return $expiresAt;
    }

    /** @param array<string, mixed> $fallback @return array<string, mixed> */
    private static function persistedStatus(array $fallback): array
    {
        return Records::compact([
            'state' => $fallback['state'] ?? null,
            'attention' => $fallback['attention'] ?? null,
            'attention_reason' => $fallback['attention_reason'] ?? null,
            'refund_reason' => $fallback['refund_reason'] ?? null,
        ]);
    }

    /** @return list<array<string, mixed>> */
    public static function readCurrencies(mixed $data): array
    {
        $record = Records::asArray($data);
        if (is_array($data) && array_is_list($data)) {
            $items = $data;
        } elseif (is_array($record['ccies'] ?? null)) {
            $items = $record['ccies'];
        } elseif (is_array($record['currencies'] ?? null)) {
            $items = $record['currencies'];
        } else {
            $items = [];
        }
        $currencies = [];
        foreach ($items as $item) {
            $row = Records::asArray($item);
            $code = self::readString($row['code'] ?? null) ?? self::readString($row['ticker'] ?? null);
            $coin = self::readString($row['coin'] ?? null) ?? self::readString($row['currency'] ?? null) ?? self::readString($row['symbol'] ?? null);
            $network = self::readString($row['network'] ?? null) ?? self::readString($row['chain'] ?? null)
                ?? self::readString($row['networkName'] ?? null) ?? self::readString($row['name'] ?? null);
            if ($code === null || $coin === null || $network === null) {
                continue;
            }
            $currency = ['code' => $code, 'coin' => strtoupper($coin), 'network' => $network];
            if (is_bool($row['recv'] ?? null)) {
                $currency['recv'] = $row['recv'];
            }
            if (is_bool($row['send'] ?? null)) {
                $currency['send'] = $row['send'];
            }
            $currencies[] = $currency;
        }
        return $currencies;
    }

    /** @param array<string, mixed> $emergency */
    private static function readEmergencyRepeat(array $emergency): ?bool
    {
        $value = $emergency['repeat'] ?? null;
        if (is_bool($value)) {
            return $value;
        }
        if ($value === 0 || $value === '0') {
            return false;
        }
        if ($value === 1 || $value === '1') {
            return true;
        }
        return null;
    }

    /**
     * @param array{pay_in: array<string, array<string, mixed>>, lightning: array<string, mixed>} $resolution
     * @return list<string>
     */
    private static function ratePairKeys(array $resolution): array
    {
        $lightningCode = (string) $resolution['lightning']['code'];
        $keys = [];
        foreach ($resolution['pay_in'] as $currency) {
            $keys[] = FixedFloatRates::pairKey((string) $currency['code'], $lightningCode);
        }
        return array_values(array_unique($keys));
    }

    /** @param array<string, mixed> $value @param list<string> $path */
    private static function readNestedString(array $value, array $path): ?string
    {
        $current = $value;
        foreach ($path as $key) {
            $current = Records::asArray($current)[$key] ?? null;
        }
        return self::readString($current);
    }

    private static function readString(mixed $value): ?string
    {
        if (is_string($value) && $value !== '') {
            return $value;
        }
        if (is_int($value) || (is_float($value) && is_finite($value))) {
            return Rates::numberToPlainDecimalString($value);
        }
        return null;
    }

    private static function requiredString(mixed $value, string $field): string
    {
        $string = self::readString($value);
        if ($string === null) {
            throw new \RuntimeException("FixedFloat response missing {$field}.");
        }
        return $string;
    }

    /** @param array<string, mixed> $stored */
    private static function requiredStoredString(array $stored, string $field): string
    {
        $value = $stored[$field] ?? null;
        if (!is_string($value) || $value === '') {
            throw new \InvalidArgumentException("swap order is missing {$field}");
        }
        return $value;
    }

    private static function readUnixSeconds(mixed $value): ?int
    {
        if (is_string($value)) {
            if (preg_match('/\A\d+\z/', $value) === 1) {
                $value = (int) $value;
            } elseif (preg_match('/\A\d+\.0*\z/', $value) === 1) {
                $value = (int) explode('.', $value)[0];
            } else {
                return null;
            }
        }
        if (is_float($value)) {
            if (!is_finite($value) || floor($value) !== $value) {
                return null;
            }
            $value = (int) $value;
        }
        if (!is_int($value) || $value < 0 || $value > FixedFloatRates::MAX_SAFE_INTEGER) {
            return null;
        }
        return $value;
    }
}
