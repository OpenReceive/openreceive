import type { SwapPayInAsset } from "./assets.ts";
import type { StoreBackedSwapCache } from "./limits-cache.ts";

export type SwapProviderState =
  | "creating_provider_order"
  | "awaiting_deposit"
  | "confirming"
  | "exchanging"
  | "paying_invoice"
  | "completed"
  | "expired"
  | "refund_required"
  | "refund_pending"
  | "refunded"
  | "attention"
  | "failed";

export type SwapAvailabilityReason =
  | "provider_unconfigured"
  | "amount_too_small"
  | "amount_too_large"
  | "pair_temporarily_unavailable"
  | "region_unsupported"
  | "provider_rate_limited"
  | "provider_unreachable";

/**
 * Why a swap attempt entered the `attention` state and needs human/support review.
 * Every code path that sets `attention: true` records one of these so a dashboard or
 * runbook can branch on the cause instead of a bare boolean. See the "Attention"
 * section of docs/guides/automated-swaps.md for the per-reason operator runbook.
 */
export type SwapAttentionReason =
  | "provider_completed_without_wallet_settlement"
  | "provider_order_creation_stale"
  | "provider_order_creation_failed"
  | "provider_order_creation_needs_reconcile"
  | "provider_reported_emergency"
  | "provider_order_expires_after_shadow_invoice";

export interface SwapQuote {
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  /** Invoice-side (Lightning receive) limits in msats, when the provider reports them. */
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
  readonly pay_asset: SwapPayInAsset;
  readonly available: boolean;
  readonly unavailable_reason?: SwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly provider: string;
}

export interface SwapProviderAsset {
  readonly pay_asset: SwapPayInAsset;
  readonly available?: boolean;
  readonly unavailable_reason?: SwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

/**
 * Fiat equivalents that explain why the payer sends more crypto than the cart total.
 * Sourced from the provider's own quote (e.g. FixedFloat `from.usd` / `to.usd`). The
 * swap fee the payer absorbs is `pay_in_fiat` − `payout_fiat` (exchange spread plus
 * network fees, which the provider bakes into the deposit amount). All values are
 * decimal strings so they round-trip through storage unchanged.
 */
export interface SwapFee {
  /** Fiat currency the equivalents are expressed in, e.g. "USD". */
  readonly currency: string;
  /** Fiat value of the crypto the payer must send (provider `from.usd`). */
  readonly pay_in_fiat: string;
  /** Fiat value delivered to the merchant — the cart total (provider `to.usd`). */
  readonly payout_fiat: string;
}

export interface SwapOrder {
  readonly provider: string;
  readonly provider_order_id: string;
  readonly provider_token: string;
  readonly pay_in_asset: SwapPayInAsset;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly expires_at: number;
  readonly state: SwapProviderState;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  readonly attention_reason?: SwapAttentionReason;
  /**
   * FixedFloat `emergency.repeat`: a second deposit hit the same provider order.
   * Extra funds may sit at the provider while the attempt looks like a normal
   * refund/attention path — surface this so operators can reconcile.
   */
  readonly emergency_repeat?: boolean;
  readonly fee?: SwapFee;
  readonly raw?: unknown;
}

/**
 * A single raw provider API response, surfaced for server-side observability.
 * Carries the HTTP status and the parsed `{code, msg, data}` envelope. Emitted
 * through the service's sanitizing log sink, so any nested secret (e.g. a
 * FixedFloat order token) is redacted before it reaches a log line.
 */
export interface SwapProviderApiResponseLog {
  readonly provider: string;
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  readonly code: unknown;
  readonly msg: unknown;
  readonly data: unknown;
}

/**
 * A single outbound provider API request, surfaced for server-side observability
 * alongside {@link SwapProviderApiResponseLog}. Carries the request path and body.
 * Emitted through the service's sanitizing log sink, so any secret in the body
 * (e.g. a FixedFloat order token on status/refund calls) is redacted; provider
 * auth headers are never included here.
 */
export interface SwapProviderApiRequestLog {
  readonly provider: string;
  readonly path: string;
  readonly body: unknown;
}

export interface SwapProvider {
  readonly name: string;
  /**
   * Attach the durable store-backed cache used for slow-changing provider data
   * (currency catalog, global rates snapshot). Called once after the service store
   * is resolved, since providers are constructed before the store exists. Providers
   * that don't cache remote data may omit this.
   */
  attachSwapCache?(cache: StoreBackedSwapCache): void;
  /**
   * Attach a sink for outbound provider API requests, mirroring
   * {@link attachApiResponseLogger}. Called once after the store is resolved. The
   * service routes entries through its sanitizing log sink, so secrets in the body
   * are redacted. Providers that make no remote calls may omit this.
   */
  attachApiRequestLogger?(log: (entry: SwapProviderApiRequestLog) => void): void;
  /**
   * Attach a sink for raw provider API responses. Called once after the store is
   * resolved, alongside {@link attachSwapCache}. The service routes entries through
   * its sanitizing log sink, so nested secrets are redacted. Providers that make no
   * remote calls may omit this.
   */
  attachApiResponseLogger?(log: (entry: SwapProviderApiResponseLog) => void): void;
  /**
   * Attach a durable shared weight ledger for this provider. Called once after
   * the service store is resolved (same lifecycle as {@link attachSwapCache}).
   * Providers that do not hit a weight-budgeted API may omit this.
   */
  attachWeightBudget?(budget: {
    reserve(path: string): Promise<void>;
    markRateLimited(): Promise<void>;
    canReserve(path: string): Promise<boolean>;
  }): void;
  /**
   * Whether this provider can accept an outbound API call of the given path
   * without exceeding its shared weight budget. Used by provider selection to
   * fail over to the next configured provider when the preferred one is limited.
   * When omitted, the provider is treated as always available.
   */
  canAcceptRequest?(path: string): Promise<boolean>;
  supportedPayInAssets(): Promise<Set<SwapPayInAsset>>;
  payInAssetCatalog?(): Promise<readonly SwapProviderAsset[]>;
  invoiceExpirySeconds?(input: { readonly payInAsset: SwapPayInAsset }): number;
  quote(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapQuote>;
  createSwap(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapOrder>;
  getStatus(order: SwapOrder): Promise<SwapOrder>;
  requestRefund(order: SwapOrder, refundAddress: string): Promise<void>;
}

export function isOpenReceiveSwapTerminalState(state: string | undefined): boolean {
  return state === "expired" || state === "refunded" || state === "attention" || state === "failed";
}
