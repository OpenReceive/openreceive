import type { OpenReceiveSwapPayInAsset } from "./assets.ts";
import type { StoreBackedSwapCache } from "./limits-cache.ts";

export type OpenReceiveSwapProviderState =
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

export type OpenReceiveSwapAvailabilityReason =
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
export type OpenReceiveSwapAttentionReason =
  | "provider_completed_without_wallet_settlement"
  | "provider_order_creation_stale"
  | "provider_order_creation_failed"
  | "provider_reported_emergency";

export interface OpenReceiveSwapQuote {
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  /** Invoice-side (Lightning receive) limits in msats, when the provider reports them. */
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
  readonly pay_asset: OpenReceiveSwapPayInAsset;
  readonly available: boolean;
  readonly unavailable_reason?: OpenReceiveSwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly provider: string;
}

export interface OpenReceiveSwapProviderAsset {
  readonly pay_asset: OpenReceiveSwapPayInAsset;
  readonly available?: boolean;
  readonly unavailable_reason?: OpenReceiveSwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

export interface OpenReceiveSwapOrder {
  readonly provider: string;
  readonly provider_order_id: string;
  readonly provider_token: string;
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly expires_at: number;
  readonly state: OpenReceiveSwapProviderState;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  readonly attention_reason?: OpenReceiveSwapAttentionReason;
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

export interface OpenReceiveSwapProvider {
  readonly name: string;
  /**
   * Attach the durable store-backed cache used for slow-changing provider data
   * (currency catalog, min/max limits). Called once after the service store is
   * resolved, since providers are constructed before the store exists. Providers
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
  supportedPayInAssets(): Promise<Set<OpenReceiveSwapPayInAsset>>;
  payInAssetCatalog?(): Promise<readonly OpenReceiveSwapProviderAsset[]>;
  invoiceExpirySeconds?(input: { readonly payInAsset: OpenReceiveSwapPayInAsset }): number;
  quote(input: {
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapQuote>;
  createSwap(input: {
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapOrder>;
  getStatus(order: OpenReceiveSwapOrder): Promise<OpenReceiveSwapOrder>;
  requestRefund(order: OpenReceiveSwapOrder, refundAddress: string): Promise<void>;
}

export function isOpenReceiveSwapTerminalState(state: string | undefined): boolean {
  return state === "expired" || state === "refunded" || state === "attention" || state === "failed";
}
