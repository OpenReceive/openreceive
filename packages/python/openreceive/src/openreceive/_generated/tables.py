"""GENERATED FILE — DO NOT EDIT.

Source: spec/data/kernel-tables.json, spec/data/swap-state-table.json,
spec/schemas/error.schema.json, the OpenAPI and AsyncAPI documents
(npm run generate:models). Twins: packages/ruby/openreceive/lib/openreceive/generated/tables.rb,
packages/dotnet/BTCPayServer.Plugins.OpenReceive/Generated/OpenReceiveTables.cs,
packages/php/openreceive/src/Generated/Tables.php.
Every engine reads the same vocabularies from its rendering, so none can drift.

The closed vocabularies and fixed numbers every OpenReceive engine shares, plus
the FixedFloat status decision table. Read these; never restate them.
"""

from typing import Final

# The OpenAPI info.version this engine was built from.
HTTP_CONTRACT_VERSION: Final = "0.4.1"

# The AsyncAPI info.version this engine was built from.
EVENT_CONTRACT_VERSION: Final = "0.2.0"

ERROR_CODES: Final = (
    "NOT_IMPLEMENTED",
    "RESTRICTED",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "INTERNAL",
    "UNSUPPORTED_ENCRYPTION",
    "OTHER",
    "NOT_FOUND",
    "TIMEOUT",
    "INVALID_REQUEST",
    "WALLET_UNAVAILABLE",
    "INVOICE_EXPIRED",
    "UNSUPPORTED_METHOD",
    "CONFLICT",
)

RETRYABLE_ERROR_CODES: Final = (
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "TIMEOUT",
    "WALLET_UNAVAILABLE",
    "INTERNAL",
)

PAYMENT_STATUSES: Final = (
    "pending",
    "settled",
    "expired",
    "failed",
    "not_found",
)

PAYMENT_HASH_PATTERN: Final = "^[0-9a-f]{64}$"

MIN_AMOUNT_MSATS: Final = 1000

MAX_AMOUNT_MSATS: Final = 9007199254740991

NWC_REQUIRED_RECEIVE_METHODS: Final = (
    "make_invoice",
    "list_transactions",
)

NWC_SPEND_METHODS: Final = (
    "pay_invoice",
    "multi_pay_invoice",
    "pay_keysend",
    "multi_pay_keysend",
)

# Preference order: the first mode the wallet advertises wins.
NWC_ENCRYPTION_MODES: Final = (
    "nip44_v2",
    "nip04",
)

NWC_NOTIFICATION_TYPES: Final = (
    "payment_received",
)

NWC_METADATA_MAX_BYTES: Final = 3900

# The page size every wallet-history walk requests.
TRANSACTION_PAGE_LIMIT: Final = 20

# Seconds past an attempt's expiry during which reconciliation still scans
# for a settlement before closing the attempt.
ATTEMPT_EXPIRY_GRACE_SECONDS: Final = 900

SWAP_PAY_IN_ASSETS: Final = (
    "SOL_SOL",
    "USDT_TRON",
    "USDT_SOL",
    "USDC_SOL",
    "ETH_ETH",
    "USDT_ETH",
    "USDC_ETH",
)

SWAP_ASSET_INFO: Final = {
    "SOL_SOL": {
        "pay_in_asset": "SOL_SOL",
        "label": "SOL",
        "network_label": "Solana",
        "coin": "SOL",
        "network": "SOL",
    },
    "USDT_TRON": {
        "pay_in_asset": "USDT_TRON",
        "label": "USDT",
        "network_label": "Tron",
        "coin": "USDT",
        "network": "TRX",
    },
    "USDT_SOL": {
        "pay_in_asset": "USDT_SOL",
        "label": "USDT",
        "network_label": "Solana",
        "coin": "USDT",
        "network": "SOL",
    },
    "USDC_SOL": {
        "pay_in_asset": "USDC_SOL",
        "label": "USDC",
        "network_label": "Solana",
        "coin": "USDC",
        "network": "SOL",
    },
    "ETH_ETH": {
        "pay_in_asset": "ETH_ETH",
        "label": "ETH",
        "network_label": "Ethereum",
        "coin": "ETH",
        "network": "ETH",
    },
    "USDT_ETH": {
        "pay_in_asset": "USDT_ETH",
        "label": "USDT",
        "network_label": "Ethereum",
        "coin": "USDT",
        "network": "ETH",
    },
    "USDC_ETH": {
        "pay_in_asset": "USDC_ETH",
        "label": "USDC",
        "network_label": "Ethereum",
        "coin": "USDC",
        "network": "ETH",
    },
}

