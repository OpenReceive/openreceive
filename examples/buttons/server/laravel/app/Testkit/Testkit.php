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

    public static function enabled(): bool
    {
        return strtolower(trim((string) env('DEMO_WALLET', ''))) === 'testkit';
    }

    /** The fakes, built once per process: PHP serves one request per process, so this is per request — the E2E harness runs one artisan server. */
    public static function wallet(): FakeWallet
    {
        return self::$wallet ??= new FakeWallet();
    }

    public static function swapProvider(): FakeSwapProvider
    {
        return self::$swapProvider ??= new FakeSwapProvider();
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
