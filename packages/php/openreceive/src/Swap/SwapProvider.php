<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * The swap-provider contract the service drives: the FixedFloat-compatible
 * provider and the Testing\FakeSwapProvider both implement it. Orders are
 * string-keyed arrays with the shared SwapOrder field names (provider,
 * provider_order_id, provider_token, pay_in_asset, deposit_address,
 * deposit_amount, expires_at, state, …); `provider_token` is server-only.
 */
interface SwapProvider
{
    public function name(): string;

    /** @return list<string> */
    public function supportedPayInAssets(): array;

    /**
     * Per-asset availability and limits.
     *
     * @return list<array<string, mixed>>
     */
    public function payInAssetCatalog(): array;

    /** The shadow-invoice expiry the provider needs (a FLOOR for the mint). */
    public function invoiceExpirySeconds(?string $payInAsset = null): int;

    /** @return array<string, mixed> */
    public function quote(string $payInAsset, int $invoiceAmountMsats): array;

    /** @return array<string, mixed> */
    public function createSwap(string $payInAsset, string $bolt11, int $invoiceAmountMsats): array;

    /** @param array<string, mixed> $order @return array<string, mixed> */
    public function getStatus(array $order): array;

    /** @param array<string, mixed> $order */
    public function requestRefund(array $order, string $refundAddress): void;
}
