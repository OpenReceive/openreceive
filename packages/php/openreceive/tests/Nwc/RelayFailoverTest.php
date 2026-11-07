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
        $timeouts = [];
        $socket = new ScriptedRelaySocket(function (array $message): string {
            return $message[0] === 'EVENT' ? $this->response($message[1], 'list_transactions', ['transactions' => [['payment_hash' => str_repeat('a', 64), 'settled_at' => 1234]]]) : '';
        });
        $connection = $this->connection();
        $connector = new RelayConnector($connection['relays'], function (string $relay, float $timeout) use (&$calls, &$timeouts, $socket) {
            $calls[] = $relay;
            $timeouts[] = $timeout;
            if (count($calls) === 1) throw new \RuntimeException('connection refused');
            return $socket;
        });
        $rpc = new RelayRpcClient($connection, $connector);
        $result = $rpc->execute(new Nip47Command('list_transactions', ['limit' => 20]));
        self::assertSame(1234, $result->transactions[0]->settled_at);
        self::assertSame($connection['relays'], $calls);
        // Of the 8 s deadline the first of two relays may take a third: the second relay and the request share the rest.
        self::assertEqualsWithDelta(8.0 / 3, $timeouts[0], 0.1);
        // The first refused at once, so the second gets the full handshake and still leaves half for the request.
        self::assertEqualsWithDelta(RelayConnector::HANDSHAKE_SECONDS, $timeouts[1], 0.1);
        self::assertLessThanOrEqual(RelayConnector::HANDSHAKE_SECONDS, $timeouts[1]);
        self::assertSame(1, $socket->dispatches);
        self::assertFalse($socket->closed, 'kept open for the next history page');
        self::assertNotEmpty($socket->sent[1][1]['sig'], 'the request is signed');
        unset($rpc);
        self::assertTrue($socket->closed);
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

    public function testReadOnlyExchangesShareOneSocketAndAMintOpensItsOwn(): void
    {
        $connection = $this->connection();
        $sockets = [];
        $connector = new RelayConnector($connection['relays'], function () use (&$sockets): ScriptedRelaySocket {
            return $sockets[] = new ScriptedRelaySocket(fn (array $message): string => $message[0] === 'EVENT'
                ? $this->response($message[1], 'list_transactions', ['transactions' => []]) : '');
        });
        $rpc = new RelayRpcClient($connection, $connector, timeoutSeconds: 0.3);
        foreach ([1, 2, 3] as $page) {
            $rpc->execute(new Nip47Command('list_transactions', ['offset' => $page * 20]));
        }
        self::assertCount(1, $sockets, 'one reconcile pass, one relay connection');
        self::assertSame(3, $sockets[0]->dispatches);
        self::assertSame(3, count(array_filter($sockets[0]->sent, static fn (array $m): bool => $m[0] === 'CLOSE')), 'each page ends its own subscription');
        self::assertFalse($sockets[0]->closed);

        try {
            $rpc->execute(new Nip47Command('make_invoice', ['amount' => 1000]));
            self::fail('the scripted relay never answers a mint');
        } catch (WalletUnavailableError) {
        }
        self::assertCount(2, $sockets, 'a mint never rides the kept socket');
        self::assertTrue($sockets[1]->closed);
        self::assertSame(3, $sockets[0]->dispatches);

        $rpc->execute(new Nip47Command('list_transactions', []));
        self::assertCount(2, $sockets);
        self::assertSame(4, $sockets[0]->dispatches);
        unset($rpc);
        self::assertTrue($sockets[0]->closed, 'the kept socket closes with the client');
    }

    public function testAKeptSocketTheRelayDroppedFailsOverWithoutSpendingTheRelaysTurn(): void
    {
        $connection = [...$this->connection(), 'relays' => ['wss://only.invalid']];
        $reply = fn (array $message): string => $message[0] === 'EVENT' ? $this->response($message[1], 'list_transactions', ['transactions' => []]) : '';
        $sockets = [new ScriptedRelaySocket($reply, dropAfterDispatches: 1), new ScriptedRelaySocket($reply)];
        $opened = [];
        $connector = new RelayConnector($connection['relays'], static function () use (&$sockets, &$opened) { return $opened[] = array_shift($sockets); });
        $rpc = new RelayRpcClient($connection, $connector);
        $rpc->execute(new Nip47Command('list_transactions', []));
        // The only relay dropped the idle socket; the next page reconnects instead of failing.
        self::assertEquals((object) ['transactions' => []], $rpc->execute(new Nip47Command('list_transactions', [])));
        self::assertCount(2, $opened);
        self::assertTrue($opened[0]->closed);
        self::assertSame(1, $opened[1]->dispatches);
    }

    public function testConnectionFailureAndCancellationHaveBoundedAttempts(): void
    {
        $calls = 0;
        $connector = new RelayConnector($this->connection()['relays'], static function () use (&$calls) { $calls++; throw new \RuntimeException('offline'); });
        // One second is too short for a second round after the pause: each relay is tried once.
        try { $connector->open(microtime(true) + 1); self::fail('offline'); } catch (WalletUnavailableError) { }
        self::assertSame(2, $calls);
        $calls = 0;
        try { $connector->open(microtime(true) + 1, cancelled: static function () use (&$calls): bool { return $calls > 0; }); self::fail('cancelled'); } catch (WalletUnavailableError) { }
        self::assertSame(1, $calls);

        // Cancellation also ends the pause before a retry at once.
        $calls = 0;
        $only = new RelayConnector(['wss://only.invalid'], static function () use (&$calls) { $calls++; throw new \RuntimeException('offline'); });
        $started = microtime(true);
        try { $only->open($started + 8, cancelled: static function () use (&$calls): bool { return $calls > 0; }); self::fail('cancelled'); } catch (WalletUnavailableError) { }
        self::assertSame(1, $calls);
        self::assertLessThan(RelayConnector::RETRY_PAUSE_SECONDS, microtime(true) - $started);
    }

    public function testTheOnlyRelayGetsAHandshakeLongEnoughForASlowHost(): void
    {
        // Handshakes to a one-relay wallet measured up to 3.24 s from a shop container; one second failed them.
        $timeouts = [];
        $socket = new ScriptedRelaySocket(static fn (): string => '');
        $connector = new RelayConnector(['wss://only.invalid'], static function (string $relay, float $timeout) use (&$timeouts, $socket) {
            $timeouts[] = $timeout;
            return $socket;
        });
        self::assertSame($socket, $connector->open(microtime(true) + 8.0));
        self::assertCount(1, $timeouts);
        self::assertGreaterThanOrEqual(3.5, $timeouts[0]);
        self::assertLessThanOrEqual(RelayConnector::HANDSHAKE_SECONDS, $timeouts[0]);
    }

    public function testTheOnlyRelayIsTriedAgainAfterAFailedHandshake(): void
    {
        $calls = [];
        $socket = new ScriptedRelaySocket(static fn (): string => '');
        $connector = new RelayConnector(['wss://only.invalid'], static function (string $relay, float $timeout) use (&$calls, $socket) {
            $calls[] = [$relay, $timeout, microtime(true)];
            // The first handshake ends as a timed-out one does: with an exception.
            if (count($calls) === 1) throw new \RuntimeException('Connection timed out');
            return $socket;
        });
        self::assertSame($socket, $connector->open(microtime(true) + 8.0));
        self::assertCount(2, $calls);
        self::assertSame('wss://only.invalid', $calls[1][0]);
        self::assertGreaterThanOrEqual(RelayConnector::MIN_RETRY_SECONDS, $calls[1][1]);
        self::assertGreaterThanOrEqual(RelayConnector::RETRY_PAUSE_SECONDS - 0.01, $calls[1][2] - $calls[0][2], 'paused before the retry');
    }

    public function testAMintThroughTheOnlyRelaySurvivesAFailedHandshake(): void
    {
        $connection = [...$this->connection(), 'relays' => ['wss://only.invalid']];
        $socket = new ScriptedRelaySocket(fn (array $message): string => $message[0] === 'EVENT'
            ? $this->response($message[1], 'make_invoice', ['invoice' => 'lnbc1test', 'payment_hash' => str_repeat('b', 64)]) : '');
        $calls = 0;
        $connector = new RelayConnector($connection['relays'], static function () use (&$calls, $socket) {
            if (++$calls === 1) throw new \RuntimeException('Connection timed out');
            return $socket;
        });
        $result = (new RelayRpcClient($connection, $connector))->execute(new Nip47Command('make_invoice', ['amount' => 1000]));
        self::assertSame(str_repeat('b', 64), $result->payment_hash);
        self::assertSame(2, $calls);
        self::assertSame(1, $socket->dispatches, 'nothing was dispatched before the handshake succeeded');
    }

    public function testADeadFirstRelayLeavesTheSecondAHandshakeAndTimeForTheRequest(): void
    {
        $timeouts = [];
        $socket = new ScriptedRelaySocket(static fn (): string => '');
        $connector = new RelayConnector($this->connection()['relays'], static function (string $relay, float $timeout) use (&$timeouts, $socket) {
            $timeouts[] = $timeout;
            if (count($timeouts) === 1) {
                // A black-holed relay uses its whole handshake budget.
                usleep((int) ($timeout * 1_000_000));
                throw new \RuntimeException('Connection timed out');
            }
            return $socket;
        });
        $deadline = microtime(true) + 1.5;
        self::assertSame($socket, $connector->open($deadline));
        self::assertEqualsWithDelta(0.5, $timeouts[0], 0.05);
        self::assertEqualsWithDelta(0.5, $timeouts[1], 0.05);
        // Had the second handshake used all of its budget, as much again is left for the request.
        self::assertGreaterThanOrEqual($timeouts[1] - 0.05, $deadline - microtime(true) - $timeouts[1]);
    }

    public function testARelayThatRefusesAtOnceIsRetriedWithPausesUntilTheDeadline(): void
    {
        $times = [];
        $ticks = 0;
        $connector = new RelayConnector(['wss://only.invalid'], static function () use (&$times) {
            $times[] = microtime(true);
            throw new \RuntimeException('connection refused');
        });
        $started = microtime(true);
        try {
            $connector->open($started + 3.0, static function () use (&$ticks): void { $ticks++; });
            self::fail('offline');
        } catch (WalletUnavailableError $error) {
            self::assertSame('Configured NWC relays are unavailable.', $error->getMessage());
        }
        // 0 s, then after 0.25 s and 0.5 s pauses; after a 1 s pause the retry's share would be under MIN_RETRY_SECONDS.
        self::assertCount(3, $times);
        self::assertSame(3, $ticks, 'the idle tick runs on every attempt');
        self::assertGreaterThanOrEqual(RelayConnector::RETRY_PAUSE_SECONDS - 0.01, $times[1] - $times[0]);
        self::assertGreaterThanOrEqual(2 * RelayConnector::RETRY_PAUSE_SECONDS - 0.01, $times[2] - $times[1]);
        self::assertLessThan($started + 1.0, microtime(true), 'gave up without sleeping out the deadline');
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

    /** @param int|null $dropAfterDispatches answer this many requests, then go silent and report EOF (a relay dropping the socket) */
    public function __construct(callable $reply, private readonly bool $disconnectAfterDispatch = false, private readonly ?int $dropAfterDispatches = null)
    {
        parent::__construct(fopen('php://temp', 'r+'));
        $this->reply = \Closure::fromCallable($reply);
    }

    public function write($string): int
    {
        $message = json_decode($string, true, flags: JSON_THROW_ON_ERROR);
        $this->sent[] = $message;
        if ($message[0] === 'EVENT') $this->dispatches++;
        if (!$this->dropped()) $this->inbound .= ($this->reply)($message);
        return strlen($string);
    }

    private function dropped(): bool
    {
        return $this->dropAfterDispatches !== null && $this->dispatches > $this->dropAfterDispatches;
    }

    public function read($length): string
    {
        $next = substr($this->inbound, 0, $length);
        $this->inbound = substr($this->inbound, strlen($next));
        return $next;
    }

    public function eof(): bool { return ($this->disconnectAfterDispatch && $this->dispatches > 0) || $this->dropped(); }
    public function close(): void { $this->closed = true; parent::close(); }
}
