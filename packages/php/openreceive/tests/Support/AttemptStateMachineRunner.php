<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Support;

use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Server\Reconciler;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

/**
 * The PHP engine's runner for spec/test-vectors/attempt-state-machine.json: one
 * operation sequence replayed through the real SqlPaymentRepository and
 * Reconciler over SQLite, comparing the model's prediction after every step
 * and checking the state-machine invariants against the engine's own rows.
 * `tests/Support/attempt-state-machine.php` runs it over a file of sequences
 * for `npm run test:model`.
 */
final class AttemptStateMachineRunner
{
    private const STATUSES = ['pending', 'settled', 'expired', 'failed', 'attention'];
    private const CLOSED_STATUSES = ['expired', 'failed', 'attention'];
    private const GRACE_SECONDS = 900;
    private const WALLET_SETTLED_STATES = ['settled_at', 'settled_state', 'settled_full'];
    private const WALLET_TERMINAL_STATES = ['failed', 'expired'];

    public int $now = 0;
    /** @var list<array{0: string, 1: string}> */
    public array $ledger = [];
    public bool $failFulfillment = false;
    public string $walletMode = 'ok';
    public int $walletCalls = 0;
    /** @var array<int, array{created_at: int, state: string, settled_at: ?int}> */
    public array $walletRows = [];
    public ?string $outcome = null;
    public ?int $reusedId = null;
    public ?string $lastReason = null;

    private PdoConnection $db;
    private SqlPaymentRepository $repository;
    private Reconciler $reconciler;

    public function __construct()
    {
        $this->db = new PdoConnection(new \PDO('sqlite::memory:'));
        PaymentsSchema::migrate($this->db);
        $this->rebuild();
    }

    private static function hashOf(int $id): string
    {
        return str_pad(dechex($id), 64, '0', STR_PAD_LEFT);
    }

    private function rebuild(): void
    {
        $clock = fn (): int => $this->now;
        $this->repository = new SqlPaymentRepository($this->db, $clock);
        $repository = $this->repository;
        $fulfill = fn (PaymentSettlement $settlement) => $this->fulfill($settlement);
        $service = new Service($this->wallet(), false, [], ['USD'], $clock);
        $this->reconciler = new Reconciler(
            $service,
            $repository,
            static fn (array $event): bool => $repository->markPaidOnce($event['payment_hash'], $event['paid_at'], $event['details'], $fulfill),
            true,
            null,
            $clock,
        );
    }

    private function fulfill(PaymentSettlement $settlement): void
    {
        if ($this->failFulfillment) {
            throw new \RuntimeException('host rollback (model)');
        }
        $this->ledger[] = [$settlement->reference, $settlement->paymentHash];
    }

    private function wallet(): ReceiveNwcClient
    {
        return new class ($this) implements ReceiveNwcClient {
            public function __construct(private readonly AttemptStateMachineRunner $harness)
            {
            }

            public function preflight(): array
            {
                return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']];
            }

            public function makeInvoice(array $request): array
            {
                throw new \LogicException('not minted');
            }

            public function listTransactions(array $request): array
            {
                return $this->harness->listTransactions($request);
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
            }
        };
    }

    /** @return array<string, mixed> */
    public function listTransactions(array $request): array
    {
        $callIndex = $this->walletCalls++;
        $mode = $this->walletMode;
        if ($mode === 'fail') {
            throw new \RuntimeException('wallet unavailable (model)');
        }
        if ($mode === 'unrecognized_key') {
            return ['rows' => []];
        }
        if ($mode === 'unrecognized_type') {
            return ['transactions' => 'nope'];
        }
        if ($mode === 'unusable_rows') {
            return ['transactions' => [1, 2]];
        }
        if (str_starts_with($mode, 'fail_after_') && $callIndex >= (int) substr($mode, 11)) {
            throw new \RuntimeException('wallet unavailable (model)');
        }
        $low = $request['from'] ?? 0;
        $high = $request['until'] ?? null;
        $unpaid = !empty($request['unpaid']);
        $rows = [];
        foreach ($this->walletRows as $id => $row) {
            if ($row['created_at'] >= $low
                && ($high === null || $row['created_at'] <= $high)
                && ($unpaid || in_array($row['state'], self::WALLET_SETTLED_STATES, true))) {
                $rows[] = [$id, $row];
            }
        }
        usort($rows, static fn (array $a, array $b): int => [$b[1]['created_at'], $b[0]] <=> [$a[1]['created_at'], $a[0]]);
        $offset = (int) ($request['offset'] ?? 0);
        $page = array_slice($rows, $offset, (int) $request['limit']);
        return ['transactions' => array_map(static fn (array $item): array => self::wireRow($item[0], $item[1]), $page)];
    }

