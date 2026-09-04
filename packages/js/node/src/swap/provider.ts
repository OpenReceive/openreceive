import type {
  GeneratedSwapAttentionReason,
  GeneratedSwapAvailabilityReason,
  GeneratedSwapProviderState,
  GeneratedSwapRefundReason,
} from "../generated/swap-tables.ts";
import type { SwapPayInAsset } from "./assets.ts";
import type { TransientSwapCache } from "./limits-cache.ts";

// The state and reason vocabularies are kernel tables (spec/data/kernel-tables.json)
// generated into every engine; the names below are this package's spelling of them.
export type SwapProviderState = GeneratedSwapProviderState;

export type SwapAvailabilityReason = GeneratedSwapAvailabilityReason;

/**
 * Why a swap attempt entered the `attention` state and needs human/support review.
 * Every code path that sets `attention: true` records one of these so a dashboard or
 * runbook can branch on the cause instead of a bare boolean. The FixedFloat status
 * mapping that produces them is pinned by spec/test-vectors/swap-state.json;
 * `provider_completed_without_wallet_settlement` is reserved and not emitted yet.
 */
export type SwapAttentionReason = GeneratedSwapAttentionReason;

/**
 * Why a swap attempt entered the refund path (`refund_required` → `refunded`).
 * Mapped from FixedFloat `emergency.status` (LESS / MORE / EXPIRED). An overpay
 * refunds the WHOLE deposit like every other emergency: the payout is a
 * fixed-amount bolt11, so there is nothing to exchange the surplus into and
 * `choice=EXCHANGE` is not a path this client takes.
 */
export type SwapRefundReason = GeneratedSwapRefundReason;

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
 * decimal strings so hosts can round-trip them exactly when retaining an audit snapshot.
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
   * Why a refund is needed, when the attempt is on the refund path. Mapped from
   * FixedFloat `emergency.status` (LESS / MORE / EXPIRED).
   */
  readonly refund_reason?: SwapRefundReason;
  /**
   * Amount actually received on the deposit tx (`from.tx.amount`), when known.
   * Compared with `deposit_amount` to explain underpayment.
   */
  readonly deposit_received_amount?: string;
  /**
   * Provider-reported refund amount excluding the network fee (`back.amount`).
   */
  readonly refund_amount?: string;
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
   * Attach a disposable process-local cache for provider catalogs and quotes.
   */
  attachSwapCache?(cache: TransientSwapCache): void;
  /**
   * Attach a sink for outbound provider API requests, mirroring
   * {@link attachApiResponseLogger}. The
   * service routes entries through its sanitizing log sink, so secrets in the body
   * are redacted. Providers that make no remote calls may omit this.
   */
  attachApiRequestLogger?(log: (entry: SwapProviderApiRequestLog) => void): void;
  /**
   * Attach a sink for raw provider API responses. The service routes entries through
   * its sanitizing log sink, so nested secrets are redacted. Providers that make no
   * remote calls may omit this.
   */
  attachApiResponseLogger?(log: (entry: SwapProviderApiResponseLog) => void): void;
  /**
   * Attach a process-local request weight guard for this provider.
   * Providers that do not hit a weight-budgeted API may omit this.
   */
  attachWeightBudget?(budget: {
    reserve(path: string): Promise<void>;
    markRateLimited(): Promise<void>;
  }): void;
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
