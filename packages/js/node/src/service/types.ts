import type {
  NwcTransaction,
  BtcFiatRateMapWithSource,
  MoneyAmount,
  RateQuote,
  ReceiveNwcClient,
  SourcedPriceProvider,
  PaidPayment,
  PaymentCheck,
  SimplePriceFetch,
} from "@openreceive/core";
import type {
  SwapFee,
  SwapOrder,
  SwapPayInAsset,
  SwapProvider,
  SwapProviderState,
} from "../swap/index.ts";

export type { RateQuote };

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type EventHandler = (event: LogEvent) => void;
/** Same signature as {@link EventHandler}; kept as the `logger` option's name. */
export type Logger = EventHandler;

export interface LoggingOptions {
  /**
   * Opt into the rotating file logger. Default `false`: a library must not
   * create files in the host's working directory unasked. Console logging is
   * unaffected.
   */
  readonly enabled?: boolean;
  readonly directory?: string;
  readonly filename?: string;
  readonly maxFileSizeMb?: number;
  readonly maxFiles?: number;
  /**
   * Minimum level for the built-in console and file loggers.
   * When omitted, both read `LOG_LEVEL` (`DEBUG`|`INFO`|`WARN`|`ERROR`, default `INFO`).
   */
  readonly level?: LogLevel;
  /**
   * Attach the built-in console logger.
   * Default: `true` when no custom `logger` is supplied; `false` when a custom
   * `logger` is supplied (set `true` to keep both).
   */
  readonly console?: boolean;
  /** Console prefix, e.g. `openreceive:my-app`. Default `openreceive`. */
  readonly prefix?: string;
}

export interface NodeOptions {
  readonly client: ReceiveNwcClient;
  readonly priceProviders?: readonly SourcedPriceProvider[];
  readonly priceCurrencies?: readonly string[];
  readonly swap?: SwapOptions;
  readonly onEvent?: EventHandler;
  readonly logger?: Logger;
  readonly logging?: LoggingOptions;
  readonly clock?: () => number;
}

export interface CreateOpenReceiveOptions extends Omit<NodeOptions, "client"> {
  readonly client?: ReceiveNwcClient;
  /** Explicit override. Normal applications read the receive-only URI from NWC_URI. */
  readonly nwc?: string;
  /** Environment source for NWC_URI, LSC_URI_PRIMARY, and LSC_URI_BACKUP. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly priceFetch?: SimplePriceFetch;
  /**
   * Explicit override: boot even when the wallet advertises spend methods such
   * as `pay_invoice`. Defaults to `false` (preflight fails closed). Also
   * settable via `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`.
   */
  readonly allowSpendCapableWallet?: boolean;
}

export type CreateCheckoutAmount =
  | { readonly sats: number | string; readonly currency?: never; readonly value?: never }
  | { readonly currency: string; readonly value: string; readonly sats?: never };

export interface CreateCheckoutRequest {
  readonly reference: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Requested invoice expiry in seconds (default 600). Ignored on the swap
   * path, where the provider-mandated shadow-invoice expiry always wins.
   */
  readonly expirySeconds?: number;
}

/**
 * The minted invoice — the service-level view of the OpenAPI `Checkout` object
 * (the HTTP handler serializes it to the snake_case wire shape,
 * `WireCheckout`).
 */
export interface Checkout {
  readonly reference: string;
  readonly paymentHash: string;
  readonly bolt11: string;
  readonly amountMsats: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly fiatQuote: RateQuote | null;
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
  /** Page cap per wallet-history walk; bounds request-path (opportunistic) passes. */
  readonly maxPages?: number;
}

export type NodeSettlementActionInput = PaidPayment;
export type NodeSettlementActionHook = (input: NodeSettlementActionInput) => Promise<void> | void;

/**
 * One NWC-02 wallet notification: its type, the payment hash when present, and
 * the payload normalized exactly like a `list_transactions` row. Notifications
 * are authenticated wallet data — a `transaction` that satisfies the
 * settlement rule (`settled_at` or a settled state; never a preimage alone)
 * may settle its matching pending attempt directly. Logging only ever surfaces
 * the type and the payment hash.
 */
export interface WalletNotification {
  readonly type: string;
  readonly payment_hash?: string;
  readonly transaction?: NwcTransaction;
}

export type WalletNotificationHandler = (notification: WalletNotification) => void;

export interface SwapOptions {
  /**
   * The provider every catalog, quote, and create goes to while it answers.
   * Omitted (the normal case), providers come from `LSC_URI_PRIMARY` and
   * `LSC_URI_BACKUP` in `env`.
   */
  readonly provider?: SwapProvider;
  /**
   * Consulted in order only when `provider` (or an earlier failover) throws —
   * a network or API failure. Never used to fill in an asset a healthy
   * provider simply does not list. Requires `provider`.
   */
  readonly failoverProviders?: readonly SwapProvider[];
}

export interface SwapQuoteRequest {
  readonly amount: CreateCheckoutAmount;
  readonly payInAsset: SwapPayInAsset | string;
}