    /** @param array{created_at: int, state: string, settled_at: ?int} $row */
    private static function wireRow(int $id, array $row): array
    {
        $wire = ['type' => 'incoming', 'payment_hash' => self::hashOf($id), 'amount' => 1000, 'created_at' => $row['created_at']];
        $state = $row['state'];
        if ($state === 'settled_at') {
            $wire['settled_at'] = $row['settled_at'];
        } elseif ($state === 'settled_full') {
            $wire['state'] = 'settled';
            $wire['settled_at'] = $row['settled_at'];
        } elseif ($state === 'settled_state') {
            $wire['state'] = 'settled';
        } elseif ($state !== 'stateless') {
            $wire['state'] = $state;
        }
        return $wire;
    }

    private function setWalletRow(int $id, string $kind, ?int $settledAt, ?int $createdAt): void
    {
        if ($kind === 'absent') {
            unset($this->walletRows[$id]);
            return;
        }
        $existing = $this->walletRows[$id] ?? null;
        $this->walletRows[$id] = [
            'created_at' => $existing['created_at'] ?? $createdAt,
            'state' => $kind,
            'settled_at' => $settledAt,
        ];
    }

    private function checkoutFor(array $step): array
    {
        return [
            'reference' => $step['ref'],
            'payment_hash' => self::hashOf($step['id']),
            'bolt11' => 'lnbc-' . $step['id'],
            'amount_msats' => 1000,
            'created_at' => $step['created_at'],
            'created_at_source' => 'wallet',
            'expires_at' => $step['expires_at'],
            'fiat_quote' => null,
        ];
    }

    private function swapDataFor(array $step): ?array
    {
        if ($step['rail'] === 'ln') {
            return null;
        }
        return [
            'version' => 1,
            'provider_order' => [
                'provider' => 'model',
                'provider_order_id' => 'order-' . $step['id'],
                'provider_token' => 'model-token',
                'pay_in_asset' => $step['rail'],
                'expires_at' => $step['deposit_expires_at'],
            ],
        ];
    }

    private function commit(array $step): void
    {
        $this->repository->commitAttempt($step['ref'], self::hashOf($step['id']), $this->checkoutFor($step), $this->swapDataFor($step));
    }

    public function applyStep(array $step): void
    {
        $this->walletCalls = 0;
        $this->walletMode = 'ok';
        $this->failFulfillment = ($step['fail_fulfillment'] ?? false) === true;
        $this->outcome = null;
        $this->reusedId = null;
        $this->lastReason = null;
        switch ($step['op']) {
            case 'advance':
                return;
            case 'restart':
                $this->rebuild();
                return;
            case 'wallet':
                $this->setWalletRow($step['id'], $step['state'], $step['settled_at'] ?? null, $step['created_at'] ?? null);
                return;
            case 'create':
                $this->create($step);
                return;
            case 'commit':
                try {
                    $this->commit($step);
                    $this->outcome = 'inserted_or_idempotent';
                } catch (ConflictError) {
                    $this->outcome = 'conflict';
                }
                return;
            case 'scan':
                $this->walletMode = $step['mode'];
                $this->lastReason = $this->reconciler->maybeReconcile()['reason'];
                return;
            case 'notify':
                $this->notify($step);
                return;
            case 'replay_settlement':
                try {
                    $this->repository->markPaidOnce(self::hashOf($step['id']), $step['paid_at'], null, fn (PaymentSettlement $settlement) => $this->fulfill($settlement));
                } catch (\RuntimeException $error) {
                    if (!$this->failFulfillment) {
                        throw $error;
                    }
                }
                return;
            case 'stale_close':
                $this->repository->recordReconciliation(self::hashOf($step['id']), $step['status'], $this->now, 'stale_model');
                return;
            default:
                throw new \LogicException('unknown op ' . $step['op']);
        }
    }

    private function create(array $step): void
    {
        $rail = $step['rail'];
        $action = $rail === 'ln' ? 'checkout.create' : 'swap.create';
        try {
            $selected = $this->repository->selectedFor($step['ref'], $action, null, $rail === 'ln' ? null : $rail);
        } catch (ConflictError) {
            $this->outcome = 'already_paid';
            return;
        }
        if ($selected !== null) {
            $this->outcome = 'reused';
            $this->reusedId = (int) hexdec(substr($selected->paymentHash, -12));
            return;
        }
        $this->commit($step);
        $this->outcome = 'inserted';
    }

    private function notify(array $step): void
    {
        if (($step['kind'] ?? '') !== 'sent') {
            if ($step['finality'] === 'settled_at') {
                $this->setWalletRow($step['id'], 'settled_full', $step['settled_at'], $step['created_at']);
            } elseif ($step['finality'] === 'state') {
                $this->setWalletRow($step['id'], 'settled_state', null, $step['created_at']);
            }
        }
        $this->reconciler->handleNotification($this->notificationPayload($step));
    }

