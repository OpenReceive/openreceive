<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\StreamHandler;
use GuzzleHttp\HandlerStack;
use OpenReceive\Nwc\Uri;
use swentel\nostr\Encryption\Nip04;
use swentel\nostr\Encryption\Nip44;
use swentel\nostr\Key\Key;
use Valtzu\WebSocketMiddleware\WebSocketMiddleware;

/**
 * A blocking NWC-02 subscription over the same websocket middleware the
 * bundled nostr-php-nwc client uses. Written here because the library's own
 * NwcNotificationListener decrypts NIP-04 only (kind 23196), re-types the
 * payload (dropping `state`), and never returns on a dead socket. This one
 * subscribes to kinds 23196 and 23197, decrypts each event with the
 * connection key (the wallet's pubkey + the client's secret: an event from
 * any other author cannot decrypt, and the filter is author-bound too),
 * forwards the raw NWC-02 payload, and ENDS — by throwing — when the socket
 * closes, so the worker's resubscribe backoff can take over.
 */
final class NotificationListener
{
    public const NIP04_KIND = 23196;
    public const NIP44_KIND = 23197;

    private readonly string $walletPubkey;
    private readonly string $clientSecret;
    private readonly string $clientPubkey;
    /** @var list<string> */
    private readonly array $relays;
    private bool $running = false;

    /** @param array{wallet_pubkey: string, relays: list<string>, client_secret: string} $connection the Uri::parse result */
    public function __construct(array $connection, private readonly int $lookbackSeconds = 60, private readonly ?int $idleTimeoutSeconds = 120)
    {
        $this->walletPubkey = $connection['wallet_pubkey'];
        $this->clientSecret = $connection['client_secret'];
        $this->relays = $connection['relays'];
        $this->clientPubkey = (new Key())->getPublicKey($this->clientSecret);
    }

    public static function fromUri(string $uri): self
    {
        return new self(Uri::parse($uri));
    }

    /**
     * Blocks until the socket closes or `stop()` is called. Every decrypted
     * notification is handed to `$handler` as the NWC-02 wire payload
     * (`notification_type` + `notification`). Throws \RuntimeException when
     * the relay connection ends so the caller can resubscribe with backoff.
     *
     * @param callable(array<string, mixed>): void $handler
     * @param (callable(): void)|null $onIdle called about once a second while blocked (the worker's periodic pass)
     */
    public function listen(callable $handler, ?callable $onIdle = null): void
    {
        $this->running = true;
        $relayUrl = $this->relays[0];
        $stack = new HandlerStack(new StreamHandler());
        $stack->unshift(new WebSocketMiddleware());
        $client = new Client(['handler' => $stack, 'timeout' => 30]);
        $handshake = $client->requestAsync('GET', $relayUrl)->wait();
        if ($handshake->getStatusCode() !== 101) {
            throw new \RuntimeException("NWC relay websocket handshake failed with HTTP {$handshake->getStatusCode()}");
        }
        /** @var \Valtzu\WebSocketMiddleware\WebSocketStream $socket */
        $socket = $handshake->getBody();
        $subscriptionId = 'openreceive-' . bin2hex(random_bytes(8));
        $filter = [
            'kinds' => [self::NIP04_KIND, self::NIP44_KIND],
            'authors' => [$this->walletPubkey],
            '#p' => [$this->clientPubkey],
            'since' => time() - $this->lookbackSeconds,
        ];
        $socket->write(json_encode(['REQ', $subscriptionId, $filter], JSON_THROW_ON_ERROR));
        $buffer = '';
        $lastActivity = time();
        $lastTick = microtime(true);
        try {
            while ($this->running) {
                if ($onIdle !== null && microtime(true) - $lastTick >= 1.0) {
                    $lastTick = microtime(true);
                    $onIdle();
                }
                $chunk = $socket->read();
                if ($chunk === '') {
                    if ($socket->eof()) {
                        throw new \RuntimeException('NWC relay connection closed');
                    }
                    if ($this->idleTimeoutSeconds !== null && time() - $lastActivity > $this->idleTimeoutSeconds) {
                        // A relay that went silent may have dropped us without a close frame: probe it.
                        $socket->write(json_encode(['REQ', $subscriptionId . '-ping', ['kinds' => [self::NIP04_KIND], 'limit' => 0]], JSON_THROW_ON_ERROR));
                        $lastActivity = time();
                    }
                    usleep(100_000);
                    continue;
                }
                $lastActivity = time();
                $buffer .= $chunk;
                foreach (self::drainMessages($buffer) as $message) {
                    $this->handleMessage($message, $handler);
                }
            }
        } finally {
            try {
                $socket->write(json_encode(['CLOSE', $subscriptionId], JSON_THROW_ON_ERROR));
                $socket->close();
            } catch (\Throwable) {
                // The socket is already gone.
            }
        }
    }

