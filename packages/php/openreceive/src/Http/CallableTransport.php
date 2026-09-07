<?php

declare(strict_types=1);

namespace OpenReceive\Http;

/** HttpTransport over a closure — the test seam (`fn ($method, $url, $headers, $body, $timeoutMs) => ['status' => …, 'body' => …]`). */
final class CallableTransport implements HttpTransport
{
    /** @var callable(string, string, array<string, string>, ?string, ?int): array{status: int, body: string} */
    private $fn;

    /** @param callable(string, string, array<string, string>, ?string, ?int): array{status: int, body: string} $fn */
    public function __construct(callable $fn)
    {
        $this->fn = $fn;
    }

    public function request(string $method, string $url, array $headers = [], ?string $body = null, ?int $timeoutMs = null): array
    {
        return ($this->fn)($method, $url, $headers, $body, $timeoutMs);
    }
}
