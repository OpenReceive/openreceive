<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use dsbaars\nostr\Nip47\NwcClient;
use dsbaars\nostr\Nip47\Response\GetInfoResponse;
use dsbaars\nostr\Nip47\Response\ListTransactionsResponse;
use dsbaars\nostr\Nip47\Response\MakeInvoiceResponse;
use dsbaars\nostr\Nip47\Response\ResponseInterface;
use OpenReceive\Nwc\Transport\Nip47Command;
use OpenReceive\Nwc\Transport\NotificationListener;
use OpenReceive\Support\Records;
use Psr\Log\LoggerInterface;

/**
 * The receive-only client over dsbaars/nostr-php-nwc (the nwc_ruby.rb twin):
 * NIP-47 params are built by the kernel, sent through the library's blocking
 * websocket request (connect → send → await → close, no event loop), and
 * replies are normalized by the kernel. Encryption follows the info event
 * (nip44_v2 when advertised, nip04 otherwise). Notifications use the
 * in-repo listener (see Transport\NotificationListener for why).
 *
 * The connection secret never leaves this object: `redactedConnectionUri` is
 * the only form that may be logged.
 */
final class NostrPhpNwcReceiveClient implements ReceiveNwcClient
{
    public readonly string $redactedConnectionUri;
    /** @var array{wallet_pubkey: string, relays: list<string>, client_secret: string, redacted: string, lud16?: string} */
    private readonly array $connection;
    private readonly string $clientUri;
    private ?NwcClient $client = null;
    private bool $encryptionChosen = false;
    /** @var array<string, mixed>|null */
    private ?array $infoCache = null;

    public function __construct(string $connectionUri, private readonly ?LoggerInterface $logger = null, ?NwcClient $client = null)
    {
        $this->connection = Uri::parse($connectionUri);
        $this->redactedConnectionUri = $this->connection['redacted'];
        $this->client = $client;
        $this->clientUri = $connectionUri;
    }

    public function makeInvoice(array $request): array
    {
        $params = Requests::makeInvoiceRequest($request);
        $response = $this->execute(new Nip47Command('make_invoice', $params), MakeInvoiceResponse::class);
        return Requests::normalizeMakeInvoiceResponse($response->getResult());
    }

    public function listTransactions(array $request): array
    {
        $params = Requests::listTransactionsRequest($request);
        $response = $this->execute(new Nip47Command('list_transactions', $params), ListTransactionsResponse::class);
        return Requests::normalizeListTransactionsResponse($response->getResult());
    }

    /**
     * The kind 13194 info event (methods, notifications, encryption), falling
     * back to a get_info command when the relay has none. Read once; the
     * result also decides the encryption mode every later request uses.
     */
    public function preflight(): array
    {
        if ($this->infoCache !== null) {
            return $this->infoCache;
        }
        $response = $this->nwc()->getWalletInfo();
        $this->assertNoError($response, 'get_info');
        $info = Records::asArray($response->getResult());
        $this->chooseEncryption($info);
        $this->infoCache = $info;
        return $info;
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        (new NotificationListener($this->connection))->listen($handler, $onIdle);
    }

    /**
     * Seed the info event a host cached from an earlier `preflight()` — PHP
     * builds a fresh client per request, and without this every request would
     * pay the get_info round trip again. The encryption mode is chosen from
     * the seeded info exactly as a live preflight would choose it.
     *
     * @param array<string, mixed> $info the array a previous preflight() returned
     */
    public function primeInfo(array $info): void
    {
        $this->chooseEncryption($info);
        $this->infoCache = $info;
    }

    /** @return array{wallet_pubkey: string, relays: list<string>} */
    public function connectionSummary(): array
    {
        return ['wallet_pubkey' => $this->connection['wallet_pubkey'], 'relays' => $this->connection['relays']];
    }

    private function nwc(): NwcClient
    {
        if ($this->client === null) {
            $this->client = new NwcClient($this->clientUri, $this->logger instanceof \Psr\Log\AbstractLogger ? $this->logger : null);
        }
        return $this->client;
    }

    /**
     * @template T of ResponseInterface
     * @param class-string<T> $responseClass
     * @return T
     */
    private function execute(Nip47Command $command, string $responseClass): ResponseInterface
    {
        if (!$this->encryptionChosen) {
            // Every request rides the mode the wallet advertised; preflight normally ran at boot.
            $this->preflight();
        }
        $response = $this->nwc()->executeCommand($command, $responseClass);
        $this->assertNoError($response, $command->getMethod());
        /** @var T $response */
        return $response;
    }

    /** @param array<string, mixed> $info */
    private function chooseEncryption(array $info): void
    {
        $mode = Info::chooseEncryptionMode(Info::stringList($info['encryption'] ?? $info['encryptions'] ?? null));
        if ($mode !== null) {
            $this->nwc()->setEncryption($mode);
        }
        $this->encryptionChosen = true;
    }

    /** A NIP-47 error envelope becomes a coded failure the kernel's error normalization can read. */
    private function assertNoError(ResponseInterface $response, string $method): void
    {
        if (!$response->isError()) {
            return;
        }
        $error = $response->getError() ?? [];
        throw new NwcRequestError((string) ($error['code'] ?? 'OTHER'), (string) ($error['message'] ?? "NWC {$method} failed."));
    }
}
