<?php

declare(strict_types=1);

namespace OpenReceive\Http;

/**
 * The one outbound-HTTP seam the engine uses for price feeds and swap
 * providers. StreamTransport is the dependency-free default; Psr18Transport
 * wraps any PSR-18 client (Guzzle in Laravel); the WordPress plugin supplies
 * a wp_remote_* adapter. Never used for NWC — that is the nostr transport.
 */
interface HttpTransport
{
    /**
     * @param array<string, string> $headers
     * @return array{status: int, body: string}
     * @throws TransportException on a network failure or timeout (never on a non-2xx status)
     */
    public function request(string $method, string $url, array $headers = [], ?string $body = null, ?int $timeoutMs = null): array;
}
