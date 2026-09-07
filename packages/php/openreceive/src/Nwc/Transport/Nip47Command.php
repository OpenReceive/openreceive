<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use dsbaars\nostr\Nip47\Command\CommandInterface;

/**
 * A NIP-47 request built from the kernel's own params. The nostr-php-nwc
 * command classes re-type each parameter and MakeInvoiceCommand has no
 * `metadata`; this carries the kernel-built params verbatim so the wire
 * matches the nwc-request-response vectors byte for byte.
 */
final class Nip47Command implements CommandInterface
{
    /** @param array<string, mixed> $params */
    public function __construct(private readonly string $method, private readonly array $params)
    {
    }

    public function getMethod(): string
    {
        return $this->method;
    }

    public function getParams(): array
    {
        return $this->params;
    }

    public function toArray(): array
    {
        return ['method' => $this->method, 'params' => $this->params];
    }

    public function validate(): bool
    {
        return true;
    }
}
