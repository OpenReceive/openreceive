import type {
  InvoiceStorageRow,
  NwcTransaction,
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
  SwapAttentionReason,
  SwapAvailabilityReason,
  SwapFee,
  SwapPayInAsset,
  SwapProvider,
  SwapProviderState,
} from "../swap/index.ts";

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface Event {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type EventHandler = (event: Event) => void;

export interface LogEntry extends Event {}

export type Logger = (entry: LogEntry) => void;

export interface LoggingOptions {
  /** Set false to disable writing log files. Defaults to true. */
  readonly enabled?: boolean;
  /** Directory the log files are written to. Defaults to "./logs". */
  readonly directory?: string;
  /** Active log file name. Rotated backups append ".1", ".2", ... Defaults to "openreceive.log". */
  readonly filename?: string;
  /** Rotate once the active file would exceed this size in megabytes. Defaults to 10. */
  readonly maxFileSizeMb?: number;
  /** Number of log files to keep (active file plus rotated backups). Defaults to 5. */
  readonly maxFiles?: number;
  /** Minimum level written to file. Defaults to "debug" (writes every emitted event). */
  readonly level?: OpenReceiveLogLevel;
}

export interface NodeSettlementActionInput {
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

export type NodeSettlementActionHook = (
  input: NodeSettlementActionInput,
) => Promise<void> | void;

export interface NodeOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: OpenReceiveInvoiceKvStore;
  namespace?: string;
  onPaid?: NodeSettlementActionHook;
  priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies?: readonly string[];
  swap?: SwapOptions;
  onEvent?: EventHandler;
  logger?: Logger;
  logging?: LoggingOptions;
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
  extends Omit<NodeOptions, "client" | "onPaid" | "store"> {
  client?: OpenReceiveReceiveNwcClient;
  nwc?: string;
  store?: OpenReceiveInvoiceKvStore;
  storeUri?: string;
  namespace?: string;
  configPath?: string | false;
  cwd?: string;
  onPaid?: NodeSettlementActionHook;
  loadSqlite?: ResolveOpenReceiveStoreOptions["loadSqlite"];
  loadPostgres?: ResolveOpenReceiveStoreOptions["loadPostgres"];
  priceFetch?: SimplePriceFetch;
}

export interface CreateCheckoutRequest {
  readonly orderId: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
}

export type GetOrCreateCheckoutRequest = CreateCheckoutRequest;

/**
 * Trusted create-checkout amount. Exactly one shape:
 * - `{ sats }` — integer sats (number or decimal-free string)
 * - `{ currency, value }` — fiat ISO code, or `BTC` / `SAT` / `SATS`
 */
export type CreateCheckoutAmount =
  | { readonly sats: number | string; readonly currency?: never; readonly value?: never }
  | {
      readonly currency: string;
      readonly value: string;
      readonly sats?: never;
    };

export interface GetOrderRequest {
  readonly orderId: string;
}

export interface GetCheckoutRequest {
  readonly checkoutId: string;
}

export interface SwapOptions {
  readonly providers?: readonly SwapProvider[];
  readonly settlementAttentionSeconds?: number;
}

export interface SwapOptionsRequest {
  readonly orderId: string;
}

export interface SwapQuoteRequest {
  readonly orderId: string;
  readonly payInAsset: SwapPayInAsset | string;
}

export interface SwapStartRequest {
  readonly orderId: string;
  readonly payInAsset: SwapPayInAsset | string;
}

export interface SwapRefundRequest {
  readonly attemptId: string;
  readonly refundAddress: string;
  readonly refundNonce: string;
  readonly confirm?: boolean;
}

/**
 * Operator-driven provider status refresh for a single swap attempt. Used when
 * automatic polling has stopped (e.g. `attention` with `provider_reported_emergency`)
 * so a FixedFloat dashboard action can be reflected without unbounded auto-polls.
 */
export interface SwapRefreshRequest {
  readonly attemptId: string;
}

export interface SwapOption {
  readonly payInAsset: SwapPayInAsset;
  readonly label: string;
  readonly networkLabel: string;
  readonly provider: string;
  readonly available: boolean;
  readonly unavailableReason?: SwapAvailabilityReason;
  readonly unavailableMessage?: string;
  readonly payAmount?: string;
  readonly minimumPayAmount?: string;
  readonly maximumPayAmount?: string;
  /** Invoice-side (Lightning receive) limits in msats, for rendering a fiat figure. */
  readonly minimumInvoiceAmountMsats?: number;
  readonly maximumInvoiceAmountMsats?: number;
}

export interface SwapOptionsResponse {
  readonly enabled: boolean;
  readonly options: readonly SwapOption[];
}

export type SwapQuoteResponse = SwapOption;

export interface PublicSwap {
  readonly attemptId: string;
  readonly provider: string;
  readonly providerOrderId?: string;
  readonly payInAsset: SwapPayInAsset;
  readonly depositAddress: string;
  readonly depositMemo?: string;
  readonly depositAmount: string;
  readonly providerState: SwapProviderState;
  readonly providerExpiresAt: number;
  readonly depositTxId?: string;
  readonly payoutTxId?: string;
  readonly refundAddress?: string;
  readonly refundNonce?: string;
  /**
   * Unix seconds when `refundNonce` expires. Present whenever `refundNonce` is.
   * Show a countdown and re-fetch status before it lapses; a confirm submitted after
   * this time is rejected. The staged refund address is retained across nonce rotation.
   */
  readonly refundNonceExpiresAt?: number;
  readonly refundTxId?: string;
  readonly attention?: boolean;
  /** Why this attempt needs review, when `attention` is true. See automated-swaps.md. */
  readonly attentionReason?: SwapAttentionReason;
  /**
   * Provider reported a repeated deposit on the same order (`emergency.repeat`).
   * Extra funds may sit at the provider — reconcile manually.
   */
  readonly emergencyRepeat?: boolean;
  /** Fiat equivalents that explain the swap fee the payer absorbs, when the provider reports them. */
  readonly fee?: SwapFee;
}

export interface Invoice {
  readonly invoiceId: string;
  readonly type: "incoming";
  readonly status: "pending" | "settled" | "expired" | "failed";
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
  readonly swap?: PublicSwap;
}

/**
 * The result of starting or refunding an automated swap. The fields the payer needs —
 * deposit address, exact amount, asset, provider state, refund nonce — are top-level and
 * guaranteed present, instead of buried under an optional `.swap` on an invoice-shaped
 * type. The backing shadow Lightning invoice is available as `shadowInvoice`.
 */
export interface SwapAttempt extends PublicSwap {
  readonly orderId: string;
  readonly shadowInvoice: Invoice;
}

export interface Checkout {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly status: "open" | "superseded" | "paid" | "expired";
  readonly amountMsats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: Invoice;
  readonly invoices: readonly Invoice[];
  readonly paidAt?: number;
  readonly createdAt: number;
}

export interface Order {
  readonly orderId: string;
  readonly status: "pending" | "paid" | "expired";
  readonly paid: boolean;
  readonly paidAt?: number;
  readonly displayCheckout?: Checkout;
  readonly paidCheckout?: Checkout;
  readonly activeCheckout?: Checkout;
  readonly checkouts: readonly Checkout[];
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

/**
 * An order plus its available automated-swap pay-in options. Built by the HTTP
 * order-status route (and available for hosts that compose the same shape).
 * `swapPayOptions` holds only crypto swap methods — Lightning is always available
 * on the order's checkout invoice and is not listed here. When swaps are not
 * configured, `swapsEnabled` is false and `swapPayOptions` is empty.
 */
export interface OrderStatus extends Order {
  readonly swapsEnabled: boolean;
  readonly swapPayOptions: readonly SwapOption[];
}

export interface OpenReceive {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly namespace: string;
  readonly priceCurrencies: readonly string[];
  getOrCreateCheckout(input: GetOrCreateCheckoutRequest): Promise<Checkout>;
  getOrder(input: GetOrderRequest): Promise<Order>;
  getCheckout(input: GetCheckoutRequest): Promise<Checkout>;
  sweepPendingInvoices(): Promise<OpenReceivePendingSweepResult>;
  swapOptions(input: SwapOptionsRequest): Promise<SwapOptionsResponse>;
  swapQuote(input: SwapQuoteRequest): Promise<SwapQuoteResponse>;
  startSwap(input: SwapStartRequest): Promise<SwapAttempt>;
  refundSwap(input: SwapRefundRequest): Promise<SwapAttempt>;
  refreshSwap(input: SwapRefreshRequest): Promise<SwapAttempt>;
  listRates(
    input?: ListRatesRequest,
  ): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: OpenReceiveFiatAmount }): Promise<OpenReceiveRateQuote>;
  close(): Promise<void>;
}

export interface ListRatesRequest {
  readonly currencies?: readonly string[];
}

export interface OrderScanMeta {
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

export interface OpenReceiveServiceContext {
  readonly options: NodeOptions;
  readonly store: OpenReceiveInvoiceKvStore;
  readonly clock: () => number;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  readonly swapProviders: readonly SwapProvider[];
}

export interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

export interface NormalizedCreateCheckoutRequest {
  readonly order_id: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly description_hash?: string;
  readonly metadata?: Record<string, unknown>;
}
