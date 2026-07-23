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
import type {
  SwapPayInAsset,
  SwapProvider,
  SwapProviderState,
} from "../swap/index.ts";
import type { StatelessTokenManager } from "../tokens.ts";

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface Event {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type EventHandler = (event: Event) => void;
export type LogEntry = Event;
export type Logger = (entry: LogEntry) => void;

export interface LoggingOptions {
  readonly enabled?: boolean;
  readonly directory?: string;
  readonly filename?: string;
  readonly maxFileSizeMb?: number;
  readonly maxFiles?: number;
  readonly level?: OpenReceiveLogLevel;
}

export interface TokenKey {
  /** Stable, non-secret identifier included in sealed token headers. */
  readonly id: string;
  /** 32-byte master key encoded as base64url, base64, or 64 hexadecimal characters. */
  readonly key: string;
}

export interface NodeOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly onPaid?: NodeSettlementActionHook;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies?: readonly string[];
  readonly swap?: SwapOptions;
  readonly tokenKeys?: readonly TokenKey[];
  readonly onEvent?: EventHandler;
  readonly logger?: Logger;
  readonly logging?: LoggingOptions;
  readonly clock?: () => number;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CreateOpenReceiveOptions extends Omit<NodeOptions, "client"> {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly nwc?: string;
  readonly configPath?: string | false;
  readonly cwd?: string;
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
  /** Host-generated correlation only. OpenReceive never persists or deduplicates it. */
  readonly idempotencyKey?: string;
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
  readonly from?: number;
  readonly until?: number;
}

export interface RecoverCheckoutRequest {
  readonly orderId: string;
  readonly paymentHash: string;
  /** Known provider expiry when reconstructing a swap shadow invoice. */
  readonly expiresAt?: number;
}

export interface ReconcilePaymentsRequest {
  readonly paymentHashes: readonly string[];
  readonly from?: number;
  readonly until?: number;
}

export interface WatchPaymentsRequest {
  readonly onPaid?: NodeSettlementActionHook;
  readonly from?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface PaymentWatcher {
  stop(): void;
  readonly done: Promise<void>;
}

export type NodeSettlementActionInput = PaidPayment;
export type NodeSettlementActionHook = (
  input: NodeSettlementActionInput,
) => Promise<void> | void;

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
  readonly recoveryToken: string;
}

export interface CreateSwapRefundConfirmationRequest extends GetSwapRequest {
  readonly refundAddress: string;
  readonly ttlSeconds?: number;
}

export interface SwapRefundRequest extends GetSwapRequest {
  readonly refundAddress: string;
  readonly confirmationToken: string;
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
  readonly swapRecoveryToken: string;
}

export interface SwapStatus extends PublicSwap {
  readonly swapRecoveryToken: string;
}

export interface SwapRefundConfirmation {
  readonly confirmationToken: string;
  readonly expiresAt: number;
}

export interface ListRatesRequest {
  readonly currencies?: readonly string[];
}

export interface OpenReceive {
  readonly priceCurrencies: readonly string[];
  createCheckout(input: CreateCheckoutRequest): Promise<Checkout>;
  /** Reconstruct a still-live checkout from wallet data for host-row retry reuse. */
  recoverCheckout(input: RecoverCheckoutRequest): Promise<Checkout | null>;
  checkPayment(input: CheckPaymentRequest): Promise<PaymentCheck>;
  reconcilePayments(input: ReconcilePaymentsRequest): Promise<readonly PaymentCheck[]>;
  watchPayments(input: WatchPaymentsRequest): PaymentWatcher;
  mintCapabilityToken(input: {
    readonly orderId: string;
    readonly paymentHash: string;
    readonly expiresAt: number;
  }): Promise<string>;
  verifyCapabilityToken(token: string): Promise<{
    readonly orderId: string;
    readonly paymentHash: string;
    readonly expiresAt: number;
  } | null>;
  quoteSwap(input: SwapQuoteRequest): Promise<unknown>;
  createSwap(input: CreateSwapRequest): Promise<SwapCheckout>;
  getSwap(input: GetSwapRequest): Promise<SwapStatus>;
  createSwapRefundConfirmation(
    input: CreateSwapRefundConfirmationRequest,
  ): Promise<SwapRefundConfirmation>;
  refundSwap(input: SwapRefundRequest): Promise<SwapStatus>;
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
  readonly tokenManager: StatelessTokenManager;
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
  readonly idempotency_key?: string;
  readonly expiry_seconds?: number;
}

export type { NwcTransaction };
