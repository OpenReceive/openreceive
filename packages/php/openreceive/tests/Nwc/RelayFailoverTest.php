<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Nwc;

use GuzzleHttp\Psr7\Stream;
use OpenReceive\Nwc\Transport\Nip47Command;
use OpenReceive\Nwc\Transport\NotificationListener;
use OpenReceive\Nwc\Transport\RelayConnector;
use OpenReceive\Nwc\Transport\RelayRpcClient;
use OpenReceive\Nwc\WalletUnavailableError;
use PHPUnit\Framework\TestCase;
use swentel\nostr\Encryption\Nip04;
use swentel\nostr\Key\Key;

/** Real encryption and signed requests over disposable scripted relay sockets. */
final class RelayFailoverTest extends TestCase
{
    public function testRpcRetainsOptionalObjectsAndRejectsScalarOnlyHistoryPages(): void
    {
        $connection = $this->connection();
        foreach ([[new \stdClass(), [], null, 7], [[], null, 7]] as $rows) {
            $socket = new ScriptedRelaySocket(fn (array $message): string => $message[0] === 'EVENT'
                ? $this->response($message[1], 'list_transactions', ['transactions' => $rows]) : '');
            $connector = new RelayConnector($connection['relays'], static fn () => $socket);
            $raw = (new RelayRpcClient($connection, $connector))->execute(new Nip47Command('list_transactions', []));
            try {
                $page = \OpenReceive\Nwc\Requests::normalizeListTransactionsResponse($raw);
                self::assertCount(4, $rows, 'scalar-only page must fail');
                self::assertCount(1, $page['transactions']);
                self::assertSame(3, $page['skipped_rows']);
            } catch (\InvalidArgumentException $error) {
                self::assertCount(3, $rows);
                self::assertStringContainsString('no usable rows', $error->getMessage());
            }
        }
    }

    private function connection(): array
    {
        return ['wallet_pubkey' => (new Key())->getPublicKey(str_repeat('1', 64)),
            'client_secret' => str_repeat('2', 64), 'relays' => ['wss://first.invalid', 'wss://second.invalid']];
    }

    private function response(array $request, string $method, array $result): string
    {
        $connection = $this->connection();
        $plain = json_encode(['result_type' => $method, 'result' => $result], JSON_THROW_ON_ERROR);
        return json_encode(['EVENT', 'rpc', ['kind' => 23195, 'pubkey' => $connection['wallet_pubkey'],
            'tags' => [['e', $request['id']]],
            'content' => Nip04::encrypt($plain, str_repeat('1', 64), (new Key())->getPublicKey($connection['client_secret']))]], JSON_THROW_ON_ERROR);
    }

    public function testFirstRelayRefusesAndHistoryRpcUsesAuthenticatedSecondRelay(): void
    {
        $calls = [];
        $socket = new ScriptedRelaySocket(function (array $message): string {
            return $message[0] === 'EVENT' ? $this->response($message[1], 'list_transactions', ['transactions' => [['payment_hash' => str_repeat('a', 64), 'settled_at' => 1234]]]) : '';
        });
        $connection = $this->connection();
        $connector = new RelayConnector($connection['relays'], function (string $relay, float $timeout) use (&$calls, $socket) {
            $calls[] = $relay;
            self::assertLessThanOrEqual(1.0, $timeout);
            if (count($calls) === 1) throw new \RuntimeException('connection refused');
            return $socket;
        });
        $rpc = new RelayRpcClient($connection, $connector);
        $result = $rpc->execute(new Nip47Command('list_transactions', ['limit' => 20]));
        self::assertSame(1234, $result->transactions[0]->settled_at);
        self::assertSame($connection['relays'], $calls);
        self::assertSame(1, $socket->dispatches);
        self::assertTrue($socket->closed);
        self::assertNotEmpty($socket->sent[1][1]['sig'], 'the request is signed');
    }

    public function testLostInvoiceResponseNeverDispatchesAnotherMint(): void
    {
        $calls = 0;
        $socket = new ScriptedRelaySocket(static fn (): string => '', disconnectAfterDispatch: true);
        $connection = $this->connection();
        $connector = new RelayConnector($connection['relays'], function () use (&$calls, $socket) { $calls++; return $socket; });
        try {
            (new RelayRpcClient($connection, $connector))->execute(new Nip47Command('make_invoice', ['amount' => 1000]));
            self::fail('uncertain mint must fail');
        } catch (WalletUnavailableError $error) {
            self::assertTrue($error->retryable);
            self::assertStringContainsString('uncertain after dispatch', $error->getMessage());
        }
        self::assertSame(1, $calls);
        self::assertSame(1, $socket->dispatches);
        self::assertTrue($socket->closed);
    }

