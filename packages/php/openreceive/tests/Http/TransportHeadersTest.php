<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Http;

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7\Response;
use OpenReceive\Http\CallableTransport;
use OpenReceive\Http\Psr18Transport;
use OpenReceive\Http\StreamTransport;
use OpenReceive\Swap\FixedFloatProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * The bundled transports hand back the response headers by lower-case name,
 * which is how a swap provider's `Retry-After` reaches its request guard.
 */
final class TransportHeadersTest extends TestCase
{
    public function testTheStreamTransportNamesItsHeaderLines(): void
    {
        $headers = StreamTransport::headersByName([
            'HTTP/1.1 429 Too Many Requests',
            'Content-Type: application/json; charset=UTF-8',
            'Retry-After: 17',
            'X-Trace: a',
            'x-trace:b',
            ': no name',
        ]);
        self::assertSame(['content-type' => 'application/json; charset=UTF-8', 'retry-after' => '17', 'x-trace' => 'a, b'], $headers);
        self::assertSame(17, FixedFloatProvider::readRetryAfterSeconds($headers, null));
    }

    public function testThePsr18TransportPassesTheResponseHeadersOn(): void
    {
        $client = new class implements ClientInterface {
            public function sendRequest(RequestInterface $request): ResponseInterface
            {
                return new Response(429, ['Retry-After' => '17', 'Content-Type' => 'application/json'], '{"code":429,"msg":"Rate limit","data":null}');
            }
        };
        $factory = new Psr17Factory();
        $response = (new Psr18Transport($client, $factory, $factory))->request('POST', 'https://swap.test/api/v2/create', [], '{}');
        self::assertSame(429, $response['status']);
        self::assertSame(['retry-after' => '17', 'content-type' => 'application/json'], $response['headers'] ?? null);
        self::assertSame(17, FixedFloatProvider::readRetryAfterSeconds($response['headers'] ?? [], null));
    }

    public function testATransportThatReturnsNoHeadersStillWorks(): void
    {
        $response = (new CallableTransport(static fn (): array => ['status' => 429, 'body' => '{"data":{"retry_after":41}}']))->request('POST', 'https://swap.test/api/v2/create');
        self::assertArrayNotHasKey('headers', $response);
        self::assertSame(41, FixedFloatProvider::readRetryAfterSeconds($response['headers'] ?? [], json_decode($response['body'], true)['data']));
    }
}
