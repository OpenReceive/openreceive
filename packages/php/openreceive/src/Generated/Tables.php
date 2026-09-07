<?php

// GENERATED FILE — DO NOT EDIT.
// Source: spec/data/kernel-tables.json, spec/data/swap-state-table.json,
// spec/schemas/error.schema.json, the OpenAPI and AsyncAPI documents
// (npm run generate:models). Twins: packages/ruby/openreceive/lib/openreceive/generated/tables.rb,
// packages/dotnet/BTCPayServer.Plugins.OpenReceive/Generated/OpenReceiveTables.cs,
// packages/python/openreceive/src/openreceive/_generated/tables.py.
// Every engine reads the same vocabularies from its rendering, so none can drift.

declare(strict_types=1);

namespace OpenReceive\Generated;

/**
 * The closed vocabularies and fixed numbers every OpenReceive engine shares,
 * plus the FixedFloat status decision table. Read these; never restate them.
 */
final class Tables
{
    /** The OpenAPI info.version this engine was built from. */
    public const HTTP_CONTRACT_VERSION = '0.4.1';

    /** The AsyncAPI info.version this engine was built from. */
    public const EVENT_CONTRACT_VERSION = '0.2.0';

    public const ERROR_CODES = [
        'NOT_IMPLEMENTED',
        'RESTRICTED',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'RATE_LIMITED',
        'QUOTA_EXCEEDED',
        'INTERNAL',
        'UNSUPPORTED_ENCRYPTION',
        'OTHER',
        'NOT_FOUND',
        'TIMEOUT',
        'INVALID_REQUEST',
        'WALLET_UNAVAILABLE',
        'INVOICE_EXPIRED',
        'UNSUPPORTED_METHOD',
        'CONFLICT',
    ];

    public const RETRYABLE_ERROR_CODES = [
        'RATE_LIMITED',
        'QUOTA_EXCEEDED',
        'TIMEOUT',
        'WALLET_UNAVAILABLE',
        'INTERNAL',
    ];

    public const PAYMENT_STATUSES = [
        'pending',
        'settled',
        'expired',
        'failed',
        'not_found',
    ];

    public const PAYMENT_HASH_PATTERN = '^[0-9a-f]{64}$';

    public const MIN_AMOUNT_MSATS = 1000;

    public const MAX_AMOUNT_MSATS = 9007199254740991;

    public const NWC_REQUIRED_RECEIVE_METHODS = [
        'make_invoice',
        'list_transactions',
    ];

    public const NWC_SPEND_METHODS = [
        'pay_invoice',
        'multi_pay_invoice',
        'pay_keysend',
        'multi_pay_keysend',
    ];

    /** Preference order: the first mode the wallet advertises wins. */
    public const NWC_ENCRYPTION_MODES = [
        'nip44_v2',
        'nip04',
    ];

    public const NWC_NOTIFICATION_TYPES = [
        'payment_received',
    ];

    public const NWC_METADATA_MAX_BYTES = 3900;

    /** The page size every wallet-history walk requests. */
    public const TRANSACTION_PAGE_LIMIT = 20;

    /** Seconds past an attempt's expiry during which reconciliation still scans for a settlement before closing the attempt. */
    public const ATTEMPT_EXPIRY_GRACE_SECONDS = 900;

    public const SWAP_PAY_IN_ASSETS = [
        'SOL_SOL',
        'USDT_TRON',
        'USDT_SOL',
        'USDC_SOL',
        'ETH_ETH',
        'USDT_ETH',
        'USDC_ETH',
    ];

    public const SWAP_ASSET_INFO = [
        'SOL_SOL' => [
            'pay_in_asset' => 'SOL_SOL',
            'label' => 'SOL',
            'network_label' => 'Solana',
            'coin' => 'SOL',
            'network' => 'SOL',
        ],
        'USDT_TRON' => [
            'pay_in_asset' => 'USDT_TRON',
            'label' => 'USDT',
            'network_label' => 'Tron',
            'coin' => 'USDT',
            'network' => 'TRX',
        ],
        'USDT_SOL' => [
            'pay_in_asset' => 'USDT_SOL',
            'label' => 'USDT',
            'network_label' => 'Solana',
            'coin' => 'USDT',
            'network' => 'SOL',
        ],
        'USDC_SOL' => [
            'pay_in_asset' => 'USDC_SOL',
            'label' => 'USDC',
            'network_label' => 'Solana',
            'coin' => 'USDC',
            'network' => 'SOL',
        ],
        'ETH_ETH' => [
            'pay_in_asset' => 'ETH_ETH',
            'label' => 'ETH',
            'network_label' => 'Ethereum',
            'coin' => 'ETH',
            'network' => 'ETH',
        ],
        'USDT_ETH' => [
            'pay_in_asset' => 'USDT_ETH',
            'label' => 'USDT',
            'network_label' => 'Ethereum',
            'coin' => 'USDT',
            'network' => 'ETH',
        ],
        'USDC_ETH' => [
            'pay_in_asset' => 'USDC_ETH',
            'label' => 'USDC',
            'network_label' => 'Ethereum',
            'coin' => 'USDC',
            'network' => 'ETH',
        ],
    ];