    private function notificationPayload(array $step): array
    {
        $type = ($step['kind'] ?? '') === 'sent' ? 'payment_sent' : 'payment_received';
        $finality = $step['finality'];
        if ($finality === 'absent') {
            return ['notification_type' => $type];
        }
        $payload = ['payment_hash' => self::hashOf($step['id']), 'amount' => 1000];
        if ($finality === 'settled_at') {
            $payload += ['type' => 'incoming', 'state' => 'settled', 'settled_at' => $step['settled_at']];
        } elseif ($finality === 'state') {
            $payload += ['type' => 'incoming', 'state' => 'settled'];
        } elseif ($finality === 'preimage') {
            $payload['preimage'] = str_repeat('a', 64);
        }
        return ['notification_type' => $type, 'notification' => $payload];
    }

    /** @return array{status: string, reason: ?string, paid_at: ?int, reference: string, expires_at: int, has_swap: bool}|null */
    private function readRow(int $id): ?array
    {
        $record = $this->repository->findByPaymentHash(self::hashOf($id));
        if ($record === null) {
            return null;
        }
        return [
            'status' => $record->status,
            'reason' => $record->statusReason,
            'paid_at' => $record->paidAt,
            'reference' => $record->reference,
            'expires_at' => $record->expiresAt,
            'has_swap' => $record->isSwap(),
        ];
    }

    /** @return array{0: int, 1: int} */
    private function rowCounts(): array
    {
        $rows = $this->db->query('SELECT COUNT(*) AS total, COUNT(DISTINCT payment_hash) AS distinct_hashes FROM openreceive_payments');
        return [(int) $rows[0]['total'], (int) $rows[0]['distinct_hashes']];
    }

    private static function fail(string $kind, string $message): never
    {
        throw new AttemptStateMachineFailure($kind, $message);
    }

    /**
     * @param array<int, array<string, mixed>> $before
     * @param array<int, array<string, mixed>> $after
     * @param array<int, array{expires_at: ?int, rail: ?string}> $info
     */
    private function checkInvariants(array $step, array $before, array $after, array $info): void
    {
        foreach ($after as $id => $row) {
            if (!in_array($row['status'], self::STATUSES, true)) {
                self::fail('invariant', "row {$id} has status {$row['status']}");
            }
            $previous = $before[$id] ?? null;
            if ($previous !== null && $previous['status'] === 'settled'
                && ($row['status'] !== 'settled' || $row['paid_at'] !== $previous['paid_at'] || $row['reason'] !== $previous['reason'])) {
                self::fail('invariant', "settled row {$id} overwritten: " . json_encode($row));
            }
            if ($previous !== null && $previous['status'] !== 'pending' && $row['status'] !== $previous['status']) {
                self::fail('invariant', "closed row {$id} changed status to {$row['status']}");
            }
            if ($previous !== null && $previous['status'] === 'pending' && in_array($row['status'], self::CLOSED_STATUSES, true)) {
                $mode = (string) ($step['mode'] ?? '');
                $ranScan = $step['op'] === 'notify' || ($step['op'] === 'scan' && $mode === 'ok') || str_starts_with($mode, 'fail_after_');
                if (!$ranScan) {
                    self::fail('invariant', "row {$id} closed without a successful scan");
                }
                $walletRow = $this->walletRows[$id] ?? null;
                $terminal = $walletRow !== null && in_array($walletRow['state'], self::WALLET_TERMINAL_STATES, true);
                if (!$terminal && $this->now < $info[$id]['expires_at'] + self::GRACE_SECONDS) {
                    self::fail('invariant', "row {$id} closed before expiry + grace");
                }
            }
        }
        $fulfilledCounts = [];
        foreach ($this->ledger as [$reference]) {
            $fulfilledCounts[$reference] = ($fulfilledCounts[$reference] ?? 0) + 1;
        }
        foreach ($fulfilledCounts as $reference => $count) {
            if ($count > 1) {
                self::fail('invariant', "reference {$reference} fulfilled {$count} times");
            }
        }
        $settledByReference = [];
        foreach ($after as $id => $row) {
            if ($row['status'] === 'settled') {
                $settledByReference[$row['reference']][$id] = $row;
            }
        }
        foreach ($settledByReference as $reference => $rows) {
            $entries = array_values(array_filter($this->ledger, static fn (array $entry): bool => $entry[0] === $reference));
            if (count($entries) !== 1) {
                self::fail('invariant', "reference {$reference} has settled rows but " . count($entries) . ' fulfillments');
            }
            $first = array_keys(array_filter($rows, static fn (array $row): bool => $row['reason'] === null));
            if (count($first) !== 1 || self::hashOf($first[0]) !== $entries[0][1]) {
                self::fail('invariant', "fulfillment for {$reference} went to the wrong row");
            }
            foreach ($rows as $id => $row) {
                if ($row['reason'] !== null && $row['reason'] !== 'duplicate_settlement') {
                    self::fail('invariant', "settled row {$id} has reason {$row['reason']}");
                }
            }
        }
        $live = [];
        foreach ($after as $id => $row) {
            if ($row['status'] !== 'pending' || $row['reason'] === 'superseded' || $row['expires_at'] <= $this->now) {
                continue;
            }
            $rail = $row['has_swap'] ? $info[$id]['rail'] : 'ln';
            $key = $row['reference'] . ' ' . $rail;
            if (isset($live[$key])) {
                self::fail('invariant', "two live attempts on {$key}: {$live[$key]} and {$id}");
            }
            $live[$key] = $id;
        }
        [$total, $distinct] = $this->rowCounts();
        if ($total !== $distinct) {
            self::fail('invariant', 'payment_hash is not unique');
        }
    }

