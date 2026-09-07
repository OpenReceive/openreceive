<?php

declare(strict_types=1);

namespace OpenReceive\Testing;

use OpenReceive\Swap\Assets;
use OpenReceive\Swap\SwapProvider;

/**
 * An in-memory swap provider: the PHP port of the JS testkit's
 * TestkitSwapProvider (docs/internal/testkit-contract.md) — same deposit
 * addresses per NETWORK, same `testkit-swap-N` order ids, same "1.05" pay
 * amount — so one Playwright suite drives every stack.
 */
final class FakeSwapProvider implements SwapProvider
{
    /** One address per NETWORK, not per asset — exactly the ambiguity the deposit panel's warning is about. */
    public const NETWORK_DEPOSIT_ADDRESS = [
        'TRX' => 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
        'SOL' => 'So11111111111111111111111111111111111111112',
        'ETH' => '0x1111111111111111111111111111111111111111',
    ];
    public const PAY_AMOUNT = '1.05';
    /** The shadow invoice must outlive the provider order; the service takes this as a FLOOR. */
    public const INVOICE_EXPIRY_SECONDS = 1_800;
    public const DEPOSIT_EXPIRY_SECONDS = 900;
    public const PROGRESS_ORDER = ['creating_provider_order', 'awaiting_deposit', 'confirming', 'exchanging', 'paying_invoice', 'completed'];

    /** @var callable(): int */
    private $clock;
    /** @var array<string, array<string, mixed>> order, steps, next, attention_reason */
    private array $orders = [];
    /** @var array<string, array{steps: list<string>, attention_reason: ?string}> an asset scripted BEFORE any attempt arms the next attempt */
    private array $pending = [];
    /** @var array<string, string> */
    private array $payAmountOverrides = [];
    private ?\Throwable $nextCreateError = null;
    private int $createCalls = 0;
    private int $quoteCalls = 0;
    private int $statusCalls = 0;
    /** @var list<array{provider_order_id: string, refund_address: string}> */
    private array $refundCalls = [];

    /** @param (callable(): int)|null $clock */
    public function __construct(private readonly string $providerName = 'fixedfloat', ?callable $clock = null)
    {
        $this->clock = $clock ?? static fn (): int => time();
    }

    public function name(): string
    {
        return $this->providerName;
    }

    public function supportedPayInAssets(): array
    {
        return Assets::PAY_IN_ASSETS;
    }

    public function payInAssetCatalog(): array
    {
        return array_map(static fn (string $asset): array => [
            'pay_asset' => $asset, 'available' => true, 'minimum_pay_amount' => '1', 'maximum_pay_amount' => '5000',
        ], Assets::PAY_IN_ASSETS);
    }

    public function invoiceExpirySeconds(?string $payInAsset = null): int
    {
        return self::INVOICE_EXPIRY_SECONDS;
    }

    public function quote(string $payInAsset, int $invoiceAmountMsats): array
    {
        $this->quoteCalls++;
        return [
            'pay_amount' => $this->payAmountOverrides[$payInAsset] ?? self::PAY_AMOUNT,
            'pay_asset' => $payInAsset,
            'available' => true,
            'provider' => $this->providerName,
            'minimum_pay_amount' => '1',
            'maximum_pay_amount' => '5000',
        ];
    }

    public function createSwap(string $payInAsset, string $bolt11, int $invoiceAmountMsats): array
    {
        if ($this->nextCreateError !== null) {
            $error = $this->nextCreateError;
            $this->nextCreateError = null;
            throw $error;
        }
        $this->createCalls++;
        $id = "testkit-swap-{$this->createCalls}";
        $order = [
            'provider' => $this->providerName,
            'provider_order_id' => $id,
            'provider_token' => "testkit-token-{$this->createCalls}",
            'pay_in_asset' => $payInAsset,
            'deposit_address' => self::NETWORK_DEPOSIT_ADDRESS[Assets::info($payInAsset)['network']],
            'deposit_amount' => $this->payAmountOverrides[$payInAsset] ?? self::PAY_AMOUNT,
            'expires_at' => ($this->clock)() + self::DEPOSIT_EXPIRY_SECONDS,
            'state' => 'awaiting_deposit',
        ];
        $armed = $this->pending[$payInAsset] ?? null;
        unset($this->pending[$payInAsset]);
        $this->orders[$id] = ['order' => $order, 'steps' => $armed['steps'] ?? [], 'next' => 0, 'attention_reason' => $armed['attention_reason'] ?? null];
        return $order;
    }

    /** One step per poll, then hold on the last state. */
    public function getStatus(array $order): array
    {
        $this->statusCalls++;
        $id = (string) ($order['provider_order_id'] ?? '');
        $entry = $this->orders[$id] ?? null;
        if ($entry === null) {
            return $order;
        }
        if ($entry['next'] < count($entry['steps'])) {
            $state = $entry['steps'][$entry['next']];
            $entry['next']++;
            $entry['order'] = self::applyState($entry['order'], $state, $entry['attention_reason']);
            $this->orders[$id] = $entry;
        }
        return $entry['order'];
    }

