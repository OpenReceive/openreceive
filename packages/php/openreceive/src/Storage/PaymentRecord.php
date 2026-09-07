<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

/**
 * One `openreceive_payments` row. `swapData` is server-only provider recovery
 * data: it is a property so the service can read it, and it is NEVER part of
 * `toArray()` — the shape that reaches responses and logs.
 */
final class PaymentRecord
{
    /**
     * @param array<string, mixed> $checkout
     * @param array<string, mixed>|null $swapData
     */
    public function __construct(
        public readonly string $reference,
        public readonly string $paymentHash,
        public readonly string $status,
        public readonly ?string $statusReason,
        public readonly ?int $paidAt,
        public readonly int $expiresAt,
        public readonly int $createdAt,
        public readonly int $insertedAt,
        public readonly array $checkout,
        public readonly ?array $swapData,
        public readonly ?string $clientIp,
    ) {
    }

    public function isSwap(): bool
    {
        return $this->swapData !== null && $this->swapData !== [];
    }

    /** The swap's pay-in asset from the persisted provider order, or null for a Lightning attempt. */
    public function swapPayInAsset(): ?string
    {
        $asset = $this->swapData['provider_order']['pay_in_asset'] ?? null;
        return is_string($asset) ? $asset : null;
    }

    /**
     * Public shape (no swap_data).
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'reference' => $this->reference,
            'payment_hash' => $this->paymentHash,
            'status' => $this->status,
            'status_reason' => $this->statusReason,
            'paid_at' => $this->paidAt,
            'expires_at' => $this->expiresAt,
            'created_at' => $this->createdAt,
            'checkout' => $this->checkout,
        ];
    }
}
