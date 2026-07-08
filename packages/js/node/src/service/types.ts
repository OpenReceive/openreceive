import type {
  InvoiceStorageRow,
  NwcTransaction,
  OpenReceiveBitcoinAmount,
  OpenReceiveBtcFiatRateMapWithSource,
  OpenReceiveFiatAmount,
  OpenReceiveInvoiceKvStore,
  OpenReceivePendingSweepResult,
  OpenReceiveRateQuote,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
  SimplePriceFetch,
} from "@openreceive/core";
import type { ResolveOpenReceiveStoreOptions } from "../store-uri.ts";
import type {
  OpenReceiveSwapAttentionReason,
  OpenReceiveSwapAvailabilityReason,
  OpenReceiveSwapPayInAsset,
  OpenReceiveSwapProvider,
  OpenReceiveSwapProviderState,
} from "../swap/index.ts";

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenReceiveEvent {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type OpenReceiveEventHandler = (event: OpenReceiveEvent) => void;

export interface OpenReceiveLogEntry extends OpenReceiveEvent {}

export type OpenReceiveLogger = (entry: OpenReceiveLogEntry) => void;

export interface OpenReceiveNodeSettlementActionInput {
  invoice: InvoiceStorageRow;
  orderId: string;
  checkoutId: string;
  invoiceId: string;
  paymentHash: string;
  amountMsats: number;
  metadata: Record<string, unknown>;
  source: "status";
  transaction?: NwcTransaction;
}

export type OpenReceiveNodeSettlementActionHook = (
  input: OpenReceiveNodeSettlementActionInput,
) => Promise<void> | void;

export interface OpenReceiveNodeOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: OpenReceiveInvoiceKvStore;
  namespace?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies?: readonly string[];
  swap?: OpenReceiveSwapOptions;
  onEvent?: OpenReceiveEventHandler;
  logger?: OpenReceiveLogger;
  clock?: () => number;
  actionLeaseTtlSeconds?: number;
  transactionScanIntervalSeconds?: number;
  transactionScanPageLimit?: number;
  transactionScanWindowPaddingSeconds?: number;
  transactionScanOverlapSeconds?: number;
  sweepOpenInvoiceCap?: number;
  transactionScanTimeoutMs?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CreateOpenReceiveOptions
  extends Omit<OpenReceiveNodeOptions, "client" | "onPaid" | "store"> {
  client?: OpenReceiveReceiveNwcClient;
  nwc?: string;
  store?: OpenReceiveInvoiceKvStore;
  storeUri?: string;
  namespace?: string;
  configPath?: string | false;
  cwd?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  loadSqlite?: ResolveOpenReceiveStoreOptions["loadSqlite"];
  loadPostgres?: ResolveOpenReceiveStoreOptions["loadPostgres"];
  priceFetch?: SimplePriceFetch;
}

export type OpenReceiveCreateCheckoutRequest = OpenReceiveCreateCheckoutBase &
  (
    | {
        readonly amount: OpenReceiveCreateCheckoutAmount;
        readonly sats?: never;
        readonly usd?: never;
      }
    | {
        readonly amount?: never;
        readonly sats: number | string;
        readonly usd?: never;
      }
    | {
        readonly amount?: never;
        readonly sats?: never;
        readonly usd: string;
      }
  );

export interface OpenReceiveCreateCheckoutBase {
  readonly orderId: string;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
}

export type OpenReceiveGetOrCreateCheckoutRequest = OpenReceiveCreateCheckoutRequest;

export type OpenReceiveCreateCheckoutAmount =
  | { readonly btc: OpenReceiveBitcoinAmount }
  | { readonly fiat: OpenReceiveFiatAmount };

export interface OpenReceiveGetOrderRequest {
  readonly orderId: string;
}

export interface OpenReceiveGetCheckoutRequest {
  readonly checkoutId: string;
}

export interface OpenReceiveSwapOptions {
  readonly providers?: readonly OpenReceiveSwapProvider[];
  readonly settlementAttentionSeconds?: number;
}

export interface OpenReceiveSwapOptionsRequest {
  readonly orderId: string;
}

export interface OpenReceiveSwapQuoteRequest {
  readonly orderId: string;
  readonly payInAsset: OpenReceiveSwapPayInAsset | string;
}

export interface OpenReceiveSwapStartRequest {
  readonly orderId: string;
  readonly payInAsset: OpenReceiveSwapPayInAsset | string;
}

export interface OpenReceiveSwapRefundRequest {
  readonly attemptId: string;
  readonly refundAddress: string;
  readonly refundNonce: string;
  readonly confirm?: boolean;
}

/**
 * The wire body for {@link OpenReceive.order}: a payer-facing router keyed on `action`.
 * Fields are snake_case because this is the HTTP body your route forwards verbatim.
 * (The lower-level `swapQuote`/`startSwap`/`refundSwap` methods take camelCase SDK inputs.)
 * An unrecognized `action` is rejected with a 400, never silently treated as `status`.
 */
export type OpenReceiveOrderRequest =
  | { order_id: string; action?: "status" }
  | { order_id: string; action: "swap_quote"; pay_in_asset: string }
  | { order_id: string; action: "start_swap"; pay_in_asset: string }
  | {
      order_id: string;
      action: "refund_swap";
      attempt_id: string;
      refund_address: string;
      refund_nonce: string;
      confirm?: boolean;
    };

/**
 * The result of {@link OpenReceive.order}, mapped from the request's `action` so the
 * recommended entrypoint is fully typed instead of `unknown`. The default `status`
 * action returns an {@link OpenReceiveOrderStatus}; swap actions return a wrapped
 * quote or attempt.
 */
export type OpenReceiveOrderResult<A extends OpenReceiveOrderRequest = OpenReceiveOrderRequest> =
  A extends { action: "swap_quote" }
    ? { readonly quote: OpenReceiveSwapQuoteResponse }
    : A extends { action: "start_swap" }
      ? { readonly attempt: OpenReceiveSwapAttempt }
      : A extends { action: "refund_swap" }
        ? { readonly attempt: OpenReceiveSwapAttempt }
        : OpenReceiveOrderStatus;

export interface OpenReceiveSwapOption {
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly label: string;
  readonly network_label: string;
  readonly provider: string;
  readonly available: boolean;
  readonly unavailable_reason?: OpenReceiveSwapAvailabilityReason;
  readonly unavailable_message?: string;
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  /** Invoice-side (Lightning receive) limits in msats, for rendering a fiat figure. */
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

export interface OpenReceiveSwapOptionsResponse {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOption[];
}

export type OpenReceiveSwapQuoteResponse = OpenReceiveSwapOption;

export interface OpenReceivePublicSwap {
  readonly attempt_id: string;
  readonly provider: string;
  readonly provider_order_id?: string;
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly provider_state: OpenReceiveSwapProviderState;
  readonly provider_expires_at: number;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_address?: string;
  readonly refund_nonce?: string;
  /**
   * Unix seconds when `refund_nonce` expires. Present whenever `refund_nonce` is.
   * Show a countdown and re-fetch status before it lapses; a confirm submitted after
   * this time is rejected and the staged address is lost.
   */
  readonly refund_nonce_expires_at?: number;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  /** Why this attempt needs review, when `attention` is true. See automated-swaps.md. */
  readonly attention_reason?: OpenReceiveSwapAttentionReason;
}

export interface OpenReceiveInvoice {
  readonly invoice_id: string;
  readonly type: "incoming";
  readonly rail: "lightning" | "swap";
  readonly status: "pending" | "settled" | "expired" | "failed";
  readonly transaction_state: string;
  readonly workflow_state: string;
  readonly invoice: string | null;
  readonly payment_hash: string;
  readonly amount_msats: number;
  readonly order_id: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly settled_at?: number;
  readonly settlement_action_completed_at?: number;
  readonly refreshed_from_invoice_id?: string;
  readonly fiat_quote: OpenReceiveRateQuote | null;
  readonly settlement_action_state: string;
  readonly swap?: OpenReceivePublicSwap;
}

/**
 * The result of starting or refunding an automated swap. The fields the payer needs —
 * deposit address, exact amount, asset, provider state, refund nonce — are top-level and
 * guaranteed present, instead of buried under an optional `.swap` on an invoice-shaped
 * type. The backing shadow Lightning invoice is available as `shadow_invoice`.
 */
export interface OpenReceiveSwapAttempt extends OpenReceivePublicSwap {
  readonly order_id: string;
  readonly shadow_invoice: OpenReceiveInvoice;
}

export interface OpenReceiveCheckout {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly status: "open" | "superseded" | "paid" | "expired";
  readonly amount_msats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: OpenReceiveInvoice;
  readonly invoices: readonly OpenReceiveInvoice[];
  readonly paid_at?: number;
  readonly created_at: number;
}

export interface OpenReceiveOrder {
  readonly order_id: string;
  readonly status: "pending" | "paid" | "expired";
  readonly paid: boolean;
  readonly paid_at?: number;
  readonly display_checkout?: OpenReceiveCheckout;
  readonly paid_checkout?: OpenReceiveCheckout;
  readonly active_checkout?: OpenReceiveCheckout;
  readonly checkouts: readonly OpenReceiveCheckout[];
  readonly wallet_scan_performed: boolean;
  readonly transactions_checked: number;
}

/**
 * An order plus its available automated-swap pay-in options. Returned by the default
 * (`status`) action of {@link OpenReceive.order}. `swap_pay_options` holds only the
 * crypto swap methods — Lightning is always available on the order's checkout invoice
 * and is not listed here. When swaps are not configured, `swaps_enabled` is false and
 * `swap_pay_options` is empty.
 */
export interface OpenReceiveOrderStatus extends OpenReceiveOrder {
  readonly swaps_enabled: boolean;
  readonly swap_pay_options: readonly OpenReceiveSwapOption[];
}

export interface OpenReceive {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly namespace: string;
  readonly priceCurrencies: readonly string[];
  createCheckout(input: OpenReceiveCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrCreateCheckout(input: OpenReceiveGetOrCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrder(input: OpenReceiveGetOrderRequest): Promise<OpenReceiveOrder>;
  order<A extends OpenReceiveOrderRequest>(input: A): Promise<OpenReceiveOrderResult<A>>;
  getCheckout(input: OpenReceiveGetCheckoutRequest): Promise<OpenReceiveCheckout>;
  sweepPendingInvoices(): Promise<OpenReceivePendingSweepResult>;
  swapOptions(input: OpenReceiveSwapOptionsRequest): Promise<OpenReceiveSwapOptionsResponse>;
  swapQuote(input: OpenReceiveSwapQuoteRequest): Promise<OpenReceiveSwapQuoteResponse>;
  startSwap(input: OpenReceiveSwapStartRequest): Promise<OpenReceiveSwapAttempt>;
  refundSwap(input: OpenReceiveSwapRefundRequest): Promise<OpenReceiveSwapAttempt>;
  listRates(
    input?: OpenReceiveListRatesRequest,
  ): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: OpenReceiveFiatAmount }): Promise<OpenReceiveRateQuote>;
  close(): Promise<void>;
}

export interface OpenReceiveListRatesRequest {
  readonly currencies?: readonly string[];
}

export interface OpenReceiveInvoiceModel {
  readonly invoiceId: string;
  readonly type: "incoming";
  readonly status: OpenReceiveInvoice["status"];
  readonly transactionState: string;
  readonly workflowState: string;
  readonly bolt11: string;
  readonly paymentHash: string;
  readonly amountMsats: number;
  readonly orderId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly settledAt?: number;
  readonly settlementActionCompletedAt?: number;
  readonly refreshedFromInvoiceId?: string;
  readonly fiatQuote: OpenReceiveRateQuote | null;
  readonly settlementActionState: string;
  readonly rail: "lightning" | "swap";
  readonly swap?: OpenReceivePublicSwap;
}

export interface OpenReceiveCheckoutModel {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly status: OpenReceiveCheckout["status"];
  readonly amountMsats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: OpenReceiveInvoiceModel;
  readonly invoices: readonly OpenReceiveInvoiceModel[];
  readonly paidAt?: number;
  readonly createdAt: number;
}

export interface OpenReceiveOrderModel {
  readonly orderId: string;
  readonly status: OpenReceiveOrder["status"];
  readonly paid: boolean;
  readonly paidAt?: number;
  readonly displayCheckout?: OpenReceiveCheckoutModel;
  readonly paidCheckout?: OpenReceiveCheckoutModel;
  readonly activeCheckout?: OpenReceiveCheckoutModel;
  readonly checkouts: readonly OpenReceiveCheckoutModel[];
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

export interface OrderScanMeta {
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

export interface OpenReceiveServiceContext {
  readonly options: OpenReceiveNodeOptions;
  readonly store: OpenReceiveInvoiceKvStore;
  readonly clock: () => number;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  readonly swapProviders: readonly OpenReceiveSwapProvider[];
}

export interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

export interface NormalizedCreateCheckoutRequest {
  readonly order_id: string;
  readonly amount: OpenReceiveCreateCheckoutAmount;
  readonly memo?: string;
  readonly description_hash?: string;
  readonly metadata?: Record<string, unknown>;
}
