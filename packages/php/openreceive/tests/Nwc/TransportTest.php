<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Nwc;

use dsbaars\nostr\Nip47\Command\CommandInterface;
use dsbaars\nostr\Nip47\NwcClient;
use dsbaars\nostr\Nip47\Response\GetInfoResponse;
use dsbaars\nostr\Nip47\Response\ResponseInterface;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Nwc\NwcRequestError;
use OpenReceive\Nwc\Transport\Nip47Command;
use OpenReceive\Nwc\Transport\NotificationListener;
use OpenReceive\Server\Errors\WalletFailureError;
use OpenReceive\Server\Service;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * The adapter over a stubbed nostr-php-nwc client: kernel-built params go out
 * verbatim, the info event decides the encryption mode, error envelopes become
 * coded failures, and replies are normalized by the kernel. Network paths run
 * only in the live smoke (tools/live-nwc-test/php-smoke.php).
 */
final class TransportTest extends TestCase
{
    use VectorSupport;

    /** @param array<string, mixed> $info @param list<array<string, mixed>> $replies */
    private function stub(array $info, array $replies): NwcClient
    {
        return new class ($info, $replies) extends NwcClient {
            /** @var list<CommandInterface> */
            public array $commands = [];
            public ?string $encryption = null;

            /** @param array<string, mixed> $info @param list<array<string, mixed>> $replies */
            public function __construct(private readonly array $info, private array $replies)
            {
                // Deliberately not calling the parent: no relay, no keys.
            }

            public function getWalletInfo(): GetInfoResponse
            {
                return new GetInfoResponse('get_info', $this->info);
            }

            public function executeCommand(CommandInterface $command, string $responseClass, bool $throwOnError = false): ResponseInterface
            {
                $this->commands[] = $command;
                $reply = array_shift($this->replies) ?? ['result' => null, 'error' => ['code' => 'OTHER', 'message' => 'no scripted reply']];
                return $responseClass::fromArray(['result_type' => $command->getMethod(), ...$reply]);
            }

            public function setEncryption(string $method): void
            {
                $this->encryption = $method;
            }
        };
    }

    public function testRequestsCarryKernelParamsAndRepliesAreNormalized(): void
    {
        $uri = self::vector('nwc-uri-parse')['cases'][0]['uri'];
        $stub = $this->stub(['methods' => ['make_invoice', 'list_transactions', 'get_info'], 'encryption' => ['nip44_v2', 'nip04'], 'notifications' => ['payment_received']], [
            ['result' => ['invoice' => 'lnbc1', 'payment_hash' => str_repeat('a', 64), 'amount' => 200000, 'created_at' => 1000, 'expires_at' => 1600]],
            ['result' => ['transactions' => [['type' => 'incoming', 'payment_hash' => str_repeat('a', 64), 'amount' => 200000, 'settled_at' => 1200, 'state' => 'settled']]]],
            ['error' => ['code' => 'RATE_LIMITED', 'message' => 'slow down']],
        ]);
        $client = new NostrPhpNwcReceiveClient($uri, null, $stub);
        self::assertStringContainsString('secret=[REDACTED]', $client->redactedConnectionUri);
        self::assertStringNotContainsString('bbbbbbbb', $client->redactedConnectionUri);
        $info = $client->preflight();
        self::assertSame('nip44_v2', $stub->encryption, 'the advertised nip44_v2 is preferred');
        self::assertSame(['payment_received'], $info['notifications']);

        $invoice = $client->makeInvoice(['amount_msats' => 200000, 'description' => 'Fruit sticker', 'expiry' => 600, 'metadata' => ['reference' => 'o1']]);
        self::assertSame(['invoice' => 'lnbc1', 'payment_hash' => str_repeat('a', 64), 'amount_msats' => 200000, 'created_at' => 1000, 'expires_at' => 1600], $invoice);
        self::assertSame(['method' => 'make_invoice', 'params' => ['amount' => 200000, 'description' => 'Fruit sticker', 'expiry' => 600, 'metadata' => ['reference' => 'o1']]], $stub->commands[0]->toArray());

        $page = $client->listTransactions(['type' => 'incoming', 'limit' => 20, 'offset' => 0, 'unpaid' => true]);
        self::assertSame('settled', $page['transactions'][0]['transaction_state']);
        self::assertSameRecord(['type' => 'incoming', 'limit' => 20, 'offset' => 0, 'unpaid' => true], $stub->commands[1]->getParams());

        try {
            $client->listTransactions(['type' => 'incoming', 'limit' => 20, 'offset' => 20]);
            self::fail('the error envelope was not raised');
        } catch (NwcRequestError $e) {
            self::assertSame('RATE_LIMITED', $e->errorCode());
            self::assertSame('slow down', $e->getMessage());
        }
    }

    public function testTheServiceMapsAdapterFailuresToTheSharedWalletErrorShape(): void
    {
        $uri = self::vector('nwc-uri-parse')['cases'][0]['uri'];
        $stub = $this->stub(['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']], [
            ['error' => ['code' => 'RATE_LIMITED', 'message' => 'slow down']],
        ]);
        $service = new Service(new NostrPhpNwcReceiveClient($uri, null, $stub), false, []);
        self::assertSame('nip04', $stub->encryption);
        try {
            $service->createCheckout(['reference' => 'o1', 'amount' => ['sats' => 21]]);
            self::fail('no wallet failure');
        } catch (WalletFailureError $e) {
            self::assertSame(503, $e->status);
            self::assertSame('RATE_LIMITED', $e->errorCode);
            self::assertTrue($e->retryable);
            self::assertSame('slow down', $e->getMessage());
        }
    }

    public function testASpendCapableInfoEventRefusesToBoot(): void
    {
        $uri = self::vector('nwc-uri-parse')['cases'][0]['uri'];
        $stub = $this->stub(['methods' => ['make_invoice', 'list_transactions', 'pay_invoice'], 'encryption' => ['nip04']], []);
        $this->expectException(\OpenReceive\Server\Errors\SpendCapableWalletError::class);
        new Service(new NostrPhpNwcReceiveClient($uri, null, $stub), false, []);
    }

    public function testTheRawCommandIsATransparentCarrier(): void
    {
        $command = new Nip47Command('list_transactions', ['limit' => 20, 'offset' => 40]);
        self::assertTrue($command->validate());
        self::assertSame(['method' => 'list_transactions', 'params' => ['limit' => 20, 'offset' => 40]], $command->toArray());
    }

    public function testWebsocketFramesAreDrainedAsCompleteJsonArrays(): void
    {
        $buffer = '["EVENT","s",{"content":"a]b\\"[","kind":23197}]["EOSE","s"]["NOTICE","par';
        $messages = NotificationListener::drainMessages($buffer);
        self::assertSame(['["EVENT","s",{"content":"a]b\\"[","kind":23197}]', '["EOSE","s"]'], $messages);
        self::assertSame('["NOTICE","par', $buffer, 'a partial frame stays buffered');
        $buffer .= 'tial"]';
        self::assertSame(['["NOTICE","partial"]'], NotificationListener::drainMessages($buffer));
        self::assertSame('', $buffer);
    }
}
