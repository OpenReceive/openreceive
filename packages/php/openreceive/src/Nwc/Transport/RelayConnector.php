<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\StreamHandler;
use GuzzleHttp\HandlerStack;
use OpenReceive\Nwc\WalletUnavailableError;
use Psr\Http\Message\StreamInterface;
use Valtzu\WebSocketMiddleware\WebSocketMiddleware;

/** Configured relays only; every handshake consumes the caller's total deadline. */
final class RelayConnector
{
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
        for ($attempt = 0; $attempt < count($this->relays); $attempt++) {
            if ($tick !== null) $tick();
            if (($cancelled !== null && $cancelled()) || microtime(true) >= $deadline) {
                break;
            }
            $relay = $this->relays[$this->next++ % count($this->relays)];
            try {
                // A dead first relay must leave time for the remaining relays and idle work.
                return ($this->connect)($relay, min(1.0, max(0.001, $deadline - microtime(true))));
            } catch (\Throwable) {
                // Connection strings and relay exception payloads are deliberately not propagated.
            }
        }
        throw new WalletUnavailableError('Configured NWC relays are unavailable.');
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
