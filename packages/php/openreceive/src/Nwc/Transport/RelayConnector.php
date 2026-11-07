<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\StreamHandler;
use GuzzleHttp\HandlerStack;
use OpenReceive\Nwc\WalletUnavailableError;
use Psr\Http\Message\StreamInterface;
use Valtzu\WebSocketMiddleware\WebSocketMiddleware;

/**
 * Opens a websocket to one of the configured relays, and only those, within
 * the caller's total deadline. A failed handshake is retried, cycling through
 * the relays, until the deadline or cancellation: nothing has been sent to the
 * wallet before a handshake succeeds, so a retry is safe for every request,
 * a mint included.
 *
 * Each handshake gets at most HANDSHAKE_SECONDS, and never more than an equal
 * share of the time left, split between the relays still untried in this
 * round plus one share kept for the work that follows on the socket. With one
 * relay and an 8 s deadline that is 4 s, enough for the 3.2 s handshakes seen
 * from shared hosting; with two, a dead first relay leaves the second a real
 * handshake and time for the request after it. Before a relay is tried again
 * the connector pauses, doubling the pause each round, so a relay that
 * refuses at once is not hammered, and it gives up once a retry's share would
 * be under MIN_RETRY_SECONDS.
 */
final class RelayConnector
{
    /** The most one handshake may take: a slow relay answers within this, a stuck one is better retried. */
    public const HANDSHAKE_SECONDS = 4.0;
    /** The pause before the relays are tried again; it doubles each round up to MAX_RETRY_PAUSE_SECONDS. */
    public const RETRY_PAUSE_SECONDS = 0.25;
    public const MAX_RETRY_PAUSE_SECONDS = 2.0;
    /**
     * A retry whose share is shorter is not started: it would rarely finish a
     * handshake, and a mint dispatched with less time for the reply ends
     * uncertain instead of cleanly unavailable.
     */
    public const MIN_RETRY_SECONDS = 1.0;

    /** @var \Closure(string, float): StreamInterface */
    private readonly \Closure $connect;
    private int $next = 0;

    /** @param list<string> $relays @param (callable(string, float): StreamInterface)|null $connect */
    public function __construct(private readonly array $relays, ?callable $connect = null)
    {
        $this->connect = $connect === null ? self::websocket(...) : \Closure::fromCallable($connect);
    }

    /** @param (callable(): void)|null $tick @param (callable(): bool)|null $cancelled */
    public function open(float $deadline, ?callable $tick = null, ?callable $cancelled = null): StreamInterface
    {
        $count = count($this->relays);
        $pause = self::RETRY_PAUSE_SECONDS;
        for ($attempt = 0; $count > 0; $attempt++) {
            // The relays this round has not tried yet, this one included.
            $untried = $count - $attempt % $count;
            $retry = $attempt >= $count;
            if ($retry && $untried === $count) {
                // Every relay failed once more. Wait before the next round, unless what would be left is too short to use.
                if (self::share($deadline - $pause, $untried) < self::MIN_RETRY_SECONDS) {
                    break;
                }
                self::pause(min($deadline, microtime(true) + $pause), $cancelled);
                $pause = min(self::MAX_RETRY_PAUSE_SECONDS, $pause * 2);
            }
            if ($tick !== null) $tick();
            if (($cancelled !== null && $cancelled()) || microtime(true) >= $deadline) {
                break;
            }
            // At most HANDSHAKE_SECONDS, and a fair share: a dead relay must leave time for the others and the request.
            $timeout = min(self::HANDSHAKE_SECONDS, self::share($deadline, $untried));
            if ($retry && $timeout < self::MIN_RETRY_SECONDS) {
                break;
            }
            $relay = $this->relays[$this->next++ % $count];
            try {
                return ($this->connect)($relay, max(0.001, $timeout));
            } catch (\Throwable) {
                // Connection strings and relay exception payloads are deliberately not propagated.
            }
        }
        throw new WalletUnavailableError('Configured NWC relays are unavailable.');
    }

    /** The time left before $deadline, split between $untried handshakes and the work that follows them. */
    private static function share(float $deadline, int $untried): float
    {
        return ($deadline - microtime(true)) / ($untried + 1);
    }

    /** @param (callable(): bool)|null $cancelled */
    private static function pause(float $until, ?callable $cancelled): void
    {
        while (($left = $until - microtime(true)) > 0 && ($cancelled === null || !$cancelled())) {
            usleep((int) (min($left, 0.05) * 1_000_000));
        }
    }

    private static function websocket(string $relay, float $timeout): StreamInterface
    {
        $stack = new HandlerStack(new StreamHandler());
        $stack->unshift(new WebSocketMiddleware());
        $client = new Client(['handler' => $stack, 'timeout' => $timeout, 'connect_timeout' => $timeout]);
        $response = $client->requestAsync('GET', $relay)->wait();
        if ($response->getStatusCode() !== 101) {
            $response->getBody()->close();
            throw new WalletUnavailableError('NWC relay websocket handshake failed.');
        }
        return $response->getBody();
    }
}
