<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Http\HttpTransport;
use OpenReceive\Kernel;
use OpenReceive\Money\Money;
use OpenReceive\Nwc\Errors;
use OpenReceive\Nwc\Info;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Nwc\NwcUriParseError;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Nwc\Requests;
use OpenReceive\Payments\WalletScan;
use OpenReceive\Rates\PriceProvider;
use OpenReceive\Rates\Rates;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Server\Errors\HttpError;
use OpenReceive\Server\Errors\NotImplementedHttpError;
use OpenReceive\Server\Errors\ServiceError;
use OpenReceive\Server\Errors\SpendCapableWalletError;
use OpenReceive\Server\Errors\ValidationError;
use OpenReceive\Server\Errors\WalletContractError;
use OpenReceive\Server\Errors\WalletFailureError;
use OpenReceive\Server\Errors\WalletPreflightError;
use OpenReceive\Settlement\Settlement;
use OpenReceive\Support\Integers;
use OpenReceive\Support\Records;
use OpenReceive\Swap\Assets;
use OpenReceive\Swap\LscUri;
use OpenReceive\Swap\Swap;
use OpenReceive\Swap\SwapAddress;
use OpenReceive\Swap\SwapProvider;
use OpenReceive\Swap\SwapProviderRuntime;
use OpenReceive\Swap\TransientCache;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\ConfigurationError;
use Psr\Log\LoggerInterface;

/**
 * The storage-agnostic receive checkout service (the Ruby service.rb twin):
 * prepare/create checkout, the wallet reconcile pass, swap quote/create/get/
 * refund, rates, and the boot-time receive-only wallet preflight. It never
 * touches the host database; RequestHandler and Engine bind it to hosts.
 */
final class Service
{
    public const PAGE_LIMIT = Kernel::TRANSACTION_PAGE_LIMIT;
    /** Upper bound on wallet history pages per scan: a wallet that keeps returning full pages must not hang the scan. */
    public const MAX_PAGES = 10_000;
    public const INVOICE_EXPIRY_SECONDS = 600;
    public const SWAP_INVOICE_EXPIRY_SECONDS = 600;
    /** Maximum seconds the wallet's returned expiry may deviate from the requested expiry before a REQUIRED expiry fails closed. */
    public const INVOICE_EXPIRY_TOLERANCE_SECONDS = 60;
    public const SPEND_OVERRIDE_ENV = 'OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC';

    /** @var list<string> */
    private readonly array $priceCurrencies;
    private readonly ?PriceProvider $priceProvider;
    /** @var list<SwapProvider> */
    private readonly array $swapProviders;
    /** @var callable(): int */
    private $clock;

    /**
     * `$swapProviders` null (the default) auto-builds FixedFloat-compatible
     * providers from LSC_URI_PRIMARY / LSC_URI_BACKUP; pass an explicit list
     * (possibly empty) to override. `$priceProvider` null uses the built-in
     * cached live feed (with OPENRECEIVE_PRICE_FEED_*_URL overrides); pass a
     * provider to override, or `false` to run without rates entirely.
     *
     * @param PriceProvider|false|null $priceProvider
     * @param list<SwapProvider>|null $swapProviders
     * @param list<string> $priceCurrencies
     * @param (callable(): int)|null $clock
     * @param array<string, mixed>|null $env
     */
    public function __construct(
        private readonly ReceiveNwcClient $nwcClient,
        PriceProvider|false|null $priceProvider = null,
        ?array $swapProviders = null,
        array $priceCurrencies = ['USD'],
        ?callable $clock = null,
        bool $allowSpendCapableWallet = false,
        ?array $env = null,
        private readonly ?LoggerInterface $logger = null,
        ?HttpTransport $http = null,
    ) {
        Kernel::assertRuntime();
        $env ??= self::processEnvironment();
        $this->clock = $clock ?? static fn (): int => time();
        $this->priceCurrencies = array_values(array_map(static fn (mixed $value): string => strtoupper((string) $value), $priceCurrencies === [] ? ['USD'] : $priceCurrencies));
        $this->priceProvider = $priceProvider === false ? null : ($priceProvider ?? $this->defaultPriceProvider($env, $http));
        $this->swapProviders = array_values($swapProviders ?? Swap::providersFromEnvironment($env, $http, $this->clock));
        $this->attachSwapProviderRuntime();
        // The override relaxes only the spend refusal: receive-readiness and encryption are still enforced.
        $this->walletPreflight($allowSpendCapableWallet || $this->spendOverrideFromEnv($env));
    }

