<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Nwc;

use OpenReceive\Nwc\Transport\Nip47Command;
use OpenReceive\Nwc\Transport\RelayRpcClient;
use PHPUnit\Framework\TestCase;
use swentel\nostr\Encryption\Nip04;
use swentel\nostr\Key\Key;

/**
 * The real websocket path: RelayRpcClient over the RelayConnector it builds
 * itself, so Guzzle's stream handler, the websocket middleware and the
 * whole-frame buffer RelayConnector::websocket() puts between them, against a
 * throwaway relay (split-frame-relay.php) on a free 127.0.0.1 port.
 * WholeFrameStreamTest covers the buffer alone and RelayFailoverTest scripts
 * the socket, so this is the test that fails when the connector stops
 * installing the buffer.
 *
 * The relay is plain ws://. The connector and the websocket middleware accept
 * ws:// as they accept wss://; only the connection-string parser (Uri::parse)
 * insists on wss, and this connection is built as an array, as
 * RelayFailoverTest builds its own. TLS would add a certificate to the test
 * and nothing to the code under test: the buffer sits on the socket either
 * way, and the relay splits the frame itself, as TLS records split it.
 */
final class RelayWebsocketTest extends TestCase
{
    /** A TLS record's largest payload: the size a real relay's reply arrives in. */
    private const PIECE_BYTES = 16_384;
    /** Long enough that the client polls between pieces and reads a partial frame. */
    private const PAUSE_MS = 40;

    /** @var resource|null */
    private $relay = null;
    /** @var array<int, resource> */
    private array $pipes = [];

    protected function tearDown(): void
    {
        foreach ($this->pipes as $pipe) {
            if (is_resource($pipe)) fclose($pipe);
        }
        if (is_resource($this->relay)) {
            // Stops only the relay this test started; its port closes with it.
            proc_terminate($this->relay);
            proc_close($this->relay);
        }
    }

    public function testAPageOfTransactionsTheRelaySendsInPiecesArrivesWhole(): void
    {
        $walletSecret = str_repeat('1', 64);
        $clientSecret = str_repeat('2', 64);
        $walletPubkey = (new Key())->getPublicKey($walletSecret);
        $rows = [];
        for ($i = 0; $i < 20; $i++) {
            $rows[] = ['type' => 'incoming', 'state' => 'settled', 'payment_hash' => hash('sha256', "payment {$i}"),
                'invoice' => 'lnbc50u1p' . str_repeat(hash('sha256', "invoice {$i}"), 22), 'amount' => 5_000_000 + $i,
                'settled_at' => 1_700_000_000 + $i];
        }
        $plain = json_encode(['result_type' => 'list_transactions', 'result' => ['transactions' => $rows]], JSON_THROW_ON_ERROR);
        $reply = json_encode(['EVENT', 'rpc', ['kind' => 23195, 'pubkey' => $walletPubkey, 'tags' => [['e', '{request-id}']],
            'content' => Nip04::encrypt($plain, $walletSecret, (new Key())->getPublicKey($clientSecret))]], JSON_THROW_ON_ERROR);
        self::assertGreaterThan(2 * self::PIECE_BYTES, strlen($reply), 'the frame spans at least three pieces');

        $connection = ['wallet_pubkey' => $walletPubkey, 'client_secret' => $clientSecret, 'relays' => [$this->startRelay($reply)]];
        $rpc = new RelayRpcClient($connection, timeoutSeconds: 3.0);
        $result = $rpc->execute(new Nip47Command('list_transactions', ['limit' => 20]));

        self::assertEquals(json_decode(json_encode($rows, JSON_THROW_ON_ERROR), false), $result->transactions);
    }

    /** Starts the relay with the reply it will send and returns its ws:// URL. */
    private function startRelay(string $reply): string
    {
        $relay = proc_open(
            [PHP_BINARY, __DIR__ . '/split-frame-relay.php', (string) self::PIECE_BYTES, (string) self::PAUSE_MS],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => STDERR],
            $this->pipes,
        );
        self::assertIsResource($relay);
        $this->relay = $relay;
        fwrite($this->pipes[0], $reply);
        fclose($this->pipes[0]);
        $read = [$this->pipes[1]];
        $write = $except = null;
        self::assertSame(1, stream_select($read, $write, $except, 5), 'the relay printed its address');
        $address = trim((string) fgets($this->pipes[1]));
        self::assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $address);
        return "ws://{$address}";
    }
}
