import type {
  NwcTransaction,
  OpenReceiveBtcFiatRateMapWithSource,
  OpenReceiveFiatAmount,
  OpenReceiveRateQuote,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
  PaidPayment,
  PaymentCheck,
  SimplePriceFetch,
} from "@openreceive/core";
import type { SwapPayInAsset, SwapOrder, SwapProvider, SwapProviderState } from "../swap/index.ts";

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface Event {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type EventHandler = (event: Event) => void;
export type Logger = (entry: Event) => void;

export interface LoggingOptions {
  readonly enabled?: boolean;
  readonly directory?: string;
  readonly filename?: string;
  readonly maxFileSizeMb?: number;
  readonly maxFiles?: number;
  readonly level?: OpenReceiveLogLevel;
}

export interface NodeOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies?: readonly string[];
  readonly swap?: SwapOptions;
  readonly onEvent?: EventHandler;
  readonly logger?: Logger;
  readonly logging?: LoggingOptions;
  readonly clock?: () => number;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CreateOpenReceiveOptions extends Omit<NodeOptions, "client"> {
  readonly client?: OpenReceiveReceiveNwcClient;
  /** Explicit override. Normal applications read the receive-only URI from NWC_URI. */
  readonly nwc?: string;
  /** Environment source for NWC_URI, LSC_URI_PRIMARY, and LSC_URI_BACKUP. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly priceFetch?: SimplePriceFetch;
}

export type CreateCheckoutAmount =
  | { readonly sats: number | string; readonly currency?: never; readonly value?: never }
  | { readonly currency: string; readonly value: string; readonly sats?: never };

export interface CreateCheckoutRequest {
  readonly orderId: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
  /** Used for a longer-lived shadow invoice when creating a swap. */
  readonly expirySeconds?: number;
}

export interface Checkout {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly bolt11: string;
  readonly amountMsats: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly fiatQuote: OpenReceiveRateQuote | null;
}

export interface CheckPaymentRequest {
  readonly paymentHash: string;
  readonly createdAt: number;
  readonly until?: number;
  readonly overlapSeconds?: number;
}

export interface ReconcilePaymentsRequest {
  readonly attempts: readonly {
    readonly paymentHash: string;
    readonly createdAt: number;
  }[];
  readonly until?: number;
  readonly overlapSeconds?: number;
}

export type NodeSettlementActionInput = PaidPayment;
export type NodeSettlementActionHook = (input: NodeSettlementActionInput) => Promise<void> | void;

export interface SwapOptions {
  readonly providers?: readonly SwapProvider[];
}

export interface SwapQuoteRequest {
  readonly amount: CreateCheckoutAmount;
  readonly payInAsset: SwapPayInAsset | string;
}

export interface CreateSwapRequest extends CreateCheckoutRequest {
  readonly payInAsset: SwapPayInAsset | string;
}

export interface GetSwapRequest {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly swapData: SwapData;
}

export interface SwapRefundRequest extends GetSwapRequest {
  readonly refundAddress: string;
}

/** Server-only provider recovery state persisted by the host application. */
export interface SwapData {
  readonly version: 1;
  readonly providerOrder: SwapOrder;
}

export interface PublicSwap {
  readonly paymentHash: string;
  readonly orderId: string;
  readonly provider: string;
  readonly payInAsset: SwapPayInAsset;
  readonly depositAddress: string;
  readonly depositMemo?: string;
  readonly depositAmount: string;
  readonly providerState: SwapProviderState;
  readonly providerExpiresAt: number;
  readonly depositTxId?: string;
  readonly payoutTxId?: string;
  readonly refundTxId?: string;
  readonly refundReason?: string;
  readonly refundAmount?: string;
  readonly attention?: boolean;
}

export interface SwapCheckout extends PublicSwap {
  readonly checkout: Checkout;
  /** Sensitive host-only state. Never serialize this into a browser response. */
  readonly swapData: SwapData;
}

export interface ListRatesRequest {
  readonly currencies?: readonly string[];
}

export interface OpenReceive {
  readonly priceCurrencies: readonly string[];
  createCheckout(input: CreateCheckoutRequest): Promise<Checkout>;
  checkPayment(input: CheckPaymentRequest): Promise<PaymentCheck>;
  reconcilePayments(input: ReconcilePaymentsRequest): Promise<readonly PaymentCheck[]>;
  quoteSwap(input: SwapQuoteRequest): Promise<unknown>;
  createSwap(input: CreateSwapRequest): Promise<SwapCheckout>;
  getSwap(input: GetSwapRequest): Promise<PublicSwap>;
  refundSwap(input: SwapRefundRequest): Promise<PublicSwap>;
  listRates(input?: ListRatesRequest): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: OpenReceiveFiatAmount }): Promise<OpenReceiveRateQuote>;
  close(): Promise<void>;
}

export interface OpenReceiveServiceContext {
  readonly options: NodeOptions;
  readonly clock: () => number;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  readonly swapProviders: readonly SwapProvider[];
}

export interface ResolvedCreateAmount {
  readonly amount_msats: number;
  readonly amount_source: "amount" | "fiat";
  readonly fiat_quote: OpenReceiveRateQuote | null;
}

export interface NormalizedCreateCheckoutRequest {
  readonly order_id: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly description_hash?: string;
  readonly metadata?: Record<string, unknown>;
  readonly expiry_seconds?: number;
}

export type { NwcTransaction };