    public function stop(): void
    {
        $this->running = false;
    }

    /** @param callable(array<string, mixed>): void $handler */
    private function handleMessage(string $json, callable $handler): void
    {
        $decoded = json_decode($json, true);
        if (!is_array($decoded) || ($decoded[0] ?? null) !== 'EVENT' || !is_array($decoded[2] ?? null)) {
            return;
        }
        $event = $decoded[2];
        $kind = $event['kind'] ?? null;
        if (($event['pubkey'] ?? null) !== $this->walletPubkey || !in_array($kind, [self::NIP04_KIND, self::NIP44_KIND], true)) {
            return;
        }
        $payload = $this->decrypt((string) ($event['content'] ?? ''), $kind === self::NIP44_KIND);
        if ($payload === null) {
            return;
        }
        $type = $payload['notification_type'] ?? null;
        if ($type === null) {
            foreach ($event['tags'] ?? [] as $tag) {
                if (is_array($tag) && ($tag[0] ?? null) === 'notification_type' && isset($tag[1])) {
                    $type = $tag[1];
                }
            }
        }
        $handler(['notification_type' => (string) $type, 'notification' => is_array($payload['notification'] ?? null) ? $payload['notification'] : []]);
    }

    /** @return array<string, mixed>|null */
    private function decrypt(string $content, bool $nip44): ?array
    {
        try {
            $plain = $nip44
                ? Nip44::decrypt($content, Nip44::getConversationKey($this->clientSecret, $this->walletPubkey))
                : Nip04::decrypt($content, $this->clientSecret, $this->walletPubkey);
            $decoded = json_decode($plain, true);
            return is_array($decoded) ? $decoded : null;
        } catch (\Throwable) {
            // Not addressed to this connection (or corrupt): never authenticated wallet data, so ignored.
            return null;
        }
    }

    /**
     * Complete JSON arrays from a websocket buffer (frames may fragment or coalesce).
     *
     * @return list<string>
     */
    public static function drainMessages(string &$buffer): array
    {
        $messages = [];
        $depth = 0;
        $inString = false;
        $escape = false;
        $start = 0;
        $length = strlen($buffer);
        for ($i = 0; $i < $length; $i++) {
            $char = $buffer[$i];
            if ($escape) {
                $escape = false;
                continue;
            }
            if ($char === '\\') {
                $escape = true;
                continue;
            }
            if ($char === '"') {
                $inString = !$inString;
                continue;
            }
            if ($inString) {
                continue;
            }
            if ($char === '[') {
                if ($depth === 0) {
                    $start = $i;
                }
                $depth++;
            } elseif ($char === ']') {
                $depth--;
                if ($depth === 0) {
                    $messages[] = substr($buffer, $start, $i - $start + 1);
                    $start = $i + 1;
                }
            }
        }
        $buffer = $depth === 0 ? '' : substr($buffer, $start);
        return $messages;
    }
}
