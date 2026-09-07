<?php

declare(strict_types=1);

namespace App\Testkit;

use OpenReceive\Testing\FakeSwapProvider;
use OpenReceive\Testing\FakeWallet;

/**
 * Testkit wallet mode for the Laravel stack (`DEMO_WALLET=testkit`).
 *
 * WHAT IS FAKED IS THE WALLET, THE SWAP PROVIDER AND THE PRICE FEED, and
 * nothing else: the engine, the three hooks, the migrations, the controllers
 * and the SPA are the production paths — which is the property that makes
 * driving this worth anything. The fakes are the engine's own
 * `OpenReceive\Testing` port of packages/js/testkit, down to the fixtures
 * (docs/internal/testkit-contract.md), so tests/e2e drives this stack with the
 * same helpers and the same strings as every other.
 *
 * It is OFF unless DEMO_WALLET=testkit: no compose file sets it, and the
 * control surface below answers a JSON 404 in every other mode.
 */
final class Testkit
{
    public const CONTROL_PREFIX = '/__testkit';

    public const SWAP_PROVIDER_STATES = [
        'creating_provider_order', 'awaiting_deposit', 'confirming', 'exchanging', 'paying_invoice', 'completed',
        'expired', 'refund_required', 'refund_pending', 'refunded', 'attention', 'failed',
    ];

    private static ?FakeWallet $wallet = null;
    private static ?FakeSwapProvider $swapProvider = null;
    /** @var resource|null */
    private static $lock = null;

    public static function enabled(): bool
    {
        return strtolower(trim((string) env('DEMO_WALLET', ''))) === 'testkit';
    }

    public static function wallet(): FakeWallet
    {
        self::open();
        /** @var FakeWallet */
        return self::$wallet;
    }

    public static function swapProvider(): FakeSwapProvider
    {
        self::open();
        /** @var FakeSwapProvider */
        return self::$swapProvider;
    }

    /**
     * THE ONE THING PHP HAS TO DO THAT THE OTHER STACKS DO NOT: keep the fakes
     * alive between requests. A Node or Python process holds its fake wallet in
     * memory for the life of the server; a PHP request starts from nothing, so
     * an invoice minted by `POST /openreceive/checkouts` would be unknown to the
     * `POST /__testkit/settle` that follows. The fakes' state is snapshotted to
     * a file in the data directory after every request (`save()`, from the
     * application's terminating callback) and restored here before the first
     * use, under an exclusive lock held for the request. The state is a test
     * fixture, not a datastore, and serialising it is the honest answer. The
     * engine's fakes are `final` with private fields, so the snapshot goes
     * through reflection, leaving the readonly fields and clock closures alone
     * — the same approach the plain-PHP demo takes.
     */
    private static function open(): void
    {
        if (self::$wallet !== null && self::$swapProvider !== null) {
            return;
        }
        $file = self::stateFile();
        $lock = fopen($file.'.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new \RuntimeException("cannot lock {$file}");
        }
        self::$lock = $lock;
        self::$wallet = new FakeWallet();
        self::$swapProvider = new FakeSwapProvider();
        if (is_file($file)) {
            $state = unserialize((string) file_get_contents($file), ['allowed_classes' => true]);
            if (is_array($state)) {
                self::restore(self::$wallet, (array) ($state['wallet'] ?? []));
                self::restore(self::$swapProvider, (array) ($state['swap'] ?? []));
            }
        }
    }

    /** Snapshot the fakes for the next request and release the lock. A request that never touched them writes nothing. */
    public static function save(): void
    {
        if (self::$wallet === null || self::$swapProvider === null || self::$lock === null) {
            return;
        }
        $file = self::stateFile();
        file_put_contents($file.'.tmp', serialize(['wallet' => self::snapshot(self::$wallet), 'swap' => self::snapshot(self::$swapProvider)]));
        rename($file.'.tmp', $file);
        flock(self::$lock, LOCK_UN);
        fclose(self::$lock);
        self::$lock = null;
        self::$wallet = null;
        self::$swapProvider = null;
    }

