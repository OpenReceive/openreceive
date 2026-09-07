<?php

declare(strict_types=1);

namespace OpenReceive\Server;

/**
 * What the host's `authorize` (and a custom rate-limit hook) sees: the route
 * action, the framework's own request object — PSR-7 on the plain mount, the
 * Illuminate request under Laravel — and the resource the payer named.
 */
final class AuthorizeContext
{
    /**
     * @param string $action one of checkout.prepare, checkout.create, payment.check, swap.quote, swap.create, swap.read, swap.refund
     * @param array{reference: string, payment_hash?: string} $resource
     */
    public function __construct(
        public readonly string $action,
        public readonly mixed $request,
        public readonly array $resource,
    ) {
    }

    public function reference(): string
    {
        return $this->resource['reference'];
    }

    public function paymentHash(): ?string
    {
        return $this->resource['payment_hash'] ?? null;
    }
}
