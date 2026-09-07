<?php

declare(strict_types=1);

namespace ButtonShop;

use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;

/**
 * Testkit wallet mode (`DEMO_WALLET=testkit`): the engine's own fakes —
 * `OpenReceive\Testing\FakeWallet` and `FakeSwapProvider`, the fixtures pinned
 * by docs/internal/testkit-contract.md — plus the four `/__testkit` control
 * routes every Buy a Button stack mounts. In any other mode the whole prefix
 * is a JSON 404 (see public/index.php).
 *
 * THE ONE THING PHP HAS TO DO THAT THE OTHER STACKS DO NOT: keep the fakes
 * alive between requests. A Node or Python process holds its fake wallet in
 * memory for the life of the server; a PHP request starts from nothing, so an
 * invoice minted by `POST /openreceive/checkouts` would be unknown to the
 * `POST /__testkit/settle` that follows. This class snapshots the fakes'
 * state to a file in the data directory after every request and restores it
 * before the next, under an exclusive lock held for the request — the state is
 * a test fixture, not a datastore, and serialising it is the honest answer.
 * The engine's fakes are `final` with private fields, so the snapshot reads and
 * writes them through reflection: constructor-set readonly fields and the
 * clock closures are left alone (the defaults are what a demo wants).
 */
final class Testkit
{
    public const PREFIX = '/__testkit';
    private const STATES = ['creating_provider_order', 'awaiting_deposit', 'confirming', 'exchanging', 'paying_invoice', 'completed', 'expired', 'refund_required', 'refund_pending', 'refunded', 'attention', 'failed'];

    public readonly FakeWallet $wallet;
    public readonly FakeSwapProvider $swap;
    /** @var resource */
    private $lock;

    private function __construct(private readonly string $file)
    {
        $lock = fopen($file . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new \RuntimeException("cannot lock {$file}");
        }
        $this->lock = $lock;
        $this->wallet = new FakeWallet();
        $this->swap = new FakeSwapProvider();
        if (is_file($file)) {
            $state = unserialize((string) file_get_contents($file), ['allowed_classes' => true]);
            if (is_array($state)) {
                self::restore($this->wallet, $state['wallet'] ?? []);
                self::restore($this->swap, $state['swap'] ?? []);
            }
        }
    }

    /** Restore the fakes from the last request (holding the lock) — call before building the Service. */
    public static function open(string $dataDir): self
    {
        return new self($dataDir . '/php-plain.testkit');
    }

    /** Snapshot the fakes for the next request and release the lock — call after the response went out. */
    public function save(): void
    {
        $tmp = $this->file . '.tmp';
        file_put_contents($tmp, serialize(['wallet' => self::snapshot($this->wallet), 'swap' => self::snapshot($this->swap)]));
        rename($tmp, $this->file);
        flock($this->lock, LOCK_UN);
        fclose($this->lock);
    }

    /**
     * One control call. `action` is the path segment after the prefix.
     *
     * @param array<string, mixed> $body
     * @return array{0: int, 1: array<string, mixed>}
     */
    public function control(string $action, array $body): array
    {
        $string = static fn (string $field): ?string => is_string($body[$field] ?? null) && $body[$field] !== '' ? $body[$field] : null;
        switch ($action) {
            // Settle and emit the NWC-02 payment_received notification, exactly as a real wallet would.
            case 'settle':
            case 'expire':
                $hash = $string('payment_hash');
                if ($hash === null) {
                    return self::invalid('payment_hash is required');
                }
                try {
                    $transaction = $action === 'settle' ? $this->wallet->settleInvoice(['payment_hash' => $hash], null, null, true) : $this->wallet->expireInvoice(['payment_hash' => $hash]);
                } catch (\OutOfBoundsException $e) {
                    return [404, self::errorBody(404, $e->getMessage())];
                }
                return [200, ['ok' => true, 'transaction' => $transaction]];
            // Advance the scripted swap provider; refund_required and attention route through the force helpers.
            case 'swap-step':
                $selector = array_filter(['pay_in_asset' => $string('pay_in_asset'), 'provider_order_id' => $string('provider_order_id')]);
                $state = $string('state');
                if ($selector === []) {
                    return self::invalid('provider_order_id or pay_in_asset is required');
                }
                if ($state === null || !in_array($state, self::STATES, true)) {
                    return self::invalid('state must be one of: ' . implode(', ', self::STATES));
                }
                if ($state === 'refund_required') {
                    $this->swap->forceRefundRequired($selector);
                } elseif ($state === 'attention') {
                    $reason = $string('attention_reason');
                    $reason === null ? $this->swap->forceAttention($selector) : $this->swap->forceAttention($selector, $reason);
                } else {
                    $this->swap->script($selector, [$state]);
                }
                return [200, ['ok' => true, 'state' => $state]];
            // Debug aid: current wallet invoices + swap counters.
            case 'state':
                return [200, ['wallet' => ['invoices' => $this->wallet->listInvoices()], 'swap' => $this->swap->counters()]];
            default:
                return [404, self::errorBody(404, 'Not found.')];
        }
    }

    /** @return array{0: int, 1: array<string, mixed>} */
    private static function invalid(string $message): array
    {
        return [400, self::errorBody(400, $message)];
    }

    /** The Node demos' `errorBody` shape. @return array<string, mixed> */
    public static function errorBody(int $status, string $message): array
    {
        return ['code' => $status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', 'message' => $message, 'retryable' => false];
    }

    /** @return array<string, mixed> every private field that is plain data (no closures, nothing readonly) */
    private static function snapshot(object $fake): array
    {
        $state = [];
        foreach ((new \ReflectionObject($fake))->getProperties() as $property) {
            if ($property->isReadOnly() || $property->isStatic() || !$property->isInitialized($fake)) {
                continue;
            }
            $value = $property->getValue($fake);
            if (!self::containsClosure($value)) {
                $state[$property->getName()] = $value;
            }
        }
        return $state;
    }

    /** @param array<string, mixed> $state */
    private static function restore(object $fake, array $state): void
    {
        $reflection = new \ReflectionObject($fake);
        foreach ($state as $name => $value) {
            if ($reflection->hasProperty($name) && !$reflection->getProperty($name)->isReadOnly()) {
                $reflection->getProperty($name)->setValue($fake, $value);
            }
        }
    }

    private static function containsClosure(mixed $value): bool
    {
        if ($value instanceof \Closure) {
            return true;
        }
        if (is_array($value)) {
            foreach ($value as $entry) {
                if (self::containsClosure($entry)) {
                    return true;
                }
            }
        }
        return false;
    }
}