    public function requestRefund(array $order, string $refundAddress): void
    {
        $id = (string) ($order['provider_order_id'] ?? '');
        $this->refundCalls[] = ['provider_order_id' => $id, 'refund_address' => $refundAddress];
        if (isset($this->orders[$id])) {
            $this->orders[$id]['order'] = self::applyState($this->orders[$id]['order'], 'refund_pending', null);
        }
    }

    // ------------------------------------------------------------- controls

    /**
     * Queue states for the selected attempts, and arm the asset so an attempt created later gets them too.
     *
     * @param array{pay_in_asset?: string, provider_order_id?: string}|string $selector
     * @param list<string> $states
     */
    public function script(array|string $selector, array $states, ?string $attentionReason = null): void
    {
        if ($states === []) {
            throw new \InvalidArgumentException('swap script must include at least one state');
        }
        $selector = self::selector($selector);
        foreach ($this->matching($selector) as $id) {
            $this->orders[$id]['steps'] = array_values($states);
            $this->orders[$id]['next'] = 0;
            $this->orders[$id]['attention_reason'] = $attentionReason;
        }
        if (isset($selector['pay_in_asset'])) {
            $this->pending[$selector['pay_in_asset']] = ['steps' => array_values($states), 'attention_reason' => $attentionReason];
        }
    }

    /**
     * `refund_required` and `attention` land IMMEDIATELY: they are the states a test jumps to.
     *
     * @param array{pay_in_asset?: string, provider_order_id?: string}|string $selector
     */
    public function force(array|string $selector, string $state, ?string $attentionReason = null): void
    {
        $selector = self::selector($selector);
        foreach ($this->matching($selector) as $id) {
            $this->orders[$id]['steps'] = [];
            $this->orders[$id]['next'] = 0;
            $this->orders[$id]['attention_reason'] = $attentionReason;
            $this->orders[$id]['order'] = self::applyState($this->orders[$id]['order'], $state, $attentionReason);
        }
        if (isset($selector['pay_in_asset'])) {
            $this->pending[$selector['pay_in_asset']] = ['steps' => [$state], 'attention_reason' => $attentionReason];
        }
    }

    /** @param array{pay_in_asset?: string, provider_order_id?: string}|string $selector */
    public function forceRefundRequired(array|string $selector): void
    {
        $this->force($selector, 'refund_required');
    }

    /** @param array{pay_in_asset?: string, provider_order_id?: string}|string $selector */
    public function forceAttention(array|string $selector, string $reason = 'provider_reported_emergency'): void
    {
        $this->force($selector, 'attention', $reason);
    }

    public function forceCreateError(?\Throwable $error = null): void
    {
        $this->nextCreateError = $error ?? new \RuntimeException('testkit swap create failure');
    }

    public function setPayAmount(string $payInAsset, string $payAmount): void
    {
        $this->payAmountOverrides[$payInAsset] = $payAmount;
    }

    /** @return array{create_calls: int, quote_calls: int, status_calls: int, refund_calls: list<array{provider_order_id: string, refund_address: string}>} */
    public function counters(): array
    {
        return ['create_calls' => $this->createCalls, 'quote_calls' => $this->quoteCalls, 'status_calls' => $this->statusCalls, 'refund_calls' => $this->refundCalls];
    }

    /** @param array{pay_in_asset?: string, provider_order_id?: string}|string $selector @return array{pay_in_asset?: string, provider_order_id?: string} */
    private static function selector(array|string $selector): array
    {
        return is_string($selector) ? ['pay_in_asset' => $selector] : $selector;
    }

    /** @param array{pay_in_asset?: string, provider_order_id?: string} $selector @return list<string> */
    private function matching(array $selector): array
    {
        $ids = [];
        foreach ($this->orders as $id => $entry) {
            if (isset($selector['provider_order_id']) && $entry['order']['provider_order_id'] !== $selector['provider_order_id']) {
                continue;
            }
            if (isset($selector['pay_in_asset']) && $entry['order']['pay_in_asset'] !== $selector['pay_in_asset']) {
                continue;
            }
            $ids[] = $id;
        }
        return $ids;
    }

    /** @param array<string, mixed> $order @return array<string, mixed> */
    private static function applyState(array $order, string $state, ?string $attentionReason): array
    {
        $next = [...$order, 'state' => $state];
        $stateIndex = array_search($state, self::PROGRESS_ORDER, true);
        $floorIndex = array_search('confirming', self::PROGRESS_ORDER, true);
        if ($stateIndex !== false && $floorIndex !== false && $stateIndex >= $floorIndex) {
            $next['deposit_tx_id'] = 'testkit-deposit-tx';
        }
        if ($state === 'completed') {
            $next['payout_tx_id'] = 'testkit-payout-tx';
        }
        if ($state === 'refunded') {
            $next['refund_tx_id'] = 'testkit-refund-tx';
        }
        if ($state === 'attention') {
            $next['attention'] = true;
            if ($attentionReason !== null) {
                $next['attention_reason'] = $attentionReason;
            }
        }
        return $next;
    }
}