    public function testReadOnlyDisconnectFailsOverAndClosesEverySocket(): void
    {
        $first = new ScriptedRelaySocket(static fn (): string => '', disconnectAfterDispatch: true);
        $second = new ScriptedRelaySocket(fn (array $message): string => $message[0] === 'EVENT' ? $this->response($message[1], 'list_transactions', ['transactions' => []]) : '');
        $sockets = [$first, $second];
        $connection = $this->connection();
        $connector = new RelayConnector($connection['relays'], static function () use (&$sockets) { return array_shift($sockets); });
        self::assertEquals((object) ['transactions' => []], (new RelayRpcClient($connection, $connector))->execute(new Nip47Command('list_transactions', [])));
        self::assertTrue($first->closed);
        self::assertTrue($second->closed);
        self::assertSame([], $sockets);
    }

    public function testConnectionFailureAndCancellationHaveBoundedAttempts(): void
    {
        $calls = 0;
        $connector = new RelayConnector($this->connection()['relays'], static function () use (&$calls) { $calls++; throw new \RuntimeException('offline'); });
        try { $connector->open(microtime(true) + 1); self::fail('offline'); } catch (WalletUnavailableError) { }
        self::assertSame(2, $calls);
        $calls = 0;
        try { $connector->open(microtime(true) + 1, cancelled: static function () use (&$calls): bool { return $calls > 0; }); self::fail('cancelled'); } catch (WalletUnavailableError) { }
        self::assertSame(1, $calls);
    }

    public function testNotificationsFailOverAuthenticateAndCloseOnStop(): void
    {
        $connection = $this->connection();
        $plain = json_encode(['notification_type' => 'payment_received', 'notification' => ['payment_hash' => str_repeat('a', 64), 'settled_at' => 1234]], JSON_THROW_ON_ERROR);
        $event = ['kind' => 23196, 'pubkey' => $connection['wallet_pubkey'], 'tags' => [],
            'content' => Nip04::encrypt($plain, str_repeat('1', 64), (new Key())->getPublicKey($connection['client_secret']))];
        $socket = new ScriptedRelaySocket(static fn (array $message): string => $message[0] === 'REQ'
            ? json_encode(['EVENT', $message[1], [...$event, 'pubkey' => str_repeat('f', 64)]], JSON_THROW_ON_ERROR) . json_encode(['EVENT', $message[1], $event], JSON_THROW_ON_ERROR) : '');
        $calls = 0;
        $connector = new RelayConnector($connection['relays'], static function () use (&$calls, $socket) {
            if (++$calls === 1) throw new \RuntimeException('offline first relay');
            return $socket;
        });
        $listener = new NotificationListener($connection, connector: $connector);
        $received = [];
        $listener->listen(function (array $notification) use ($listener, &$received): void { $received[] = $notification; $listener->stop(); });
        self::assertCount(1, $received, 'wrong author ignored; one subscription callback');
        self::assertSame(1234, $received[0]['notification']['settled_at']);
        self::assertSame(2, $calls);
        self::assertTrue($socket->closed);
    }
}

final class ScriptedRelaySocket extends Stream
{
    public array $sent = [];
    public int $dispatches = 0;
    public bool $closed = false;
    private string $inbound = '';
    private readonly \Closure $reply;

    public function __construct(callable $reply, private readonly bool $disconnectAfterDispatch = false)
    {
        parent::__construct(fopen('php://temp', 'r+'));
        $this->reply = \Closure::fromCallable($reply);
    }

    public function write($string): int
    {
        $message = json_decode($string, true, flags: JSON_THROW_ON_ERROR);
        $this->sent[] = $message;
        if ($message[0] === 'EVENT') $this->dispatches++;
        $this->inbound .= ($this->reply)($message);
        return strlen($string);
    }

    public function read($length): string
    {
        $next = substr($this->inbound, 0, $length);
        $this->inbound = substr($this->inbound, strlen($next));
        return $next;
    }

    public function eof(): bool { return $this->disconnectAfterDispatch && $this->dispatches > 0; }
    public function close(): void { $this->closed = true; parent::close(); }
}