    /** phase: coarse UI bucket; terminal: the attempt will not change again. "completed" is deliberately NOT terminal: provider completion is not wallet settlement. */
    public const SWAP_STATES = [
        'creating_provider_order' => [
            'phase' => 'preparing',
            'terminal' => false,
        ],
        'awaiting_deposit' => [
            'phase' => 'awaiting_deposit',
            'terminal' => false,
        ],
        'confirming' => [
            'phase' => 'processing',
            'terminal' => false,
        ],
        'exchanging' => [
            'phase' => 'processing',
            'terminal' => false,
        ],
        'paying_invoice' => [
            'phase' => 'processing',
            'terminal' => false,
        ],
        'completed' => [
            'phase' => 'settling',
            'terminal' => false,
        ],
        'expired' => [
            'phase' => 'terminal',
            'terminal' => true,
        ],
        'refund_required' => [
            'phase' => 'refund',
            'terminal' => false,
        ],
        'refund_pending' => [
            'phase' => 'refund',
            'terminal' => false,
        ],
        'refunded' => [
            'phase' => 'terminal',
            'terminal' => true,
        ],
        'attention' => [
            'phase' => 'attention',
            'terminal' => true,
        ],
        'failed' => [
            'phase' => 'terminal',
            'terminal' => true,
        ],
    ];

    public const SWAP_PROVIDER_STATES = [
        'creating_provider_order',
        'awaiting_deposit',
        'confirming',
        'exchanging',
        'paying_invoice',
        'completed',
        'expired',
        'refund_required',
        'refund_pending',
        'refunded',
        'attention',
        'failed',
    ];

    public const SWAP_ATTENTION_REASONS = [
        'provider_reported_emergency',
        'provider_status_unrecognized',
        'provider_completed_without_wallet_settlement',
    ];

    public const SWAP_REFUND_REASONS = [
        'underpaid',
        'overpaid',
        'late_deposit',
        'underpaid_and_late',
        'overpaid_and_late',
    ];

    public const SWAP_AVAILABILITY_REASONS = [
        'provider_unconfigured',
        'amount_too_small',
        'amount_too_large',
        'pair_temporarily_unavailable',
        'region_unsupported',
        'provider_rate_limited',
        'provider_unreachable',
    ];

    /** spec/data/swap-state-table.json: ordered, first-match-wins; the last row is a catch-all. "status" is the upper-cased provider status or "*" (narrowed by "status_contains"); "refund_tx_present" is true, false or "any"; "choice" is the upper-cased emergency choice, "absent" or "any". A non-null "attention_reason" means the result also carries attention: true. Pinned by spec/test-vectors/swap-state.json; how to read it lives once, in the JSON's how_to_read. */
    public const SWAP_STATUS_ROWS = [
        [
            'status' => 'DONE',
            'status_contains' => null,
            'refund_tx_present' => true,
            'choice' => 'any',
            'state' => 'refunded',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'FINISHED',
            'status_contains' => null,
            'refund_tx_present' => true,
            'choice' => 'any',
            'state' => 'refunded',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'NEW',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'awaiting_deposit',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'PENDING',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'confirming',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'EXCHANGE',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'exchanging',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'WITHDRAW',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'paying_invoice',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'DONE',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'completed',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'EXPIRED',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'expired',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'EMERGENCY',
            'status_contains' => null,
            'refund_tx_present' => true,
            'choice' => 'REFUND',
            'state' => 'refunded',
            'attention_reason' => null,
            'refund_reason_from_emergency' => true,
        ],
        [
            'status' => 'EMERGENCY',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'REFUND',
            'state' => 'refund_pending',
            'attention_reason' => null,
            'refund_reason_from_emergency' => true,
        ],
        [
            'status' => 'EMERGENCY',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'EXCHANGE',
            'state' => 'attention',
            'attention_reason' => 'provider_reported_emergency',
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => 'EMERGENCY',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'refund_required',
            'attention_reason' => null,
            'refund_reason_from_emergency' => true,
        ],
        [
            'status' => '*',
            'status_contains' => 'FAIL',
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'failed',
            'attention_reason' => null,
            'refund_reason_from_emergency' => false,
        ],
        [
            'status' => '*',
            'status_contains' => null,
            'refund_tx_present' => 'any',
            'choice' => 'any',
            'state' => 'attention',
            'attention_reason' => 'provider_status_unrecognized',
            'refund_reason_from_emergency' => false,
        ],
    ];

    /** Emergency status spellings folded onto their canonical name before matching. */
    public const SWAP_EMERGENCY_STATUS_ALIASES = [
        'OVER' => 'MORE',
        'OVERPAID' => 'MORE',
    ];

    /** Ordered; a row matches when every "all_of" status is present. No match, no refund_reason. */
    public const SWAP_REFUND_REASON_ROWS = [
        [
            'all_of' => [
                'LESS',
                'EXPIRED',
            ],
            'refund_reason' => 'underpaid_and_late',
        ],
        [
            'all_of' => [
                'MORE',
                'EXPIRED',
            ],
            'refund_reason' => 'overpaid_and_late',
        ],
        [
            'all_of' => [
                'LESS',
            ],
            'refund_reason' => 'underpaid',
        ],
        [
            'all_of' => [
                'MORE',
            ],
            'refund_reason' => 'overpaid',
        ],
        [
            'all_of' => [
                'EXPIRED',
            ],
            'refund_reason' => 'late_deposit',
        ],
    ];
}
