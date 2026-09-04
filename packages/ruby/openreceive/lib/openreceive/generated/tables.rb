# frozen_string_literal: true

# GENERATED FILE — DO NOT EDIT.
# Source: spec/data/kernel-tables.json, spec/schemas/error.schema.json and the
# OpenAPI document (npm run generate:models).
# JS twins: packages/js/core/src/generated/contracts.ts and
#           packages/js/node/src/generated/swap-tables.ts
# C# twin:  packages/dotnet/BTCPayServer.Plugins.OpenReceive/Generated/OpenReceiveTables.cs
# Every engine reads the same vocabularies from its rendering, so none can drift.

module OpenReceive
  module Generated
    HTTP_CONTRACT_VERSION = "0.4.1"

    ERROR_CODES = [
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
    ].freeze
    RETRYABLE_ERROR_CODES = [
      "RATE_LIMITED",
      "QUOTA_EXCEEDED",
      "TIMEOUT",
      "WALLET_UNAVAILABLE",
      "INTERNAL",
    ].freeze
    PAYMENT_STATUSES = [
      "pending",
      "settled",
      "expired",
      "failed",
      "not_found",
    ].freeze
    PAYMENT_HASH_PATTERN = "^[0-9a-f]{64}$"
    MIN_AMOUNT_MSATS = 1000
    MAX_AMOUNT_MSATS = 9_007_199_254_740_991

    NWC_REQUIRED_RECEIVE_METHODS = [
      "make_invoice",
      "list_transactions",
    ].freeze
    NWC_SPEND_METHODS = [
      "pay_invoice",
      "multi_pay_invoice",
      "pay_keysend",
      "multi_pay_keysend",
    ].freeze
    # Preference order: the first mode the wallet advertises wins.
    NWC_ENCRYPTION_MODES = [
      "nip44_v2",
      "nip04",
    ].freeze
    NWC_NOTIFICATION_TYPES = [
      "payment_received",
    ].freeze
    NWC_METADATA_MAX_BYTES = 3900
    # The page size every wallet-history walk requests.
    TRANSACTION_PAGE_LIMIT = 20

    # Seconds past an attempt's expiry during which reconciliation still scans
    # for a settlement before closing the attempt.
    ATTEMPT_EXPIRY_GRACE_SECONDS = 900

    SWAP_PAY_IN_ASSETS = [
      "SOL_SOL",
      "USDT_TRON",
      "USDT_SOL",
      "USDC_SOL",
      "ETH_ETH",
      "USDT_ETH",
      "USDC_ETH",
    ].freeze
    SWAP_ASSET_INFO = {
      "SOL_SOL" => {
        "pay_in_asset" => "SOL_SOL", "label" => "SOL",
        "network_label" => "Solana", "coin" => "SOL",
        "network" => "SOL"
      }.freeze,
      "USDT_TRON" => {
        "pay_in_asset" => "USDT_TRON", "label" => "USDT",
        "network_label" => "Tron", "coin" => "USDT",
        "network" => "TRX"
      }.freeze,
      "USDT_SOL" => {
        "pay_in_asset" => "USDT_SOL", "label" => "USDT",
        "network_label" => "Solana", "coin" => "USDT",
        "network" => "SOL"
      }.freeze,
      "USDC_SOL" => {
        "pay_in_asset" => "USDC_SOL", "label" => "USDC",
        "network_label" => "Solana", "coin" => "USDC",
        "network" => "SOL"
      }.freeze,
      "ETH_ETH" => {
        "pay_in_asset" => "ETH_ETH", "label" => "ETH",
        "network_label" => "Ethereum", "coin" => "ETH",
        "network" => "ETH"
      }.freeze,
      "USDT_ETH" => {
        "pay_in_asset" => "USDT_ETH", "label" => "USDT",
        "network_label" => "Ethereum", "coin" => "USDT",
        "network" => "ETH"
      }.freeze,
      "USDC_ETH" => {
        "pay_in_asset" => "USDC_ETH", "label" => "USDC",
        "network_label" => "Ethereum", "coin" => "USDC",
        "network" => "ETH"
      }.freeze,
    }.freeze

    # phase: coarse UI bucket; terminal: the attempt will not change again.
    # "completed" is deliberately NOT terminal: provider completion is not
    # wallet settlement.
    SWAP_STATES = {
      "creating_provider_order" => { "phase" => "preparing", "terminal" => false }.freeze,
      "awaiting_deposit" => { "phase" => "awaiting_deposit", "terminal" => false }.freeze,
      "confirming" => { "phase" => "processing", "terminal" => false }.freeze,
      "exchanging" => { "phase" => "processing", "terminal" => false }.freeze,
      "paying_invoice" => { "phase" => "processing", "terminal" => false }.freeze,
      "completed" => { "phase" => "settling", "terminal" => false }.freeze,
      "expired" => { "phase" => "terminal", "terminal" => true }.freeze,
      "refund_required" => { "phase" => "refund", "terminal" => false }.freeze,
      "refund_pending" => { "phase" => "refund", "terminal" => false }.freeze,
      "refunded" => { "phase" => "terminal", "terminal" => true }.freeze,
      "attention" => { "phase" => "attention", "terminal" => true }.freeze,
      "failed" => { "phase" => "terminal", "terminal" => true }.freeze,
    }.freeze
    SWAP_PROVIDER_STATES = SWAP_STATES.keys.freeze

    SWAP_ATTENTION_REASONS = [
      "provider_reported_emergency",
      "provider_status_unrecognized",
      "provider_completed_without_wallet_settlement",
    ].freeze
    SWAP_REFUND_REASONS = [
      "underpaid",
      "overpaid",
      "late_deposit",
      "underpaid_and_late",
      "overpaid_and_late",
    ].freeze
    SWAP_AVAILABILITY_REASONS = [
      "provider_unconfigured",
      "amount_too_small",
      "amount_too_large",
      "pair_temporarily_unavailable",
      "region_unsupported",
      "provider_rate_limited",
      "provider_unreachable",
    ].freeze
  end
end
