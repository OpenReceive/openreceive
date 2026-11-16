<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

use OpenReceive\Http\HttpTransport;
use OpenReceive\Http\TransportException;

final class WpHttpTransport implements HttpTransport
{
    public function request(string $method, string $url, array $headers = [], ?string $body = null, ?int $timeoutMs = null): array
    {
        $response = wp_remote_request($url, [
            'method' => $method, 'headers' => $headers, 'body' => $body,
            'timeout' => max(1, (int) ceil(($timeoutMs ?? 10000) / 1000)),
            'redirection' => 0,
        ]);
        if (is_wp_error($response)) { throw new TransportException('Payment service HTTP request failed.'); }
        // By lower-case name, as the engine's own transports return them: a swap
        // provider's 429 says how long to wait in its Retry-After header.
        $responseHeaders = [];
        foreach (wp_remote_retrieve_headers($response) as $name => $value) {
            $responseHeaders[strtolower((string) $name)] = is_array($value) ? implode(', ', array_map('strval', $value)) : (string) $value;
        }
        return ['status' => wp_remote_retrieve_response_code($response), 'body' => wp_remote_retrieve_body($response), 'headers' => $responseHeaders];
    }
}
