<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use dsbaars\nostr\Nip47\Event\RequestEvent;
use OpenReceive\Nwc\NwcRequestError;
use OpenReceive\Nwc\WalletUnavailableError;
use Psr\Http\Message\StreamInterface;
use OpenReceive\Support\Records;
use swentel\nostr\Encryption\Nip04;
use swentel\nostr\Encryption\Nip44;
use swentel\nostr\Key\Key;
use swentel\nostr\Message\EventMessage;
use swentel\nostr\Sign\Sign;

/** Receive-only RPC with bounded failover, wallet-bound decryption and no ambiguous remint. */
final class RelayRpcClient
{
    private string $encryption = 'nip04';
    private readonly string $clientPubkey;
    private readonly RelayConnector $connector;
    private bool $stopped = false;

    /** @param array{wallet_pubkey: string, relays: list<string>, client_secret: string} $connection */
    public function __construct(private readonly array $connection, ?RelayConnector $connector = null, private readonly float $timeoutSeconds = 8.0)
    {
        $this->clientPubkey = (new Key())->getPublicKey($connection['client_secret']);
        $this->connector = $connector ?? new RelayConnector($connection['relays']);
    }

    public function setEncryption(string $mode): void
    {
        if (!in_array($mode, ['nip04', 'nip44_v2'], true)) {
            throw new \InvalidArgumentException('Unsupported NWC encryption.');
        }
        $this->encryption = $mode;
    }

    /**
     * Dispatch host signal handlers before observing cancellation.
     * @phpstan-impure
     */
    private function isStopped(): bool
    {
        if (function_exists('pcntl_signal_dispatch')) pcntl_signal_dispatch();
        return $this->stopped;
    }

    public function stop(): void
    {
        $this->stopped = true;
    }

    /** @return array<string, mixed> */
    public function info(): array
    {
        $deadline = microtime(true) + $this->timeoutSeconds;
        $socket = $this->connector->open($deadline, cancelled: $this->isStopped(...));
        $subscription = bin2hex(random_bytes(8));
        try {
            $socket->write(json_encode(['REQ', $subscription, ['kinds' => [13194], 'authors' => [$this->connection['wallet_pubkey']], 'limit' => 1]], JSON_THROW_ON_ERROR));
            $buffer = '';
            // Reserve most of the overall budget for the get_info fallback.
            $infoDeadline = min($deadline, microtime(true) + 1.0);
            while (!$this->isStopped() && microtime(true) < $infoDeadline) {
                foreach ($this->messages($socket, $buffer) as $message) {
                    if (($message[0] ?? null) === 'EOSE') {
                        break 2;
                    }
                    $event = $message[2] ?? [];
                    if (($message[0] ?? null) !== 'EVENT' || ($event['kind'] ?? null) !== 13194 || ($event['pubkey'] ?? null) !== $this->connection['wallet_pubkey']) {
                        continue;
                    }
                    $info = ['methods' => preg_split('/\s+/', trim((string) ($event['content'] ?? ''))) ?: []];
                    foreach ($event['tags'] ?? [] as $tag) {
                        if (in_array($tag[0] ?? null, ['encryption', 'notifications'], true)) {
                            $info[$tag[0]] = preg_split('/\s+/', (string) ($tag[1] ?? '')) ?: [];
                        }
                    }
                    return $info;
                }
                usleep(10_000);
            }
        } finally {
            self::close($socket, $subscription);
        }
        return Records::asArray($this->execute(new Nip47Command('get_info', []), $deadline));
    }

