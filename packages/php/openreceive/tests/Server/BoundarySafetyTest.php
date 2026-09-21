<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Errors\HttpError;
use OpenReceive\Server\RequestHandler;
use OpenReceive\Server\Service;
use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;

final class BoundarySafetyTest extends TestCase
{
    private function handler(Service $service, array $resolved = [], ?\Psr\Log\LoggerInterface $logger = null): RequestHandler
    {
        return new RequestHandler($service, static fn (): bool => true, static fn (): array => $resolved,
            static fn () => null, static fn () => null, logger: $logger);
    }

    public function testPublicErrorsAndDiagnosticContextExcludeNestedCredentials(): void
    {
        $logger = new class extends AbstractLogger {
            public array $events = [];
            public function log($level, string|\Stringable $message, array $context = []): void { $this->events[] = [$message, $context]; }
        };
        $handler = $this->handler(new Service(new FakeWallet(), false, []), logger: $logger);
        $error = new HttpError(503, 'WALLET_UNAVAILABLE', 'via NOSTR+WALLETCONNECT:invalid-fixture?secret=invalid-secret', true,
            ['provider_token' => 'invalid-token', 'cause' => ['stack' => 'invalid-secret']]);
        [$status, , $body] = $handler->errorResponse($error, 'safe-request');
        self::assertSame(503, $status);
        self::assertSame('WALLET_UNAVAILABLE', $body['code']);
        self::assertTrue($body['retryable']);
        self::assertSame('via [REDACTED_NWC]', $body['message']);
        self::assertArrayNotHasKey('details', $body);
        self::assertSame('invalid-token', $error->details['provider_token'], 'projection must not alter its source');
        $handler->errorResponse(new \RuntimeException('invalid-secret'), 'safe-request');
        self::assertCount(1, $logger->events);
        self::assertStringNotContainsString('invalid-secret', json_encode($logger->events));
        self::assertSame([], $logger->events[0][1], 'no raw exception attached to the host logger');
    }

    public function testInvalidHostAmountsAre500BeforeAnyWalletMint(): void
    {
        $wallet = new class implements ReceiveNwcClient {
            public int $mints = 0;
            public function preflight(): array { return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']]; }
            public function makeInvoice(array $request): array { $this->mints++; throw new \LogicException('must not mint'); }
            public function listTransactions(array $request): array { return ['transactions' => []]; }
            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void {}
        };
        foreach ([['sats' => 0], ['sats' => 1.5], ['currency' => 'USD', 'value' => -1], ['currency' => 'INVALID', 'value' => '1']] as $amount) {
            $handler = $this->handler(new Service($wallet, false, []), ['amount' => $amount]);
            [$status, , $body] = $handler->createCheckout('{"reference":"order"}', ['CONTENT_TYPE' => 'application/json'], 'request');
            self::assertSame(500, $status);
            self::assertSame('INTERNAL', $body['code']);
        }
        self::assertSame(0, $wallet->mints);
    }

    public function testIncompleteRefundNetworkFailsBeforeProviderIo(): void
    {
        $provider = new FakeSwapProvider();
        $service = new Service(new FakeWallet(), false, [$provider]);
        foreach ([null, 'UNKNOWN_NETWORK'] as $asset) {
            $data = ['version' => 1, 'provider_order' => ['provider' => $provider->name(), 'provider_order_id' => 'synthetic-order']];
            if ($asset !== null) $data['provider_order']['pay_in_asset'] = $asset;
            $handler = $this->handler($service, ['payment_hash' => str_repeat('a', 64), 'swap_data' => $data]);
            [$status, , $body] = $handler->refundSwap(json_encode(['reference' => 'order', 'payment_hash' => str_repeat('a', 64), 'refund_address' => 'invalid-address']), ['CONTENT_TYPE' => 'application/json'], 'request');
            self::assertSame(500, $status);
            self::assertSame('INTERNAL', $body['code']);
        }
        self::assertSame(0, $provider->counters()['status_calls']);
        self::assertSame([], $provider->counters()['refund_calls']);
    }
}
