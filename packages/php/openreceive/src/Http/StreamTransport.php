<?php

declare(strict_types=1);

namespace OpenReceive\Http;

/** Default transport on PHP's HTTP stream wrapper: no extension beyond openssl, no dependency. */
final class StreamTransport implements HttpTransport
{
    public const DEFAULT_TIMEOUT_MS = 10_000;

    public function request(string $method, string $url, array $headers = [], ?string $body = null, ?int $timeoutMs = null): array
    {
        $headerLines = [];
        foreach ($headers as $name => $value) {
            $headerLines[] = "{$name}: {$value}";
        }
        $timeout = ($timeoutMs ?? self::DEFAULT_TIMEOUT_MS) / 1000;
        $context = stream_context_create(['http' => [
            'method' => strtoupper($method),
            'header' => implode("\r\n", $headerLines),
            'content' => $body ?? '',
            'timeout' => $timeout,
            'ignore_errors' => true,
            'follow_location' => 0,
        ]]);
        $started = microtime(true);
        $responseBody = @file_get_contents($url, false, $context);
        /** @var list<string> $responseHeaders */
        $responseHeaders = $http_response_header ?? [];
        if ($responseBody === false || $responseHeaders === []) {
            $timedOut = (microtime(true) - $started) >= $timeout * 0.95;
            throw new TransportException($timedOut ? "request to {$url} timed out" : "request to {$url} failed", $timedOut);
        }
        $status = 0;
        if (preg_match('#\AHTTP/\S+\s+(\d{3})#', $responseHeaders[0], $match) === 1) {
            $status = (int) $match[1];
        }
        return ['status' => $status, 'body' => $responseBody];
    }
}