# phase: coarse UI bucket; terminal: the attempt will not change again.
# "completed" is deliberately NOT terminal: provider completion is not wallet
# settlement.
SWAP_STATES: Final = {
    "creating_provider_order": {
        "phase": "preparing",
        "terminal": False,
    },
    "awaiting_deposit": {
        "phase": "awaiting_deposit",
        "terminal": False,
    },
    "confirming": {
        "phase": "processing",
        "terminal": False,
    },
    "exchanging": {
        "phase": "processing",
        "terminal": False,
    },
    "paying_invoice": {
        "phase": "processing",
        "terminal": False,
    },
    "completed": {
        "phase": "settling",
        "terminal": False,
    },
    "expired": {
        "phase": "terminal",
        "terminal": True,
    },
    "refund_required": {
        "phase": "refund",
        "terminal": False,
    },
    "refund_pending": {
        "phase": "refund",
        "terminal": False,
    },
    "refunded": {
        "phase": "terminal",
        "terminal": True,
    },
    "attention": {
        "phase": "attention",
        "terminal": True,
    },
    "failed": {
        "phase": "terminal",
        "terminal": True,
    },
}

SWAP_PROVIDER_STATES: Final = (
    "creating_provider_order",
    "awaiting_deposit",
    "confirming",
    "exchanging",
    "paying_invoice",
    "completed",
    "expired",
    "refund_required",
    "refund_pending",
    "refunded",
    "attention",
    "failed",
)

SWAP_ATTENTION_REASONS: Final = (
    "provider_reported_emergency",
    "provider_status_unrecognized",
    "provider_completed_without_wallet_settlement",
)

SWAP_REFUND_REASONS: Final = (
    "underpaid",
    "overpaid",
    "late_deposit",
    "underpaid_and_late",
    "overpaid_and_late",
)

SWAP_AVAILABILITY_REASONS: Final = (
    "provider_unconfigured",
    "amount_too_small",
    "amount_too_large",
    "pair_temporarily_unavailable",
    "region_unsupported",
    "provider_rate_limited",
    "provider_unreachable",
)

# spec/data/swap-state-table.json: ordered, first-match-wins; the last row is a
# catch-all. "status" is the upper-cased provider status or "*" (narrowed by
# "status_contains"); "refund_tx_present" is True, False or "any"; "choice" is
# the upper-cased emergency choice, "absent" or "any". A non-None
# "attention_reason" means the result also carries attention: True. Pinned by
# spec/test-vectors/swap-state.json; how to read it lives once, in the JSON's
# how_to_read.
SWAP_STATUS_ROWS: Final = (
    {
        "status": "DONE",
        "status_contains": None,
        "refund_tx_present": True,
        "choice": "any",
        "state": "refunded",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "FINISHED",
        "status_contains": None,
        "refund_tx_present": True,
        "choice": "any",
        "state": "refunded",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "NEW",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "awaiting_deposit",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "PENDING",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "confirming",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "EXCHANGE",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "exchanging",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "WITHDRAW",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "paying_invoice",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "DONE",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "completed",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "EXPIRED",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "expired",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "EMERGENCY",
        "status_contains": None,
        "refund_tx_present": True,
        "choice": "REFUND",
        "state": "refunded",
        "attention_reason": None,
        "refund_reason_from_emergency": True,
    },
    {
        "status": "EMERGENCY",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "REFUND",
        "state": "refund_pending",
        "attention_reason": None,
        "refund_reason_from_emergency": True,
    },
    {
        "status": "EMERGENCY",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "EXCHANGE",
        "state": "attention",
        "attention_reason": "provider_reported_emergency",
        "refund_reason_from_emergency": False,
    },
    {
        "status": "EMERGENCY",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "refund_required",
        "attention_reason": None,
        "refund_reason_from_emergency": True,
    },
    {
        "status": "*",
        "status_contains": "FAIL",
        "refund_tx_present": "any",
        "choice": "any",
        "state": "failed",
        "attention_reason": None,
        "refund_reason_from_emergency": False,
    },
    {
        "status": "*",
        "status_contains": None,
        "refund_tx_present": "any",
        "choice": "any",
        "state": "attention",
        "attention_reason": "provider_status_unrecognized",
        "refund_reason_from_emergency": False,
    },
)

# Emergency status spellings folded onto their canonical name before matching.
SWAP_EMERGENCY_STATUS_ALIASES: Final = {
    "OVER": "MORE",
    "OVERPAID": "MORE",
}

# Ordered; a row matches when every "all_of" status is present. No match, no
# refund_reason.
SWAP_REFUND_REASON_ROWS: Final = (
    {
        "all_of": (
            "LESS",
            "EXPIRED",
        ),
        "refund_reason": "underpaid_and_late",
    },
    {
        "all_of": (
            "MORE",
            "EXPIRED",
        ),
        "refund_reason": "overpaid_and_late",
    },
    {
        "all_of": (
            "LESS",
        ),
        "refund_reason": "underpaid",
    },
    {
        "all_of": (
            "MORE",
        ),
        "refund_reason": "overpaid",
    },
    {
        "all_of": (
            "EXPIRED",
        ),
        "refund_reason": "late_deposit",
    },
)