    /** Beside the SQLite file: OPENRECEIVE_DEMO_DB (the E2E harness's temp dir) or examples/buttons/.data. */
    private static function stateFile(): string
    {
        $dir = (string) env('OPENRECEIVE_DEMO_DB', '');
        if ($dir === '') {
            $dir = base_path('../../.data');
        }
        if (!is_dir($dir)) {
            mkdir($dir, 0o777, true);
        }
        return rtrim($dir, '/').'/buttons-laravel.testkit';
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

    /**
     * One control call, mirroring shared/server-node/testkit-controls.ts action
     * for action and payload for payload. Returns [status, body]. Not enabled
     * means 404 for EVERY action — probing the surface from any other mode
     * proves it is off.
     *
     * @param array<string, mixed> $params
     * @return array{0: int, 1: array<string, mixed>}
     */
    public static function control(string $action, array $params): array
    {
        if (!self::enabled()) {
            return [404, self::errorBody(404, 'Not found.')];
        }
        return match ($action) {
            'settle' => self::settle($params),
            'expire' => self::expire($params),
            'swap-step' => self::swapStep($params),
            'state' => [200, self::state()],
            default => [404, self::errorBody(404, 'Not found.')],
        };
    }

    /**
     * POST /__testkit/settle { payment_hash } — settle the invoice and emit the
     * NWC-02 payment_received notification exactly as a real wallet would. The
     * next payments/check poll observes it through the production rules;
     * nothing here touches an order row.
     *
     * @param array<string, mixed> $params
     * @return array{0: int, 1: array<string, mixed>}
     */
    private static function settle(array $params): array
    {
        $paymentHash = self::readString($params, 'payment_hash');
        if ($paymentHash === null) {
            return [400, self::errorBody(400, 'payment_hash is required')];
        }
        try {
            return [200, ['ok' => true, 'transaction' => self::wallet()->settleInvoice(['payment_hash' => $paymentHash], null, null, true)]];
        } catch (\OutOfBoundsException $e) {
            return [404, self::errorBody(404, $e->getMessage())];
        }
    }

    /**
     * @param array<string, mixed> $params
     * @return array{0: int, 1: array<string, mixed>}
     */
    private static function expire(array $params): array
    {
        $paymentHash = self::readString($params, 'payment_hash');
        if ($paymentHash === null) {
            return [400, self::errorBody(400, 'payment_hash is required')];
        }
        try {
            return [200, ['ok' => true, 'transaction' => self::wallet()->expireInvoice(['payment_hash' => $paymentHash])]];
        } catch (\OutOfBoundsException $e) {
            return [404, self::errorBody(404, $e->getMessage())];
        }
    }

    /**
     * POST /__testkit/swap-step { provider_order_id?, pay_in_asset?, state, attention_reason? }
     * Selected by the PROVIDER-side keys, because the fake provider has no
     * notion of the host order id — the same reason the Node surface takes them.
     *
     * @param array<string, mixed> $params
     * @return array{0: int, 1: array<string, mixed>}
     */
    private static function swapStep(array $params): array
    {
        $providerOrderId = self::readString($params, 'provider_order_id');
        $payInAsset = self::readString($params, 'pay_in_asset');
        $state = self::readString($params, 'state');
        if ($providerOrderId === null && $payInAsset === null) {
            return [400, self::errorBody(400, 'provider_order_id or pay_in_asset is required')];
        }
        if ($state === null || !in_array($state, self::SWAP_PROVIDER_STATES, true)) {
            return [400, self::errorBody(400, 'state must be one of: '.implode(', ', self::SWAP_PROVIDER_STATES))];
        }
        $selector = array_filter(['provider_order_id' => $providerOrderId, 'pay_in_asset' => $payInAsset], static fn (?string $value): bool => $value !== null);
        if ($state === 'refund_required') {
            self::swapProvider()->forceRefundRequired($selector);
        } elseif ($state === 'attention') {
            self::swapProvider()->forceAttention($selector, self::readString($params, 'attention_reason') ?? 'provider_reported_emergency');
        } else {
            self::swapProvider()->script($selector, [$state]);
        }
        return [200, ['ok' => true, 'state' => $state]];
    }

    /** @return array<string, mixed> */
    private static function state(): array
    {
        return ['wallet' => ['invoices' => self::wallet()->listInvoices()], 'swap' => self::swapProvider()->counters()];
    }

    /** @param array<string, mixed> $params */
    private static function readString(array $params, string $field): ?string
    {
        $value = $params[$field] ?? null;
        return is_string($value) && $value !== '' ? $value : null;
    }

    /** @return array{code: string, message: string, retryable: bool} */
    private static function errorBody(int $status, string $message): array
    {
        return ['code' => $status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', 'message' => $message, 'retryable' => false];
    }
}
