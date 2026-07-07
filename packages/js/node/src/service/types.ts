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
  readonly attemptId?: string;
  readonly attempt_id?: string;
  readonly refundAddress: string;
  readonly refund_address?: string;
  readonly refundNonce?: string;
  readonly refund_nonce?: string;
  readonly confirm?: boolean;
}

export type OpenReceiveOrderRequest =
  | { order_id: string; action?: "status" }
  | { order_id: string; action: "quote"; pay_in_asset: string }
  | { order_id: string; action: "start"; pay_in_asset: string }
  | {
      order_id: string;
      action: "refund";
      attempt_id: string;
      refund_address: string;
      refund_nonce: string;
      confirm?: boolean;
    };

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
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
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
  readonly payment_methods?: readonly OpenReceiveSwapOption[];
}

export interface OpenReceive {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly namespace: string;
  readonly priceCurrencies: readonly string[];
  createCheckout(input: OpenReceiveCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrCreateCheckout(input: OpenReceiveGetOrCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrder(input: OpenReceiveGetOrderRequest): Promise<OpenReceiveOrder>;
  order(input: OpenReceiveOrderRequest): Promise<unknown>;
  getCheckout(input: OpenReceiveGetCheckoutRequest): Promise<OpenReceiveCheckout>;
  sweepPendingInvoices(): Promise<OpenReceivePendingSweepResult>;
  swapOptions(input: OpenReceiveSwapOptionsRequest): Promise<OpenReceiveSwapOptionsResponse>;
  swapQuote(input: OpenReceiveSwapQuoteRequest): Promise<OpenReceiveSwapQuoteResponse>;
  startSwap(input: OpenReceiveSwapStartRequest): Promise<OpenReceiveInvoice>;
  refundSwap(input: OpenReceiveSwapRefundRequest): Promise<OpenReceiveInvoice>;
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

export interface CachedSwapQuote {
  readonly checkoutId: string;
  readonly amountMsats: number;
  readonly payInAsset: OpenReceiveSwapPayInAsset;
  readonly quote: OpenReceiveSwapQuoteResponse;
  readonly expiresAt: number;
}

export interface OpenReceiveServiceContext {
  readonly options: OpenReceiveNodeOptions;
  readonly store: OpenReceiveInvoiceKvStore;
  readonly clock: () => number;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  readonly swapProviders: readonly OpenReceiveSwapProvider[];
  readonly swapQuoteCache: Map<string, CachedSwapQuote>;
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
