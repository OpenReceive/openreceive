<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\Http\TransportException;
use OpenReceive\Swap\FixedFloatApiError;
use OpenReceive\Swap\FixedFloatProvider;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Swap\WeightBudgetError;
use PHPUnit\Framework\TestCase;

// The transport without WordPress: wp_remote_request answers with the array
// WordPress builds, and its header dictionary is any iterable of name => value.
function wp_remote_request(string $url, array $args): mixed
{
    WpHttpTransportTest::$requests[] = ['url' => $url] + $args;
    return WpHttpTransportTest::$response;
}
function is_wp_error(mixed $thing): bool { return $thing instanceof \RuntimeException; }
function wp_remote_retrieve_response_code(mixed $response): int|string { return $response['response']['code'] ?? ''; }
function wp_remote_retrieve_body(mixed $response): string { return $response['body'] ?? ''; }
function wp_remote_retrieve_headers(mixed $response): iterable { return $response['headers'] ?? []; }

final class WpHttpTransportTest extends TestCase
{
    public static array $requests = [];
    public static mixed $response = null;

    protected function setUp(): void
    {
        self::$requests = [];
        self::$response = null;
    }

    public function testTheResponseHeadersComeBackByLowerCaseName(): void
    {
        // WordPress hands headers back in a case-insensitive dictionary object; a repeated header is a list.
        self::$response = [
            'response' => ['code' => 429],
            'body' => '{"code":429,"msg":"Rate limit","data":null}',
            'headers' => new \ArrayObject(['retry-after' => '17', 'content-type' => 'application/json', 'x-trace' => ['a', 'b']]),
        ];
        $answer = (new WpHttpTransport())->request('POST', 'https://swap.test/api/v2/create', ['X-API-KEY' => 'k'], '{}', 2_500);
        self::assertSame(429, $answer['status']);
        self::assertSame('{"code":429,"msg":"Rate limit","data":null}', $answer['body']);
        self::assertSame(['retry-after' => '17', 'content-type' => 'application/json', 'x-trace' => 'a, b'], $answer['headers']);
        self::assertSame(['url' => 'https://swap.test/api/v2/create', 'method' => 'POST', 'headers' => ['X-API-KEY' => 'k'], 'body' => '{}', 'timeout' => 3, 'redirection' => 0], self::$requests[0]);

        self::$response = ['response' => ['code' => 200], 'body' => 'ok', 'headers' => ['Retry-After' => '9']];
        self::assertSame(['retry-after' => '9'], (new WpHttpTransport())->request('GET', 'https://swap.test/')['headers']);
        self::$response = ['response' => ['code' => 200], 'body' => 'ok'];
        self::assertSame([], (new WpHttpTransport())->request('GET', 'https://swap.test/')['headers']);
    }

    public function testASwapProviders429WaitReachesItsRequestGuard(): void
    {
        self::$response = ['response' => ['code' => 429], 'body' => '{"code":429,"msg":"Rate limit","data":null}', 'headers' => new \ArrayObject(['retry-after' => '17'])];
        $clock = static fn (): int => 5_000;
        $provider = new FixedFloatProvider('synthetic-key', 'synthetic-secret', 'swap', 'https://lightning-swap.com', null, new WpHttpTransport(), $clock);
        $guard = new WeightBudget('swap', $clock, $provider->limits());
        $provider->attachWeightBudget($guard);
        $order = ['provider' => 'swap', 'provider_order_id' => 'ORD1', 'provider_token' => 'fixture-private-token', 'pay_in_asset' => 'USDT_TRON', 'deposit_address' => 'T1', 'deposit_amount' => '1', 'expires_at' => 9, 'state' => 'awaiting_deposit'];
        try {
            $provider->getStatus($order);
            self::fail('The 429 must raise.');
        } catch (FixedFloatApiError $error) {
            self::assertSame('rate_limited', $error->kind);
        }
        try {
            $guard->assertAvailable('order');
            self::fail('The guard must stand off.');
        } catch (WeightBudgetError $error) {
            // The wait the header named, not the minute a 429 without one gets.
            self::assertSame(5_017, $error->denial['backoff_until']);
        }
    }

    public function testAFailedRequestIsATransportError(): void
    {
        self::$response = new \RuntimeException('stands in for WP_Error');
        $this->expectException(TransportException::class);
        (new WpHttpTransport())->request('POST', 'https://swap.test/api/v2/create');
    }
}
