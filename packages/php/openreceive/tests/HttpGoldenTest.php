<?php

declare(strict_types=1);

namespace OpenReceive\Tests;

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Server\Psr15Handler;
use OpenReceive\Server\RequestHandler;
use OpenReceive\Server\Service;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;

/**
 * Every spec/test-vectors/http-golden/*.json file against Psr15Handler:
 * full-body comparison (schema_version 2), key set AND values. Placeholder
 * strings assert "present and matching this pattern" for values that differ
 * per run. The matcher table is copied verbatim from tests/http-boundaries.test.mjs
 * and packages/ruby/openreceive-server/test/server_test.rb; change all three together.
 */
final class HttpGoldenTest extends TestCase
{
    use VectorSupport;

    /** @var array<string, callable(mixed): bool> */
    private const GOLDEN_PLACEHOLDERS = [
        '<request_id>' => [self::class, 'isRequestId'],
        '<payment_hash>' => [self::class, 'isPaymentHash'],
        '<bolt11>' => [self::class, 'isBolt11'],
        '<unix_seconds>' => [self::class, 'isUnixSeconds'],
    ];

    public static function isRequestId(mixed $value): bool
    {
        return is_string($value) && preg_match('/\Areq_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/', $value) === 1;
    }

    public static function isPaymentHash(mixed $value): bool
    {
        return is_string($value) && preg_match('/\A[0-9a-f]{64}\z/', $value) === 1;
    }

    public static function isBolt11(mixed $value): bool
    {
        return is_string($value) && str_starts_with($value, 'ln');
    }

    public static function isUnixSeconds(mixed $value): bool
    {
        return is_int($value) && $value >= 0;
    }

    private static function assertGoldenValue(mixed $actual, mixed $expected, string $context): void
    {
        if (is_string($expected) && isset(self::GOLDEN_PLACEHOLDERS[$expected])) {
            self::assertTrue(self::GOLDEN_PLACEHOLDERS[$expected]($actual), "{$context}: " . json_encode($actual) . " does not satisfy {$expected}");
            return;
        }
        if (is_array($expected) && array_is_list($expected) && $expected !== []) {
            self::assertIsArray($actual, "{$context}: expected an array");
            self::assertCount(count($expected), $actual, "{$context}: array length");
            foreach ($expected as $index => $item) {
                self::assertGoldenValue($actual[$index] ?? null, $item, "{$context}[{$index}]");
            }
            return;
        }
        if (is_array($expected) && !array_is_list($expected)) {
            self::assertIsArray($actual, "{$context}: expected an object");
            $expectedKeys = array_keys($expected);
            $actualKeys = array_keys($actual);
            sort($expectedKeys);
            sort($actualKeys);
            self::assertSame($expectedKeys, $actualKeys, "{$context}: key set");
            foreach ($expected as $key => $item) {
                self::assertGoldenValue($actual[$key], $item, "{$context}.{$key}");
            }
            return;
        }
        self::assertSame($expected, $actual, "{$context}: value");
    }

    /** @param callable(): array<string, mixed> $resolve @param (callable(array<string, mixed>): void)|null $onCreated */
    private static function app(Service $service, callable $resolve, ?callable $onCreated = null, ?callable $rateLimit = null): Psr15Handler
    {
        return new Psr15Handler(new RequestHandler(
            $service,
            static fn (): bool => true,
            $resolve,
            $onCreated ?? static function (): void {},
            static function (): void {},
            $rateLimit,
        ), '/openreceive', new Psr17Factory());
    }

    public function testThePsr15HandlerSatisfiesEveryHttpGoldenVector(): void
    {
        $service = new Service(new FakeWallet(), false, []);
        $priceOnly = static fn (): array => ['amount' => ['sats' => 1]];
        // Deterministic settled attempt behind the settled_check vector: the wallet
        // row deliberately carries the preimage and raw invoice, and the exact
        // key-set assertion proves neither leaks into the payer-polled body.
        $settledHash = str_repeat('7f', 32);
        $settledRow = [
            'type' => 'incoming', 'invoice' => 'lnbcgoldensettled', 'payment_hash' => $settledHash, 'amount_msats' => 1000,
            'transaction_state' => 'settled', 'created_at' => 900, 'expires_at' => 1500, 'settled_at' => 950, 'preimage' => str_repeat('1', 64),
        ];
        $settledWallet = new class ($settledRow) implements ReceiveNwcClient {
            /** @param array<string, mixed> $row */
            public function __construct(private readonly array $row)
            {
            }

            public function makeInvoice(array $request): array
            {
                throw new \RuntimeException('the settled_check golden handler mints nothing');
            }

            public function listTransactions(array $request): array
            {
                return ['transactions' => [$this->row]];
            }

            public function preflight(): array
            {
                return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']];
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
            }
        };
        $settledCheckout = [
            'reference' => 'order-golden-settled', 'payment_hash' => $settledHash, 'bolt11' => 'lnbcgoldensettled',
            'amount_msats' => 1000, 'created_at' => 900, 'expires_at' => 1500, 'fiat_quote' => null,
        ];
        $apps = [
            'default' => self::app($service, $priceOnly),
            'rate_limited' => self::app($service, $priceOnly, null, static fn (): bool => false),
            'settled_check' => self::app(
                new Service($settledWallet, false, [], ['USD'], static fn (): int => 1000),
                static fn (): array => ['amount' => ['sats' => 1], 'payment_hash' => $settledHash, 'checkout' => $settledCheckout],
            ),
            // A repository refusing a second live attempt on the same rail: ONE agreed string across engines.
            'live_attempt_conflict' => self::app($service, $priceOnly, static function (): void {
                throw new ConflictError('An unpaid checkout for this payment method is already in progress for this reference.');
            }),
            // `description` rides the prepare and create responses and NOTHING else.
            'described' => self::app($service, static fn (): array => ['amount' => ['sats' => 1], 'description' => '2 kg Ataulfo mangoes']),
        ];
        $factory = new Psr17Factory();
        $paths = glob(self::vectorsDir() . '/http-golden/*.json') ?: [];
        sort($paths);
        self::assertNotEmpty($paths);
        foreach ($paths as $path) {
            $vector = self::readJson($path);
            self::assertSame(2, $vector['schema_version'], "{$path}: schema_version");
            $request = $vector['request'];
            $app = $apps[$vector['handler'] ?? 'default'] ?? null;
            self::assertNotNull($app, "{$path}: no golden handler named " . ($vector['handler'] ?? 'default'));
            $psr = $factory->createServerRequest($request['method'], 'http://test' . $request['path'])
                ->withHeader('content-type', $request['content_type'] ?? 'application/json');
            foreach ($request['headers'] ?? [] as $name => $value) {
                $psr = $psr->withHeader($name, $value);
            }
            if (isset($request['body_bytes'])) {
                $psr = $psr->withBody($factory->createStream(str_repeat('x', $request['body_bytes'])));
            } elseif (isset($request['body'])) {
                $psr = $psr->withBody($factory->createStream(json_encode($request['body'], JSON_THROW_ON_ERROR)));
            }
            $response = $app->handle($psr);
            self::assertSame($vector['expected']['status'], $response->getStatusCode(), $vector['name']);
            foreach ($vector['expected']['headers'] ?? [] as $name => $value) {
                self::assertGoldenValue($response->getHeaderLine($name), $value, "{$vector['name']}: header {$name}");
            }
            $body = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
            self::assertGoldenValue($body, $vector['expected']['body'], "{$vector['name']}: body");
        }
    }
}