    /** Preserve nested JSON object/list shapes for the transaction normalizer. */
    public function execute(Nip47Command $command, ?float $deadline = null): mixed
    {
        if (!in_array($command->getMethod(), ['get_info', 'make_invoice', 'list_transactions'], true)) {
            throw new \LogicException('Unsupported receive-only NWC method.');
        }
        $deadline ??= microtime(true) + $this->timeoutSeconds;
        $request = new RequestEvent($command, $this->connection['client_secret'], $this->connection['wallet_pubkey'], null, $this->encryption);
        (new Sign())->signEvent($request, $this->connection['client_secret']);
        $payload = (new EventMessage($request))->generate();
        // At most one dispatch per configured relay, within one total timeout.
        for ($attempt = 0; $attempt < count($this->connection['relays']); $attempt++) {
            if ($this->isStopped() || microtime(true) >= $deadline) {
                break;
            }
            $socket = $this->connector->open($deadline, cancelled: $this->isStopped(...));
            $subscription = bin2hex(random_bytes(8));
            $dispatched = false;
            try {
                $socket->write(json_encode(['REQ', $subscription, ['kinds' => [23195], 'authors' => [$this->connection['wallet_pubkey']], '#p' => [$this->clientPubkey], '#e' => [$request->getId()]]], JSON_THROW_ON_ERROR));
                // Even a partial write can have reached the wallet. Never replay a mint after this point.
                $dispatched = true;
                $socket->write($payload);
                $buffer = '';
                $relayDeadline = min($deadline, microtime(true) + max(0.1, ($deadline - microtime(true)) / (count($this->connection['relays']) - $attempt)));
                while (!$this->isStopped() && microtime(true) < $relayDeadline) {
                    foreach ($this->messages($socket, $buffer) as $message) {
                        $event = $message[2] ?? [];
                        if (($message[0] ?? null) !== 'EVENT' || ($event['kind'] ?? null) !== 23195 || ($event['pubkey'] ?? null) !== $this->connection['wallet_pubkey'] || !in_array(['e', $request->getId()], $event['tags'] ?? [], true)) {
                            continue;
                        }
                        $plain = $this->encryption === 'nip44_v2'
                            ? Nip44::decrypt((string) $event['content'], Nip44::getConversationKey($this->connection['client_secret'], $this->connection['wallet_pubkey']))
                            : Nip04::decrypt((string) $event['content'], $this->connection['client_secret'], $this->connection['wallet_pubkey']);
                        $reply = Records::asArray(json_decode($plain, false, flags: JSON_THROW_ON_ERROR));
                        if (($reply['result_type'] ?? null) !== $command->getMethod()) {
                            continue;
                        }
                        if (isset($reply['error'])) {
                            $error = Records::asArray($reply['error']);
                            throw new NwcRequestError((string) ($error['code'] ?? 'OTHER'), (string) ($error['message'] ?? 'NWC request failed.'));
                        }
                        return $reply['result'];
                    }
                    usleep(10_000);
                }
                throw new WalletUnavailableError('NWC response timed out.');
            } catch (NwcRequestError $error) {
                throw $error;
            } catch (\Throwable) {
                if ($dispatched && $command->getMethod() === 'make_invoice') {
                    throw new WalletUnavailableError('The invoice request outcome is uncertain after dispatch; no payer instructions were exposed. Reconcile before retrying.');
                }
                // Only read-only requests or failures definitely before dispatch can fail over.
            } finally {
                self::close($socket, $subscription);
            }
        }
        throw new WalletUnavailableError('NWC request could not complete within its total relay budget.');
    }

    /** @return list<array<mixed>> */
    private function messages(StreamInterface $socket, string &$buffer): array
    {
        $chunk = $socket->read(65536);
        if ($chunk === '' && $socket->eof()) {
            throw new WalletUnavailableError('NWC relay disconnected.');
        }
        $buffer .= $chunk;
        return array_map(static fn (string $json): array => json_decode($json, true, flags: JSON_THROW_ON_ERROR), NotificationListener::drainMessages($buffer));
    }

    private static function close(StreamInterface $socket, string $subscription): void
    {
        try { $socket->write(json_encode(['CLOSE', $subscription], JSON_THROW_ON_ERROR)); } catch (\Throwable) { }
        try { $socket->close(); } catch (\Throwable) { }
    }
}