    /**
     * The quickstart constructor: NWC_URI (and LSC_URI_*, OPENRECEIVE_*) from
     * the environment, the bundled nostr-php transport, live prices.
     *
     * @param array<string, mixed>|null $env
     * @param list<string> $priceCurrencies
     */
    public static function fromEnvironment(
        ?array $env = null,
        array $priceCurrencies = ['USD'],
        PriceProvider|false|null $priceProvider = null,
        ?array $swapProviders = null,
        bool $allowSpendCapableWallet = false,
        ?LoggerInterface $logger = null,
        ?HttpTransport $http = null,
    ): self {
        $env ??= self::processEnvironment();
        $connection = trim((string) ($env['NWC_URI'] ?? ''));
        if ($connection === '') {
            throw new ConfigurationError(
                "OpenReceive needs a receive-only NWC code to receive payments.\n"
                . "Set NWC_URI to your receive-only Nostr Wallet Connect connection string.\n"
                . 'Get one here: ' . Kernel::NWC_CODE_HELP_URL
            );
        }
        try {
            $client = new NostrPhpNwcReceiveClient($connection, $logger);
        } catch (NwcUriParseError $e) {
            throw new ConfigurationError(
                "NWC_URI is set, but it is not a valid NWC code.\nReason: {$e->getMessage()}\n"
                . 'Get a receive-only NWC code here: ' . Kernel::NWC_CODE_HELP_URL,
                0,
                $e
            );
        }
        return new self($client, $priceProvider, $swapProviders === null ? null : array_values($swapProviders), $priceCurrencies, null, $allowSpendCapableWallet, $env, $logger, $http);
    }

    /** @return array<string, mixed> */
    public static function processEnvironment(): array
    {
        $env = getenv();
        return is_array($env) ? [...$env, ...$_ENV] : $_ENV;
    }

    /** @return list<string> */
    public function priceCurrencies(): array
    {
        return $this->priceCurrencies;
    }

    public function nwcClient(): ReceiveNwcClient
    {
        return $this->nwcClient;
    }

    /** @return list<SwapProvider> */
    public function swapProviders(): array
    {
        return $this->swapProviders;
    }