    /**
     * @param array<string, mixed> $sequence
     * @return array{name: string, ok: bool, step?: int, kind?: string, message?: string}
     */
    public static function runSequence(array $sequence): array
    {
        $harness = new self();
        return $harness->replay($sequence);
    }

    /**
     * @param array<string, mixed> $sequence
     * @return array{name: string, ok: bool, step?: int, kind?: string, message?: string}
     */
    private function replay(array $sequence): array
    {
        $expected = [];
        $expectedLedger = [];
        $info = [];
        $current = [];
        foreach ($sequence['steps'] as $index => $step) {
            try {
                $this->now = $step['t'];
                $this->applyStep($step);
                if (isset($step['outcome'])) {
                    $actual = $this->outcome;
                    if ($step['op'] === 'commit' && $actual === 'inserted_or_idempotent' && in_array($step['outcome'], ['inserted', 'idempotent'], true)) {
                        $actual = $step['outcome'];
                    }
                    if ($actual !== $step['outcome']) {
                        self::fail('outcome', "expected {$step['outcome']}, got {$actual}");
                    }
                    if ($step['outcome'] === 'reused' && $this->reusedId !== $step['reused_id']) {
                        self::fail('outcome', "reused {$this->reusedId}, expected {$step['reused_id']}");
                    }
                }
                if (isset($step['reason']) && $this->lastReason !== $step['reason']) {
                    self::fail('outcome', "reason {$this->lastReason}, expected {$step['reason']}");
                }
                foreach ($step['rows'] ?? [] as $key => $row) {
                    $id = (int) $key;
                    if (!isset($expected[$id])) {
                        $info[$id] = ['expires_at' => $step['expires_at'] ?? null, 'rail' => $step['rail'] ?? null];
                    }
                    $expected[$id] = $row;
                }
                foreach ($step['fulfilled'] ?? [] as $entry) {
                    $expectedLedger[] = $entry;
                }
                $after = [];
                foreach (array_keys($expected) as $id) {
                    $row = $this->readRow($id);
                    if ($row === null) {
                        self::fail('state', "row {$id} missing from the engine");
                    }
                    $after[$id] = $row;
                }
                $this->checkInvariants($step, $current, $after, $info);
                foreach ($expected as $id => $wanted) {
                    $got = $after[$id];
                    if ([$got['status'], $got['reason'], $got['paid_at']] !== $wanted) {
                        self::fail('state', "row {$id}: engine " . json_encode($got) . ', model ' . json_encode($wanted));
                    }
                }
                if ($this->rowCounts()[0] !== count($expected)) {
                    self::fail('state', 'the engine holds rows the model does not');
                }
                $ledger = array_map(static fn (array $entry): array => [$entry[0], (int) hexdec(substr($entry[1], -12))], $this->ledger);
                if ($ledger !== $expectedLedger) {
                    self::fail('state', 'fulfillment ledger ' . json_encode($ledger) . ', model ' . json_encode($expectedLedger));
                }
                $current = $after;
            } catch (AttemptStateMachineFailure $failure) {
                return ['name' => $sequence['name'], 'ok' => false, 'step' => $index, 'kind' => $failure->kind, 'message' => $failure->getMessage()];
            } catch (\Throwable $error) {
                return ['name' => $sequence['name'], 'ok' => false, 'step' => $index, 'kind' => 'error', 'message' => get_class($error) . ': ' . $error->getMessage()];
            }
        }
        return ['name' => $sequence['name'], 'ok' => true];
    }
}

/** A failed model comparison or invariant; carries which check failed. */
final class AttemptStateMachineFailure extends \RuntimeException
{
    public function __construct(public readonly string $kind, string $message)
    {
        parent::__construct($message);
    }
}
