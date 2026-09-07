<?php

declare(strict_types=1);

namespace OpenReceive\Testing;

use OpenReceive\Kernel;
use OpenReceive\Money\Money;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Nwc\Requests;
use OpenReceive\Support\Integers;

/**
 * An in-memory NWC wallet: the PHP port of the JS testkit's
 * TestkitReceiveClient, with the fixtures pinned by
 * docs/internal/testkit-contract.md — payment hashes are the mint counter in
 * 64 hex characters, invoices are `lnbcopenreceive000001` — so the shared
 * Playwright suite asserts the same strings against every engine. Hosts use
 * it to test their hooks without a wallet.
 */
final class FakeWallet implements ReceiveNwcClient
{
    public const WALLET_PUBKEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    public const RELAY = 'wss://relay.test.openreceive.local';
    /** Never a real preimage; nothing verifies it. */
    public const PREIMAGE = '1111111111111111111111111111111111111111111111111111111111111111';

    /** @var callable(): int */
    private $clock;
    private int $counter = 0;
    /** @var array<string, array<string, mixed>> */
    private array $byPaymentHash = [];
    /** @var array<string, list<mixed>> scripted history reads per hash: a state string, a literal row, or a Throwable */
    private array $scripts = [];
    /** @var list<callable(array<string, mixed>): void> */
    private array $subscribers = [];

    /** @param (callable(): int)|null $clock real clock by default: a fixed low clock would put every invoice past expiry plus grace */
    public function __construct(?callable $clock = null, private readonly int $defaultExpirySeconds = 600)
    {
        $this->clock = $clock ?? static fn (): int => time();
    }

    /** @return array<string, mixed> */
    public function preflight(): array
    {
        return [
            'wallet_pubkey' => self::WALLET_PUBKEY,
            'relays' => [self::RELAY],
            'methods' => ['make_invoice', 'list_transactions'],
            'encryption' => ['nip04'],
        ];
    }

    public function makeInvoice(array $request): array
    {
        $nip47 = Requests::makeInvoiceRequest($request);
        $amountMsats = Money::boundedMsats($nip47['amount']);
        $this->counter++;
        $createdAt = ($this->clock)();
        // The requested expiry is HONOURED exactly: the swap path rejects a deviation over 60 s.
        $expiresAt = $createdAt + Integers::parse($nip47['expiry'] ?? $this->defaultExpirySeconds, 'expiry');
        $record = [
            'type' => 'incoming',
            'invoice' => sprintf('lnbcopenreceive%06d', $this->counter),
            'payment_hash' => str_pad(dechex($this->counter), 64, '0', STR_PAD_LEFT),
            'amount_msats' => $amountMsats,
            'created_at' => $createdAt,
            'expires_at' => $expiresAt,
            'state' => 'pending',
            'transaction_state' => 'pending',
        ];
        if (isset($nip47['description'])) {
            $record['description'] = $nip47['description'];
        }
        $this->byPaymentHash[$record['payment_hash']] = $record;
        return Requests::normalizeMakeInvoiceResponse($record);
    }

    /** Settlement is read from HISTORY: unpaid rows are excluded unless asked for, so a pending invoice is simply absent. */
    public function listTransactions(array $request): array
    {
        if (($request['type'] ?? null) === 'outgoing') {
            return ['transactions' => []];
        }
        $from = isset($request['from']) ? Integers::parse($request['from'], 'from') : null;
        $until = isset($request['until']) ? Integers::parse($request['until'], 'until') : null;
        $includeUnpaid = ($request['unpaid'] ?? false) === true;
        $rows = [];
        foreach ($this->byPaymentHash as $hash => $record) {
            $row = $this->nextScripted($hash) ?? $record;
            if ($row instanceof \Throwable) {
                throw $row;
            }
            if (($from !== null && $row['created_at'] < $from) || ($until !== null && $row['created_at'] > $until)) {
                continue;
            }
            if (!$includeUnpaid && ($row['transaction_state'] ?? null) !== 'settled') {
                continue;
            }
            $rows[] = $row;
        }
        usort($rows, static fn (array $a, array $b): int => [$b['created_at'], $b['payment_hash']] <=> [$a['created_at'], $a['payment_hash']]);
        $offset = Integers::parse($request['offset'] ?? 0, 'offset');
        $limit = isset($request['limit']) ? Integers::parse($request['limit'], 'limit') : count($rows);
        return ['transactions' => array_slice($rows, $offset, $limit)];
    }

