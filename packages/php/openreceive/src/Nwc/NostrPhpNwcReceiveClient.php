<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use dsbaars\nostr\Nip47\NwcClient;
use dsbaars\nostr\Nip47\Response\ListTransactionsResponse;
use dsbaars\nostr\Nip47\Response\MakeInvoiceResponse;
use dsbaars\nostr\Nip47\Response\ResponseInterface;
use OpenReceive\Nwc\Transport\Nip47Command;
use OpenReceive\Nwc\Transport\RelayRpcClient;
use OpenReceive\Nwc\Transport\NotificationListener;
use OpenReceive\Support\Records;
use Psr\Log\LoggerInterface;

/**
 * Receive-only NIP-47 adapter using the dependency's signing/encryption models
 * and the bounded in-repo relay transport. Notifications use the same wallet
 * key for decryption. Only a redacted connection URI is exposed for diagnostics.
 */
final class NostrPhpNwcReceiveClient implements ReceiveNwcClient
{
    public readonly string $redactedConnectionUri;
    /** @var array{wallet_pubkey: string, relays: list<string>, client_secret: string, redacted: string, lud16?: string} */
    private readonly array $connection;
    private readonly RelayRpcClient $rpc;
    private ?NotificationListener $listener = null;
    private ?NwcClient $client = null;
    private bool $encryptionChosen = false;
    /** @var array<string, mixed>|null */
    private ?array $infoCache = null;

    public function __construct(string $connectionUri, ?LoggerInterface $logger = null, ?NwcClient $client = null)
    {
        $this->connection = Uri::parse($connectionUri);
        $this->redactedConnectionUri = $this->connection['redacted'];
        $this->client = $client;
        $this->rpc = new RelayRpcClient($this->connection);
        try {
            $logger?->debug('[openreceive] receive-only wallet transport configured', ['relay_count' => count($this->connection['relays'])]);
        } catch (\Throwable) {
            // Optional diagnostic sinks cannot prevent wallet configuration.
        }
    }

    public function makeInvoice(array $request): array
    {
        $params = Requests::makeInvoiceRequest($request);
        $response = $this->execute(new Nip47Command('make_invoice', $params), MakeInvoiceResponse::class);
        return Requests::normalizeMakeInvoiceResponse($response);
    }

    public function listTransactions(array $request): array
    {
        $params = Requests::listTransactionsRequest($request);
        $response = $this->execute(new Nip47Command('list_transactions', $params), ListTransactionsResponse::class, isset($request['_deadline']) ? (float) $request['_deadline'] : null);
        return Requests::normalizeListTransactionsResponse($response);
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
        if ($this->client === null) {
            $info = $this->rpc->info();
        } else {
            $response = $this->client->getWalletInfo();
            $this->assertNoError($response, 'get_info');
            $info = Records::asArray($response->getResult());
        }
        $this->chooseEncryption($info);
        $this->infoCache = $info;
        return $info;
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->listener ??= new NotificationListener($this->connection);
        $this->listener->listen($handler, $onIdle);
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

    public function stopNotifications(): void
    {
        $this->listener?->stop();
    }

    /** @param class-string<ResponseInterface> $responseClass */
    private function execute(Nip47Command $command, string $responseClass, ?float $deadline = null): mixed
    {
        if (!$this->encryptionChosen) {
            $this->preflight();
        }
        if ($this->client === null) {
            return $this->rpc->execute($command, $deadline);
        }
        $response = $this->client->executeCommand($command, $responseClass);
        $this->assertNoError($response, $command->getMethod());
        return Records::asArray($response->getResult());
    }

    /** @param array<string, mixed> $info */
    private function chooseEncryption(array $info): void
    {
        $mode = Info::chooseEncryptionMode(Info::stringList($info['encryption'] ?? $info['encryptions'] ?? null));
        if ($mode !== null) {
            $this->rpc->setEncryption($mode);
            $this->client?->setEncryption($mode);
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
