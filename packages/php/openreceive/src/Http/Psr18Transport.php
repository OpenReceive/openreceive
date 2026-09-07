<?php

declare(strict_types=1);

namespace OpenReceive\Http;

use Psr\Http\Client\ClientExceptionInterface;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Client\NetworkExceptionInterface;
use Psr\Http\Message\RequestFactoryInterface;
use Psr\Http\Message\StreamFactoryInterface;

/** HttpTransport over any PSR-18 client plus PSR-17 factories (Guzzle, Symfony HttpClient, …). */
final class Psr18Transport implements HttpTransport
{
    public function __construct(
        private readonly ClientInterface $client,
        private readonly RequestFactoryInterface $requests,
        private readonly StreamFactoryInterface $streams,
    ) {
    }

    public function request(string $method, string $url, array $headers = [], ?string $body = null, ?int $timeoutMs = null): array
    {
        $request = $this->requests->createRequest(strtoupper($method), $url);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        if ($body !== null) {
            $request = $request->withBody($this->streams->createStream($body));
        }
        try {
            $response = $this->client->sendRequest($request);
        } catch (NetworkExceptionInterface $e) {
            $timedOut = str_contains(strtolower($e->getMessage()), 'timed out') || str_contains(strtolower($e->getMessage()), 'timeout');
            throw new TransportException($e->getMessage(), $timedOut, $e);
        } catch (ClientExceptionInterface $e) {
            throw new TransportException($e->getMessage(), false, $e);
        }
        return ['status' => $response->getStatusCode(), 'body' => (string) $response->getBody()];
    }
}