    public function clock(): int
    {
        return ($this->clock)();
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function prepareCheckout(array $input): array
    {
        [$amountMsats, $fiatQuote] = $this->validatingInput(fn (): array => $this->resolveAmount($this->requiredKey($input, 'amount')));
        return [
            'amount_msats' => $amountMsats,
            'fiat_quote' => $fiatQuote,
            'payment_methods' => $this->listSwapOptions($amountMsats),
        ];
    }

    /**
     * Amount-aware swap pay-in options for the shared browser widget: exactly
     * one live provider's catalog — primary when healthy, otherwise the first
     * backup that answers — over the full asset list with amount-vs-limit availability.
     *
     * @return list<array<string, mixed>>
     */
    public function listSwapOptions(int $amountMsats): array
    {
        if ($this->swapProviders === []) {
            return [];
        }
        $normalized = $this->normalizeSwapAmountMsats($amountMsats);
        $catalog = $this->resolveSwapProviderCatalog();
        // Providers ARE configured, so an empty catalog means every one failed its fetch — an outage, not a gap.
        $unreachable = $catalog === [];
        $options = [];
        foreach (Assets::listInfo() as $asset) {
            $options[] = $this->swapCatalogOption($asset, $normalized, $catalog[$asset['pay_in_asset']] ?? null, $unreachable);
        }
        return $options;
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createCheckout(array $input): array
    {
        // Payer-input validation only: once the wallet has minted, a parse
        // failure is the wallet violating the receive contract, not a 400.
        [$reference, $expiry, $requiredExpiry, $fiatQuote, $request] = $this->validatingInput(function () use ($input): array {
            $reference = $this->requiredString($input['reference'] ?? null, 'reference');
            [$amountMsats, $fiatQuote] = $this->resolveAmount($this->requiredKey($input, 'amount'));
            // A caller-supplied expiry_seconds is a FLOOR (only the swap path sets it).
            $requiredExpiry = isset($input['expiry_seconds']);
            $expiry = Integers::parse($input['expiry_seconds'] ?? self::INVOICE_EXPIRY_SECONDS, 'expiry_seconds');
            $metadata = [...Records::asArray($input['metadata'] ?? []), 'reference' => $reference];
            $encoded = json_encode($metadata, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false || strlen($encoded) > Kernel::NWC_METADATA_MAX_BYTES) {
                throw new ValidationError('metadata is too large for NIP-47.');
            }
            $request = ['amount_msats' => $amountMsats, 'expiry' => $expiry, 'metadata' => $metadata];
            if (isset($input['memo']) && $input['memo'] !== '') {
                $request['description'] = $input['memo'];
            }
            if (isset($input['description_hash'])) {
                $request['description_hash'] = $input['description_hash'];
            }
            return [$reference, $expiry, $requiredExpiry, $fiatQuote, $request];
        });
        $response = $this->callNwc(fn (): array => $this->nwcClient->makeInvoice($request));
        try {
            $wallet = Requests::normalizeMakeInvoiceResponse($response);
            $createdAt = $wallet['created_at'] ?? ($this->clock)();
            // The ledger row stores the wallet's OWN expires_at, so reuse
            // buffering, reconciliation and the expiry+grace close rule stay
            // consistent with the real invoice even when the wallet clamps.
            $requestedExpiresAt = $createdAt + $expiry;
            $expiresAt = $wallet['expires_at'] ?? $requestedExpiresAt;
            $shortfall = $requestedExpiresAt - $expiresAt;
            if (abs($expiresAt - $requestedExpiresAt) > self::INVOICE_EXPIRY_TOLERANCE_SECONDS) {
                if ($requiredExpiry && $shortfall > self::INVOICE_EXPIRY_TOLERANCE_SECONDS) {
                    $this->logger?->error(sprintf(
                        'checkout.invoice_expiry.rejected: The wallet did not honor the required invoice expiry (required %ds, got %ds). Use a wallet whose make_invoice honors expiry.',
                        $expiry,
                        $expiresAt - $createdAt
                    ));
                    throw new WalletContractError('Error with the backing NWC wallet: it did not honor the requested invoice expiry.');
                }
                $this->logger?->warning(sprintf(
                    'checkout.invoice_expiry.adjusted: The wallet clamped the requested invoice expiry (requested %ds, got %ds); the wallet\'s own expiry is recorded on the attempt.',
                    $expiry,
                    $expiresAt - $createdAt
                ));
            }
            return [
                'reference' => $reference,
                'payment_hash' => $wallet['payment_hash'],
                'bolt11' => $wallet['invoice'],
                'amount_msats' => $wallet['amount_msats'],
                'created_at' => $createdAt,
                'expires_at' => $expiresAt,
                'fiat_quote' => $fiatQuote,
            ];
        } catch (WalletContractError $e) {
            throw $e;
        } catch (\InvalidArgumentException | \TypeError) {
            // Never blames the payer, and never puts the raw parse failure on the wire.
            throw new WalletContractError();
        }
    }

    /**
     * One reconcile pass over the given attempts. Optional bounds for
     * request-path passes: `max_pages` caps each wallet-history walk (the gated
     * opportunistic pass sends 50), `deadline` is a monotonic-clock instant
     * (seconds, hrtime-based) checked between page fetches — never mid-request.
     * A hash the walk could not decide is OMITTED rather than reported
     * not_found (wallet-scan-truncation vectors).
     *
     * @param array<string, mixed> $input
     * @return list<array<string, mixed>>
     */
    public function reconcilePayments(array $input): array
    {
        $attempts = $input['attempts'] ?? [];
        if (!is_array($attempts) || $attempts === []) {
            return [];
        }
        $expected = [];
        foreach ($attempts as $attempt) {
            $row = Records::asArray($attempt);
            $hash = $this->normalizePaymentHash($row['payment_hash'] ?? $row['paymentHash'] ?? null);
            $expected[$hash] = Integers::parse($row['created_at'] ?? $row['createdAt'] ?? null, 'created_at');
        }
        $overlap = Integers::parse($input['overlap_seconds'] ?? 60, 'overlap_seconds');
        if ($overlap < 0) {
            throw new \InvalidArgumentException('overlap_seconds must be a non-negative integer');
        }
        // Both ends of the window are padded: `from` against a wallet clock that lags, `until` against one that runs ahead.
        $from = max(min($expected) - $overlap, 0);
        $until = Integers::parse($input['until'] ?? (($this->clock)() + $overlap), 'until');
        $maxPages = isset($input['max_pages']) ? Integers::parse($input['max_pages'], 'max_pages') : null;
        $deadline = isset($input['deadline']) ? (float) $input['deadline'] : null;
        $hashes = array_keys($expected);
        $settled = $this->scanIncomingTransactions($hashes, $from, $until, false, $maxPages, $deadline);
        $byHash = $settled['rows'];
        $missing = array_values(array_filter($hashes, static fn (string $hash): bool => !isset($byHash[$hash])));
        $truncated = false;
        if ($missing !== []) {
            $inclusive = $this->scanIncomingTransactions($missing, $from, $until, true, $maxPages, $deadline);
            $truncated = $settled['truncated'] || $inclusive['truncated'];
            foreach ($inclusive['rows'] as $hash => $row) {
                $byHash[$hash] ??= $row;
            }
        }
        $results = [];
        foreach ($hashes as $hash) {
            if (isset($byHash[$hash])) {
                $results[] = $this->paymentResult($hash, $byHash[$hash]);
            } elseif (!$truncated) {
                $results[] = ['payment_hash' => $hash, 'status' => 'not_found'];
            }
        }
        return $results;
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function quoteSwap(array $input): array
    {
        $asset = $this->parsePayInAsset($input['pay_in_asset'] ?? null);
        [$amountMsats] = $this->validatingInput(fn (): array => $this->resolveAmount($this->requiredKey($input, 'amount')));
        $provider = $this->selectProvider($asset);
        $quote = Records::asArray($provider->quote($asset, $amountMsats));
        return Records::compact([
            'provider' => $quote['provider'] ?? $provider->name(),
            'pay_asset' => $this->requiredKey($quote, 'pay_asset'),
            'available' => $this->requiredKey($quote, 'available'),
            'pay_amount' => $quote['pay_amount'] ?? null,
            'minimum_pay_amount' => $quote['minimum_pay_amount'] ?? null,
            'maximum_pay_amount' => $quote['maximum_pay_amount'] ?? null,
            'minimum_invoice_amount_msats' => $quote['minimum_invoice_amount_msats'] ?? null,
            'maximum_invoice_amount_msats' => $quote['maximum_invoice_amount_msats'] ?? null,
            'unavailable_reason' => $quote['unavailable_reason'] ?? null,
            'unavailable_message' => $quote['unavailable_message'] ?? null,
        ]);
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createSwap(array $input): array
    {
        $asset = $this->parsePayInAsset($input['pay_in_asset'] ?? null);
        if (!array_key_exists('amount', $input)) {
            throw new ValidationError('amount is required.');
        }
        $provider = $this->selectProvider($asset);
        $expiry = $provider->invoiceExpirySeconds($asset);
        // The shadow-invoice expiry is provider-mandated: build the checkout
        // input explicitly from validated fields so no payer-supplied key can override it.
        $checkout = $this->createCheckout([
            'reference' => $input['reference'] ?? null,
            'amount' => $input['amount'],
            'memo' => $input['memo'] ?? null,
            'metadata' => $input['metadata'] ?? null,
            'expiry_seconds' => $expiry,
        ]);
        $order = Records::asArray($provider->createSwap($asset, $checkout['bolt11'], $checkout['amount_msats']));
        $providerOrder = $order;
        unset($providerOrder['raw']);
        return [
            ...$this->publicSwap($order, $checkout['payment_hash'], $checkout['reference']),
            'checkout' => $checkout,
            'swap_data' => ['version' => 1, 'provider_order' => $providerOrder],
        ];
    }

    /** @param array<string, mixed> $swapData @return array<string, mixed> */
    public function getSwap(string $reference, string $paymentHash, array $swapData): array
    {
        $recovery = $this->normalizeSwapData($swapData);
        $provider = $this->providerByName((string) $recovery['provider_order']['provider']);
        $current = Records::asArray($provider->getStatus($recovery['provider_order']));
        return $this->publicSwap($current, $this->normalizePaymentHash($paymentHash), $this->requiredString($reference, 'reference'));
    }

    /** @param array<string, mixed> $swapData @return array<string, mixed> */
    public function refundSwap(string $reference, string $paymentHash, array $swapData, string $refundAddress): array
    {
        $recovery = $this->normalizeSwapData($swapData);
        $hash = $this->normalizePaymentHash($paymentHash);
        $hostReference = $this->requiredString($reference, 'reference');
        $address = $this->normalizeRefundAddress($refundAddress, $recovery['provider_order']['pay_in_asset'] ?? null);
        $provider = $this->providerByName((string) $recovery['provider_order']['provider']);
        $current = Records::asArray($provider->getStatus($recovery['provider_order']));
        if (($current['state'] ?? null) !== 'refund_required') {
            throw new ConflictError('Swap cannot be refunded from provider state ' . ($current['state'] ?? 'unknown') . '.');
        }
        $provider->requestRefund($current, $address);
        return $this->getSwap($hostReference, $hash, $recovery);
    }

    /** @param array<string, mixed> $input @return array{bitcoin: array<string, string>} */
    public function listRates(array $input = []): array
    {
        if ($this->priceProvider === null) {
            throw new NotImplementedHttpError('No price provider is configured for rates.');
        }
        $currencies = array_map(static fn (mixed $value): string => strtoupper(trim((string) $value)), $input['currencies'] ?? $this->priceCurrencies);
        $rates = [];
        foreach ($currencies as $currency) {
            if (preg_match('/\A[A-Z]{3}\z/', $currency) !== 1) {
                throw new ValidationError("Invalid currencies entry: {$currency}.");
            }
            if (!in_array($currency, $this->priceCurrencies, true)) {
                throw new ValidationError('fiat.currency must be one of the configured priceCurrencies: ' . implode(', ', $this->priceCurrencies) . '.');
            }
            $rates[strtolower($currency)] = $this->btcFiatPriceOrUnavailable($currency);
        }
        return ['bitcoin' => $rates];
    }

    /**
     * Forward an NWC-02 subscription to the wallet client (blocking).
     *
     * @param callable(array<string, mixed>): void $handler
     * @param (callable(): void)|null $onIdle
     */
    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->nwcClient->subscribeNotifications($handler, $onIdle);
    }

    /** EVERY feed-side failure maps to the payer-facing retryable 503, like the JS ratesUnavailableError. */
    private function btcFiatPriceOrUnavailable(string $currency): string
    {
        try {
            return (string) $this->priceProvider?->btcFiatPrice($currency);
        } catch (\Throwable $e) {
            if ($e instanceof HttpError) {
                throw $e;
            }
            throw new ServiceError(503, 'INTERNAL', 'Exchange rates are temporarily unavailable — please try again in a moment.', true);
        }
    }

    /**
     * Fail-closed boot preflight: the connection must be receive-ready and
     * speak an encryption mode we implement, and — unless overridden — must
     * not advertise spend methods. A read failure fails the boot: booting
     * blind only defers the failure to the first customer checkout.
     */
    private function walletPreflight(bool $allowSpendCapable): void
    {
        try {
            $rawInfo = $this->nwcClient->preflight();
        } catch (NwcUriParseError $e) {
            throw $e;
        } catch (\Throwable $e) {
            throw new WalletPreflightError('could not read wallet info (' . (new \ReflectionClass($e))->getShortName() . ": {$e->getMessage()}).");
        }
        $summary = Info::summarize($rawInfo);
        if (!$summary['receive_checkout_ready']) {
            throw new WalletPreflightError('the wallet does not advertise make_invoice and list_transactions.');
        }
        if ($summary['encryption'] === null) {
            throw new WalletPreflightError('the wallet supports no encryption mode OpenReceive speaks (NIP-04 or NIP-44 v2).');
        }
        if ($allowSpendCapable) {
            return;
        }
        $spend = array_values(array_filter($summary['methods'], static fn (string $method): bool => in_array($method, Info::SPEND_METHODS, true)));
        if ($spend !== []) {
            throw new SpendCapableWalletError($spend);
        }
    }

    /** @param array<string, mixed> $env */
    private function spendOverrideFromEnv(array $env): bool
    {
        $raw = strtolower(trim((string) ($env[self::SPEND_OVERRIDE_ENV] ?? '')));
        if ($raw === '') {
            return false;
        }
        if (in_array($raw, ['1', 'true', 'yes'], true)) {
            return true;
        }
        if (!in_array($raw, ['0', 'false', 'no'], true)) {
            // Fail closed (no override), but never silently: a typo must not read as "unset".
            $this->logger?->warning("[openreceive] Unrecognized " . self::SPEND_OVERRIDE_ENV . " value \"{$raw}\"; treating it as disabled. Use 1/true/yes to enable.");
        }
        return false;
    }

    /** @return array{version: int, provider_order: array<string, mixed>} */
    private function normalizeSwapData(mixed $value): array
    {
        $data = Records::asArray($value);
        $order = $data['provider_order'] ?? null;
        if (($data['version'] ?? null) !== 1 || !Records::isRecord($order)
            || trim((string) (Records::asArray($order)['provider'] ?? '')) === ''
            || trim((string) (Records::asArray($order)['provider_order_id'] ?? '')) === '') {
            throw new ValidationError('swapData is invalid.');
        }
        return ['version' => 1, 'provider_order' => Records::asArray($order)];
    }

    private function parsePayInAsset(mixed $value): string
    {
        if (!Assets::isPayInAsset($value)) {
            throw new ValidationError('payInAsset is not supported.');
        }
        return (string) $value;
    }

    /** Lightning invoices are whole sats; round up so catalog limits match create. */
    private function normalizeSwapAmountMsats(mixed $value): int
    {
        try {
            $amount = Integers::parse($value, 'amount_msats');
        } catch (\InvalidArgumentException) {
            $amount = null;
        }
        if ($amount === null || $amount < 1000) {
            throw new ValidationError('amountMsats must be an integer >= 1000.');
        }
        return intdiv($amount + 999, 1000) * 1000;
    }

    /** @param array<string, mixed> $env */
    private function defaultPriceProvider(array $env, ?HttpTransport $http): PriceProvider
    {
        $overrides = Rates::readPriceFeedUrlOverrides($env);
        return Rates::createCachedLivePriceFeed($this->priceCurrencies, $http, $this->clock, null, $overrides['primary_url'], $overrides['fallback_url']);
    }

    /** One shared transient cache and one per-provider weight budget, attached to every provider that accepts them. */
    private function attachSwapProviderRuntime(): void
    {
        if ($this->swapProviders === []) {
            return;
        }
        $cache = new TransientCache($this->clock, $this->logger);
        foreach ($this->swapProviders as $provider) {
            $name = $provider->name();
            if ($provider instanceof SwapProviderRuntime) {
                $provider->attachSwapCache($cache);
                $provider->attachWeightBudget(new WeightBudget($name, $this->clock));
            }
        }
    }

    /**
     * Exactly one live provider's catalog: primary when healthy, otherwise the first backup that answers.
     *
     * @return array<string, array<string, mixed>>
     */
    private function resolveSwapProviderCatalog(): array
    {
        foreach ($this->swapProviders as $provider) {
            try {
                $catalog = $provider->payInAssetCatalog();
            } catch (\Throwable) {
                continue;
            }
            $byAsset = [];
            foreach ($catalog as $item) {
                $row = Records::asArray($item);
                $byAsset[(string) ($row['pay_asset'] ?? '')] = [...$row, 'provider' => $provider->name()];
            }
            return $byAsset;
        }
        return [];
    }

    /**
     * `$catalogUnreachable` separates a transient provider outage from a
     * configuration gap; the unavailable label is cached per amount for up to 60 s.
     *
     * @param array{pay_in_asset: string, label: string, network_label: string} $asset
     * @param array<string, mixed>|null $providerAsset
     * @return array<string, mixed>
     */
    private function swapCatalogOption(array $asset, int $amountMsats, ?array $providerAsset, bool $catalogUnreachable): array
    {
        if ($providerAsset === null) {
            [$reason, $message] = $catalogUnreachable
                ? ['provider_unreachable', 'The swap provider is temporarily unreachable.']
                : ['provider_unconfigured', 'Automated swaps are not configured for this asset.'];
            return [
                'pay_in_asset' => $asset['pay_in_asset'], 'label' => $asset['label'], 'network_label' => $asset['network_label'],
                'provider' => '', 'available' => false, 'unavailable_reason' => $reason, 'unavailable_message' => $message,
            ];
        }
        $minimumMsats = $providerAsset['minimum_invoice_amount_msats'] ?? null;
        $maximumMsats = $providerAsset['maximum_invoice_amount_msats'] ?? null;
        $limitReason = null;
        if ($amountMsats > 0 && $minimumMsats !== null && $amountMsats < $minimumMsats) {
            $limitReason = 'amount_too_small';
        } elseif ($amountMsats > 0 && $maximumMsats !== null && $amountMsats > $maximumMsats) {
            $limitReason = 'amount_too_large';
        }
        $unavailable = ($providerAsset['available'] ?? null) === false;
        $reason = $limitReason ?? ($unavailable ? ($providerAsset['unavailable_reason'] ?? null) : null);
        $message = match ($limitReason) {
            'amount_too_small' => 'This invoice is below the provider minimum.',
            'amount_too_large' => 'This invoice is above the provider maximum.',
            default => $unavailable ? ($providerAsset['unavailable_message'] ?? null) : null,
        };
        $option = [
            'pay_in_asset' => $asset['pay_in_asset'], 'label' => $asset['label'], 'network_label' => $asset['network_label'],
            'provider' => $providerAsset['provider'], 'available' => $reason === null && !$unavailable,
        ];
        return [...$option, ...Records::compact([
            'unavailable_reason' => $reason,
            'unavailable_message' => $message,
            'minimum_pay_amount' => $providerAsset['minimum_pay_amount'] ?? null,
            'maximum_pay_amount' => $providerAsset['maximum_pay_amount'] ?? null,
            'minimum_invoice_amount_msats' => $minimumMsats,
            'maximum_invoice_amount_msats' => $maximumMsats,
        ])];
    }

    /** @return array{0: int, 1: array<string, mixed>|null} */
    private function resolveAmount(mixed $input): array
    {
        $amount = Records::asArray($input);
        if (array_key_exists('sats', $amount)) {
            return [Money::directToMsats('SATS', $amount['sats']), null];
        }
        $currency = strtoupper($this->requiredString($amount['currency'] ?? null, 'amount.currency'));
        $value = $this->requiredString($amount['value'] ?? null, 'amount.value');
        if (in_array($currency, ['BTC', 'SAT', 'SATS'], true)) {
            return [Money::directToMsats($currency, $value), null];
        }
        if ($this->priceProvider === null) {
            throw new ValidationError('price provider is not configured');
        }
        if (!in_array($currency, $this->priceCurrencies, true)) {
            throw new ValidationError('fiat.currency must be one of the configured priceCurrencies: ' . implode(', ', $this->priceCurrencies) . '.');
        }
        $price = $this->btcFiatPriceOrUnavailable($currency);
        $msats = Money::quoteFiatToMsats($value, $price);
        return [$msats, [
            'fiat' => ['currency' => $currency, 'value' => $value],
            'btc_fiat_price' => $price,
            'amount_msats' => $msats,
            'as_of' => ($this->clock)(),
        ]];
    }

    /** @param array<string, mixed> $transaction @return array<string, mixed> */
    private function paymentResult(string $hash, array $transaction): array
    {
        $status = Settlement::status($transaction);
        $observedAt = ($this->clock)();
        $details = ['transaction' => $transaction, 'observed_at' => $observedAt];
        $result = ['payment_hash' => $hash, 'status' => $status];
        if ($status === 'settled') {
            $result['paid_at'] = $transaction['settled_at'] ?? $observedAt;
            $details['paid_at_source'] = isset($transaction['settled_at']) ? 'settled_at' : 'observed_at';
        }
        $result['details'] = $details;
        return $result;
    }

    /**
     * One wallet-history walk through the shared core scan, with the
     * request-path deadline checked between page fetches: once it passes, the
     * previous page is replayed so the walk ends marked truncated.
     *
     * @param list<string> $expected
     * @return array{rows: array<string, array<string, mixed>>, truncated: bool}
     */
    private function scanIncomingTransactions(array $expected, int $from, int $until, bool $unpaid, ?int $maxPages, ?float $deadline): array
    {
        $previous = null;
        $client = function (array $request) use (&$previous, $deadline): array {
            if ($previous !== null && $deadline !== null && hrtime(true) / 1e9 >= $deadline) {
                return $previous;
            }
            $previous = $this->callNwc(fn (): array => $this->nwcClient->listTransactions($request));
            return $previous;
        };
        return WalletScan::listIncomingTransactions($client, $expected, $from, $until, $maxPages ?? self::MAX_PAGES, $unpaid);
    }

    /** A false accept here sends the payer's money somewhere unrecoverable, so the address is checksum-checked against the order's own network. */
    private function normalizeRefundAddress(mixed $value, mixed $payInAsset): string
    {
        $normalized = trim(is_scalar($value) ? (string) $value : '');
        if ($normalized === '' || strlen($normalized) > 300) {
            throw new ValidationError('refundAddress is invalid.');
        }
        if (is_string($payInAsset) && !SwapAddress::isValidForPayInAsset($payInAsset, $normalized)) {
            throw new ValidationError("refundAddress is not a valid {$payInAsset} address.");
        }
        return $normalized;
    }

    /** Primary-only while healthy; backup only when primary is down, never to fill gaps for assets the primary omits. */
    private function selectProvider(string $asset): SwapProvider
    {
        foreach ($this->swapProviders as $provider) {
            try {
                $supported = $provider->supportedPayInAssets();
            } catch (\Throwable) {
                continue;
            }
            if (in_array($asset, $supported, true)) {
                return $provider;
            }
            throw $this->unsupportedSwapAssetError($asset);
        }
        throw $this->unsupportedSwapAssetError($asset);
    }

    private function unsupportedSwapAssetError(string $asset): ServiceError
    {
        return new ServiceError(503, 'INTERNAL', "No configured swap provider supports {$asset}.");
    }

    private function providerByName(string $name): SwapProvider
    {
        foreach ($this->swapProviders as $provider) {
            if ($provider->name() === $name) {
                return $provider;
            }
        }
        throw new ServiceError(503, 'INTERNAL', "Swap provider {$name} is not configured.");
    }

    /** @param array<string, mixed> $order @return array<string, mixed> */
    private function publicSwap(array $order, string $hash, string $reference): array
    {
        return Records::compact([
            'payment_hash' => $hash,
            'reference' => $reference,
            'provider' => $this->requiredKey($order, 'provider'),
            'pay_in_asset' => $this->requiredKey($order, 'pay_in_asset'),
            'deposit_address' => $this->requiredKey($order, 'deposit_address'),
            'deposit_memo' => $order['deposit_memo'] ?? null,
            'deposit_amount' => $this->requiredKey($order, 'deposit_amount'),
            'provider_state' => $this->requiredKey($order, 'state'),
            'provider_expires_at' => $this->requiredKey($order, 'expires_at'),
            'deposit_tx_id' => $order['deposit_tx_id'] ?? null,
            'payout_tx_id' => $order['payout_tx_id'] ?? null,
            'refund_tx_id' => $order['refund_tx_id'] ?? null,
            'refund_reason' => $order['refund_reason'] ?? null,
            'refund_amount' => $order['refund_amount'] ?? null,
            'attention' => $order['attention'] ?? null,
            // Explains the attempt to the payer; `provider_token` stays server-only.
            'attention_reason' => $order['attention_reason'] ?? null,
            'deposit_received_amount' => $order['deposit_received_amount'] ?? null,
            'emergency_repeat' => $order['emergency_repeat'] ?? null,
            'provider_order_id' => $order['provider_order_id'] ?? null,
            'fee' => $order['fee'] ?? null,
        ]);
    }

    /**
     * Wallet failures normalize to the shared error vocabulary; the engine's
     * own errors pass through. Never retried: a retry after an exception
     * inside make_invoice would mint two invoices for one attempt.
     *
     * @template T
     * @param callable(): T $call
     * @return T
     */
    private function callNwc(callable $call): mixed
    {
        try {
            return $call();
        } catch (HttpError $e) {
            throw $e;
        } catch (\Throwable $e) {
            throw new WalletFailureError(Errors::normalizeWalletError($e));
        }
    }

    /**
     * The payer-input parse boundary: a missing or malformed field inside the
     * block is a 400, not a 500. Wallet and provider calls stay outside it.
     *
     * @template T
     * @param callable(): T $fn
     * @return T
     */
    private function validatingInput(callable $fn): mixed
    {
        try {
            return $fn();
        } catch (HttpError $e) {
            throw $e;
        } catch (\InvalidArgumentException $e) {
            throw new ValidationError($e->getMessage());
        }
    }

    /** @param array<string, mixed> $record */
    private function requiredKey(array $record, string $key): mixed
    {
        if (!array_key_exists($key, $record)) {
            throw new ValidationError("{$key} is required.");
        }
        return $record[$key];
    }

    private function requiredString(mixed $value, string $field): string
    {
        $text = trim(is_scalar($value) ? (string) $value : '');
        if ($text === '') {
            throw new ValidationError("{$field} is required.");
        }
        return $text;
    }

    private function normalizePaymentHash(mixed $value): string
    {
        $hash = strtolower($this->requiredString($value, 'payment_hash'));
        if (preg_match(Kernel::LOWER_HEX_64_PATTERN, $hash) !== 1) {
            throw new ValidationError('payment_hash must be 64 hexadecimal characters');
        }
        return $hash;
    }
}