/**
 * Service-level swap quote, camelCase like every other service result (the
 * HTTP handler converts to the snake_case wire shape).
 */
export interface SwapQuoteResult {
  readonly provider: string;
  readonly payAsset: SwapPayInAsset;
  readonly available: boolean;
  readonly payAmount?: string;
  readonly minimumPayAmount?: string;
  readonly maximumPayAmount?: string;
  /** Invoice-side (Lightning receive) limits in msats, when reported. */
  readonly minimumInvoiceAmountMsats?: number;
  readonly maximumInvoiceAmountMsats?: number;
  readonly unavailableReason?: string;
  readonly unavailableMessage?: string;
}

export interface ListSwapOptionsRequest {
  /** Host-owned invoice amount in millisatoshis. */
  readonly amountMsats: number;
}

export interface SwapPaymentMethod {
  readonly payInAsset: SwapPayInAsset;
  readonly label: string;
  readonly networkLabel: string;
  readonly provider: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly unavailableMessage?: string;
  readonly payAmount?: string;
  readonly minimumPayAmount?: string;
  readonly maximumPayAmount?: string;
  readonly minimumInvoiceAmountMsats?: number;
  readonly maximumInvoiceAmountMsats?: number;
}

export interface ListSwapOptionsResult {
  readonly enabled: boolean;
  readonly options: readonly SwapPaymentMethod[];
}

export interface CreateSwapRequest extends CreateCheckoutRequest {
  readonly payInAsset: SwapPayInAsset | string;
}

export interface GetSwapRequest {
  readonly reference: string;
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
  readonly reference: string;
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
  /** Why the attempt needs an operator, when `attention` is set. */
  readonly attentionReason?: string;
  /**
   * Amount actually received on the deposit transaction, when the provider
   * reports it. The payer UI compares it with `depositAmount` to explain an
   * underpayment ("you sent X but Y was required").
   */
  readonly depositReceivedAmount?: string;
  /**
   * A second deposit hit the same provider order. Extra funds may sit at the
   * provider while the attempt looks like an ordinary refund path.
   */
  readonly emergencyRepeat?: boolean;
  /** Provider-side order reference, shown to the payer for support. */
  readonly providerOrderId?: string;
  /**
   * Fiat equivalents explaining why the payer sends more than the cart total.
   * Never a price authority — the invoice amount is.
   */
  readonly fee?: SwapFee;
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
  /** Resolve amount_msats without minting a Lightning invoice or committing an attempt. */
  prepareCheckout(input: { readonly amount: CreateCheckoutAmount }): Promise<{
    readonly amountMsats: number;
    readonly fiatQuote: RateQuote | null;
  }>;
  createCheckout(input: CreateCheckoutRequest): Promise<Checkout>;
  checkPayment(input: CheckPaymentRequest): Promise<PaymentCheck>;
  reconcilePayments(input: ReconcilePaymentsRequest): Promise<readonly PaymentCheck[]>;
  /**
   * Opt-in NWC-02 notifications: subscribe to wallet `payment_received`
   * notifications. Notifications are authenticated wallet data — a payload
   * that satisfies the settlement rule settles its matching pending attempt
   * directly; anything less only wakes a batched wallet scan
   * (`reconcilePayments`). Polling remains the safety net for notifications
   * missed while offline. Direct settlement assumes the NWC client binds
   * notification decryption to the connection's wallet pubkey (the bundled
   * SDK does). Resolves to an unsubscribe function; rejects with an
   * OpenReceiveError of code `UNSUPPORTED_METHOD` when the wallet client does
   * not support notifications.
   */
  subscribeWalletNotifications?(
    handler: WalletNotificationHandler,
  ): Promise<() => Promise<void> | void>;
  quoteSwap(input: SwapQuoteRequest): Promise<SwapQuoteResult>;
  listSwapOptions(input: ListSwapOptionsRequest): Promise<ListSwapOptionsResult>;
  createSwap(input: CreateSwapRequest): Promise<SwapCheckout>;
  getSwap(input: GetSwapRequest): Promise<PublicSwap>;
  refundSwap(input: SwapRefundRequest): Promise<PublicSwap>;
  listRates(input?: ListRatesRequest): Promise<BtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: MoneyAmount }): Promise<RateQuote>;
  close(): Promise<void>;
}

export interface ServiceContext {
  readonly options: NodeOptions;
  readonly clock: () => number;
  readonly priceProviders: readonly SourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  /** Primary first, then failovers in order — see {@link SwapOptions}. */
  readonly swapProviders: readonly SwapProvider[];
}

export interface ResolvedCreateAmount {
  readonly amountMsats: number;
  readonly amountSource: "amount" | "fiat";
  readonly fiatQuote: RateQuote | null;
}

export interface NormalizedCreateCheckoutRequest {
  readonly reference: string;
  readonly amount: CreateCheckoutAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
  readonly expirySeconds?: number;
}

export type { NwcTransaction };
