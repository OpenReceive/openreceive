<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

/**
 * The receive-only wallet client the engine drives. NostrPhpNwcReceiveClient
 * binds it to a real NWC connection; Testing\FakeWallet is the in-process
 * fake. Receive APIs never expose a spend method. Arrays in, arrays out, with
 * the NIP-47 wire names: this is the wire, not a PHP value-object API.
 */
interface ReceiveNwcClient
{
    /**
     * Mint an invoice. Input is the OpenReceive request (amount_msats,
     * description?, description_hash?, expiry?, metadata?); output is the
     * normalized invoice (invoice, payment_hash, amount_msats, created_at?, expires_at?).
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function makeInvoice(array $request): array;

    /**
     * One page of wallet history for the OpenReceive request (type, limit,
     * offset, from?, until?, unpaid?). Returns the raw NIP-47 result or an
     * already-normalized `['transactions' => …]` — both are accepted.
     *
     * @param array<string, mixed> $request
     * @return array<string, mixed>
     */
    public function listTransactions(array $request): array;

    /**
     * The wallet's capability info (the kind 13194 info payload or a get_info
     * result: methods, encryption, notifications). Read once at boot by the
     * receive-only preflight.
     *
     * @return array<string, mixed>
     */
    public function preflight(): array;

    /**
     * Opt-in NWC-02 notifications. Blocks until the subscription ends, calling
     * `$handler` with NWC-02 wire payloads (`notification_type` plus the
     * transaction-shaped `notification`). Every type is forwarded; the engine
     * filters `payment_received` itself. Throws when the wallet cannot notify,
     * and when the relay connection ends (so a worker can resubscribe with
     * backoff). `$onIdle`, when given, is called at least once a second while
     * blocked: PHP is single-threaded, and that tick is how the notifications
     * worker runs its periodic safety-net pass in the same process.
     *
     * @param callable(array<string, mixed>): void $handler
     * @param (callable(): void)|null $onIdle
     */
    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void;
}