    /** Non-blocking: registers the handler; `settleInvoice(..., notify: true)` delivers. */
    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->subscribers[] = $handler;
    }

    // ------------------------------------------------------------- controls

    /** @param array{payment_hash?: string, invoice?: string}|string $selector @return array<string, mixed> */
    public function settleInvoice(array|string $selector, ?int $settledAt = null, ?string $preimage = null, bool $notify = false): array
    {
        $record = $this->mutate($selector, function (array &$record) use ($settledAt, $preimage): void {
            $record['state'] = 'settled';
            $record['transaction_state'] = 'settled';
            $record['settled_at'] = $settledAt ?? ($this->clock)();
            $record['preimage'] = $preimage ?? self::PREIMAGE;
        });
        if ($notify) {
            $this->emitNotification(['notification_type' => 'payment_received', 'notification' => $record]);
        }
        return $record;
    }

    /** @param array{payment_hash?: string, invoice?: string}|string $selector @return array<string, mixed> */
    public function expireInvoice(array|string $selector): array
    {
        return $this->mutate($selector, static function (array &$record): void {
            $record['state'] = 'expired';
            $record['transaction_state'] = 'expired';
        });
    }

    /** @param array{payment_hash?: string, invoice?: string}|string $selector @return array<string, mixed> */
    public function failInvoice(array|string $selector): array
    {
        return $this->mutate($selector, static function (array &$record): void {
            $record['state'] = 'failed';
            $record['transaction_state'] = 'failed';
        });
    }

    /**
     * Each subsequent history read of that invoice yields the next step (a
     * state string, a literal transaction row, or a Throwable), then falls
     * back to the stored state.
     *
     * @param array{payment_hash?: string, invoice?: string}|string $selector
     * @param list<mixed> $steps
     */
    public function scriptTransactionSequence(array|string $selector, array $steps): void
    {
        $this->scripts[$this->resolve($selector)] = array_values($steps);
    }

    /**
     * Every stored invoice, for the /__testkit/state debug view.
     *
     * @return list<array<string, mixed>>
     */
    public function listInvoices(): array
    {
        return array_values($this->byPaymentHash);
    }

    /**
     * Delivers only payment_received; a throwing handler never breaks the subscription.
     *
     * @param array<string, mixed> $notification
     */
    public function emitNotification(array $notification): void
    {
        if (($notification['notification_type'] ?? null) !== 'payment_received') {
            return;
        }
        foreach ($this->subscribers as $handler) {
            try {
                $handler($notification);
            } catch (\Throwable) {
                // The subscription outlives a failing handler, exactly like a real wallet would.
            }
        }
    }

    /** @param array{payment_hash?: string, invoice?: string}|string $selector */
    private function resolve(array|string $selector): string
    {
        if (is_string($selector)) {
            $selector = ['payment_hash' => $selector];
        }
        if (isset($selector['payment_hash'])) {
            $hash = strtolower($selector['payment_hash']);
            if (isset($this->byPaymentHash[$hash])) {
                return $hash;
            }
        } elseif (isset($selector['invoice'])) {
            foreach ($this->byPaymentHash as $hash => $record) {
                if ($record['invoice'] === $selector['invoice']) {
                    return $hash;
                }
            }
        }
        throw new \OutOfBoundsException('testkit invoice not found');
    }

    /** @param array{payment_hash?: string, invoice?: string}|string $selector @param callable(array<string, mixed>&): void $change @return array<string, mixed> */
    private function mutate(array|string $selector, callable $change): array
    {
        $hash = $this->resolve($selector);
        $record = $this->byPaymentHash[$hash];
        $change($record);
        $this->byPaymentHash[$hash] = $record;
        return $record;
    }

    /** @return array<string, mixed>|\Throwable|null */
    private function nextScripted(string $hash): array|\Throwable|null
    {
        if (!isset($this->scripts[$hash]) || $this->scripts[$hash] === []) {
            return null;
        }
        $step = array_shift($this->scripts[$hash]);
        if ($step instanceof \Throwable) {
            return $step;
        }
        if (is_string($step)) {
            $row = $this->byPaymentHash[$hash];
            $row['state'] = $step;
            $row['transaction_state'] = $step;
            if ($step === 'settled' && !isset($row['settled_at'])) {
                $row['settled_at'] = ($this->clock)();
                $row['preimage'] = self::PREIMAGE;
            }
            return $row;
        }
        return is_array($step) ? [...$this->byPaymentHash[$hash], ...$step] : null;
    }
}
