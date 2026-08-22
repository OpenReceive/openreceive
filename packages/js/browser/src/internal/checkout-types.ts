// The browser's shared type vocabulary: checkout snapshots and their derived
// display/state shapes, element attribute and listener options, theme models,
// payment-wizard models, and transaction-detail rows. Types only — the values
// they are derived from live in ./dom-contract.ts.
import type { AssetIndexEntry, PaymentWizardRoute } from "@openreceive/provider-data";
import type { CheckoutStateLabels } from "./checkout-format.ts";
import type {
  CheckoutElementEventName,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
} from "./dom-contract.ts";

export interface OpenReceiveTransientFeedbackOptions<T> {
  readonly resetValue: T;
  readonly delayMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly onValue: (value: T) => void;
}

export interface OpenReceiveTransientFeedbackController<T> {
  show(value: T): void;
  clear(): void;
}

export interface OpenReceiveTickingValueOptions {
  readonly active?: boolean;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly onValue: (value: number) => void;
}

export interface OpenReceiveTickingValueController {
  start(): void;
  stop(): void;
  refresh(): void;
}

export interface OpenReceiveQrEncoder {
  toString(payload: string, options: Record<string, unknown>): Promise<string> | string;
  toDataURL?(payload: string, options: Record<string, unknown>): Promise<string> | string;
}

export interface OpenReceiveQrOptions {
  encoder?: OpenReceiveQrEncoder;
  width?: number;
}

export interface CopyInvoiceOptions {
  invoice: string;
  clipboard?: Pick<Clipboard, "writeText">;
  logger?: OpenReceiveBrowserLoggerOption;
  logContext?: OpenReceiveBrowserLogContext;
}

export interface OpenWalletOptions {
  invoice: string;
  open?: (uri: string) => void;
  logger?: OpenReceiveBrowserLoggerOption;
  logContext?: OpenReceiveBrowserLogContext;
}

export type OpenReceiveBrowserLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenReceiveBrowserLogEntry {
  readonly level: OpenReceiveBrowserLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type OpenReceiveBrowserLogger = (entry: OpenReceiveBrowserLogEntry) => void;

/**
 * Browser logger option. Omit/`undefined` attaches the built-in console logger
 * (honoring `LOG_LEVEL`). Pass `false` to disable OpenReceive browser logs.
 */
export type OpenReceiveBrowserLoggerOption = OpenReceiveBrowserLogger | false;

export interface OpenReceiveBrowserLogContext {
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly [key: string]: unknown;
}

export type CheckoutPhase =
  | "invoice_created"
  | "verifying"
  | "settled"
  | "expired"
  | "failed"
  | "cancelled";

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

/**
 * Provider-reported fiat equivalents of both sides of a swap. `pay_in_fiat` is the
 * value of the crypto the payer must send; `payout_fiat` is the cart total delivered
 * to the merchant. Their gap is the swap fee the payer absorbs.
 */
export interface CheckoutInvoiceSwapFee {
  readonly currency: string;
  readonly pay_in_fiat: string;
  readonly payout_fiat: string;
}

export interface CheckoutInvoiceSwapSnapshot {
  readonly attempt_id?: string;
  readonly provider: string;
  readonly provider_order_id?: string;
  readonly pay_in_asset: string;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly provider_state: SwapProviderState;
  readonly provider_expires_at: number;
  readonly deposit_tx_id?: string;
  readonly payout_tx_id?: string;
  readonly refund_address?: string;
  readonly refund_nonce?: string;
  readonly refund_nonce_expires_at?: number;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
  readonly attention_reason?: string;
  readonly refund_reason?: string;
  readonly deposit_received_amount?: string;
  readonly refund_amount?: string;
  readonly fee?: CheckoutInvoiceSwapFee;
}

/**
 * Formatted fee breakout for the deposit panel, explaining why the payer sends more
 * than the cart total. All figures are display-ready fiat strings.
 */
export interface OpenReceiveSwapFeeBreakdown {
  /** Cart total delivered to the merchant, e.g. "$10.00". */
  readonly cartTotal: string;
  /** Fiat value of the crypto the payer sends, e.g. "$10.59". */
  readonly youSend: string;
  /** The swap fee absorbed by the payer (exchange spread + network fees), e.g. "$0.59". */
  readonly fee: string;
  /** The fee as a percentage of the cart total, e.g. "5.9%", when computable. */
  readonly feePercent?: string;
}

export interface OpenReceiveSwapDisplayModel {
  readonly provider: string;
  readonly attemptId: string;
  readonly payInAsset: string;
  readonly assetLabel: string;
  readonly networkLabel: string;
  /** Strong deposit-panel alert title, e.g. "Wrong currency or network = lost funds". */
  readonly networkWarningTitle: string;
  /** Exact amount + asset + network to emphasize, e.g. "15.01 USDT on the Solana network". */
  readonly networkWarningEmphasis: string;
  /** Full plain-text network warning (accessible / non-HTML consumers). */
  readonly networkWarning: string;
  readonly depositAddress: string;
  readonly depositMemo?: string;
  readonly depositAmount: string;
  readonly providerStateLabel: string;
  readonly providerStateDetail: string;
  readonly state:
    | "creating"
    | "deposit"
    | "progress"
    | "settled"
    | "expired"
    | "refund_required"
    | "refund_pending"
    | "refunded"
    | "attention"
    | "failed";
  readonly expiresInSeconds: number;
  readonly countdownLabel: string;
  readonly qrPayload: string;
  /** Ready-to-render fee breakout, present when the provider reported fiat equivalents. */
  readonly feeBreakdown?: OpenReceiveSwapFeeBreakdown;
  readonly depositTxId?: string;
  readonly payoutTxId?: string;
  readonly refundAddress?: string;
  readonly refundNonce?: string;
  readonly refundTxId?: string;
  readonly refundReason?: string;
  readonly depositReceivedAmount?: string;
  readonly refundAmount?: string;
  readonly providerOrderId?: string;
}

export interface CheckoutInvoiceSnapshot {
  readonly invoice_id: string;
  readonly invoice?: string | null;
  readonly rail: "lightning" | "swap" | "checkout_lock";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: {
    readonly fiat?: {
      readonly currency?: string;
      readonly value?: string;
    };
  } | null;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly expires_at?: number;
  readonly settled_at?: number;
  readonly swap?: CheckoutInvoiceSwapSnapshot;
}

export interface OpenReceiveCheckoutPaymentMethod {
  readonly pay_in_asset: string;
  readonly label: string;
  readonly network_label: string;
  readonly provider: string;
  readonly available: boolean;
  readonly unavailable_reason?: string;
  readonly unavailable_message?: string;
  readonly pay_amount?: string;
  readonly minimum_pay_amount?: string;
  readonly maximum_pay_amount?: string;
  readonly minimum_invoice_amount_msats?: number;
  readonly maximum_invoice_amount_msats?: number;
}

/**
 * Client-side snapshot of one Checkout (the server's `Checkout` /
 * the wire's `OpenReceiveWireCheckout`), aggregated across its payment
 * attempts as the browser polls. Snake_case because it holds wire data
 * verbatim.
 */
export interface CheckoutSnapshot {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly status: "open" | "paid" | "expired";
  readonly paid_at?: number;
  readonly amount_msats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: CheckoutInvoiceSnapshot;
  readonly invoices: readonly CheckoutInvoiceSnapshot[];
  readonly payment_methods?: readonly OpenReceiveCheckoutPaymentMethod[];
}

export interface CheckoutElementAttributeOptions {
  /**
   * Order id for create mode. When no checkout snapshot is supplied, the element is rendered
   * with this as its `order-id` attribute (paired with `prefix`) and owns the whole
   * create/poll lifecycle itself. Ignored when a snapshot is supplied — the snapshot's
   * `order_id` wins.
   */
  readonly orderId?: string;
  /**
   * Base path the shipped router is mounted at. Emitted as the element's `prefix` attribute
   * so a create-mode element (`order-id` with no `invoice`) can derive its create/order
   * routes without spelling them out.
   */
  readonly prefix?: string;
  /**
   * Optional create-time metadata (parity with the React `<Checkout metadata>`
   * prop): JSON-encoded onto the element's `metadata` attribute and sent with
   * the Lightning mint request.
   */
  readonly metadata?: Record<string, unknown>;
  readonly theme?: OpenReceiveResolvedTheme;
  readonly paymentWizard?: boolean;
  /**
   * Opt into History API URL sync to `{resumePathPrefix}/{orderId}` (default `/checkout/:id`).
   * This controls URL mutation only; order-resume data remains a host concern.
   */
  readonly syncUrl?: boolean;
  /** History API path prefix when `syncUrl` is set. Default `/checkout`. */
  readonly resumePathPrefix?: string;
  /**
   * Order id from the app router (e.g. Next.js). When set, skip History API URL sync.
   */
  readonly routeOrderId?: string;
  /**
   * Base URL of an external bolt11 decoder. Omitted (the default), the element
   * renders no "Decode" link and the invoice is never sent to a third party.
   */
  readonly decodeLinkUrl?: string;
  /** False renders the snapshot without status polling (no POST /payments/check). */
  readonly polling?: boolean;
  /** Status poll cadence in milliseconds; defaults to OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS. */
  readonly pollIntervalMs?: number;
}

export interface OpenReceiveThemeToggleElementAttributeOptions {
  readonly rootSelector?: string;
  readonly checkoutSelector?: string;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly storageKey?: string;
}

export type CheckoutElementAttributeName =
  (typeof OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES)[keyof typeof OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES];

export type CheckoutElementAttributes = Partial<Record<CheckoutElementAttributeName, string>>;

export type OpenReceiveThemeToggleElementAttributeName =
  (typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES)[keyof typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES];

export type OpenReceiveThemeToggleElementAttributes = Partial<
  Record<OpenReceiveThemeToggleElementAttributeName, string>
>;

export interface CheckoutElementEventHandlers {
  readonly onCopy?: (event: Event) => void;
  readonly onOpenWallet?: (event: Event) => void;
  readonly onState?: (event: Event) => void;
  readonly onSettled?: (event: Event) => void;
  readonly onProviderCopy?: (event: Event) => void;
  readonly onStartOver?: (event: Event) => void;
  readonly onError?: (event: Event) => void;
}

export type CheckoutElementListeners = Partial<
  Record<CheckoutElementEventName, (event: Event) => void>
>;

export interface CheckoutShellOptions
  extends Omit<CheckoutElementAttributeOptions, "theme">,
    CheckoutElementEventHandlers,
    OpenReceiveStoredThemeModelOptions {
  readonly rootSelector?: string;
  readonly checkoutSelector?: string;
  /**
   * When false, omit the package theme toggle and do not stamp `data-theme` on the
   * shell root or checkout. The checkout inherits from an ancestor `[data-theme]`
   * (e.g. React `ThemeScope`). Default true for standalone embeds.
   */
  readonly themeToggle?: boolean;
}

export interface CheckoutShellCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attributes: CheckoutElementAttributes;
  readonly listeners: CheckoutElementListeners;
}

export interface CheckoutShellThemeToggleBinding {
  readonly tagName: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly attributes: OpenReceiveThemeToggleElementAttributes;
}

export interface CheckoutShellModel {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttributes: Partial<OpenReceiveThemeModel["attributes"]>;
  readonly checkout: CheckoutShellCheckoutBinding;
  readonly themeToggle: CheckoutShellThemeToggleBinding | null;
}

export interface CheckoutElementTarget extends OpenReceiveThemeAttributeTarget {
  addEventListener(name: string, listener: (event: Event) => void): void;
}

export interface CheckoutElementDocument {
  createElement(tagName: string): HTMLElement;
}

export interface CreateOpenReceiveThemeToggleElementOptions
  extends OpenReceiveThemeToggleElementAttributeOptions {
  readonly document?: CheckoutElementDocument;
}

export interface CreateCheckoutShellOptions extends CheckoutShellOptions {
  readonly document?: CheckoutElementDocument;
  readonly root?: OpenReceiveThemeAttributeTarget | null;
}

export interface CheckoutShellElements {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttributes: Partial<OpenReceiveThemeModel["attributes"]>;
  readonly checkout: HTMLElement;
  readonly themeToggle: HTMLElement | null;
}

/**
 * The ONE derived view of a checkout: a snapshot plus a clock, flattened onto
 * the attempt the payer is looking at, with the phase machine's verdict and the
 * labels the UI prints. Produced only by `createCheckoutState`.
 *
 * It extends {@link CheckoutStateLabels}, so the labels ship with the state —
 * including in the `openreceive-state` CustomEvent's `detail.state`.
 */
export interface CheckoutState extends CheckoutStateLabels {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly invoice_id: string;
  readonly invoice: string;
  readonly rail: "lightning" | "swap" | "checkout_lock";
  readonly lightning_uri: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutInvoiceSnapshot["fiat_quote"];
  readonly transaction_state: string;
  readonly workflow_state: string;
  readonly expires_at?: number;
  readonly expires_in_seconds?: number;
  readonly phase: CheckoutPhase;
  readonly settled: boolean;
  readonly terminal: boolean;
  readonly paid: boolean;
  readonly settled_at?: number;
  readonly swap?: CheckoutInvoiceSwapSnapshot;
}

export interface CheckoutStatusModelInput {
  readonly phase?: CheckoutPhase;
  readonly waiting?: boolean;
  readonly expires_in_seconds?: number;
}

export interface CheckoutStatusModel {
  readonly phase: CheckoutPhase;
  readonly waiting: boolean;
  readonly title: string;
  readonly detail: string;
  readonly countdownPrefix: string;
  readonly expires_in_seconds?: number;
  readonly countdownLabel?: string;
}

export type CheckoutStatusRefresh = (orderId: string) => Promise<CheckoutSnapshot | null>;

export type RequestCheckoutOptions = RequestCheckoutBaseOptions;

export interface RequestCheckoutBaseOptions {
  /**
   * Base path the shipped router is mounted at (e.g. `/openreceive`). The create and
   * prepare routes are derived from it — see {@link openReceiveRoutes}. It is required
   * because it is the only URL input: there is no per-route override.
   */
  readonly prefix: string;
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateOpenReceiveStatusFetcherOptions {
  /**
   * Base path the shipped router is mounted at. The fetcher polls
   * `${prefix}/payments/check` and reads live swap state from
   * `${prefix}/swaps/status` — see {@link openReceiveRoutes}.
   */
  readonly prefix: string;
  readonly snapshot: CheckoutSnapshot;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CheckoutWatcherOptions {
  readonly snapshot: CheckoutSnapshot;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly onState: (state: CheckoutState) => void;
  readonly onSnapshot?: (snapshot: CheckoutSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

export interface CheckoutControllerOptions extends Omit<CheckoutWatcherOptions, "onState"> {
  readonly onState?: (state: CheckoutState) => void;
  /**
   * Base path the shipped router is mounted at. Omitted, the controller does no
   * status polling of its own — pass `refreshStatus` instead, or nothing at all
   * to render a snapshot without polling.
   */
  readonly prefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly statusHeaders?: Readonly<Record<string, string>>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
}

export interface CheckoutController {
  start(): CheckoutState;
  stop(): void;
  getState(): CheckoutState | undefined;
  reloadState(): Promise<CheckoutState>;
  /**
   * Stop all timers and mark the checkout `cancelled`: the returned state (and
   * every later `getState()`) carries the terminal `cancelled` phase.
   */
  cancel(): CheckoutState;
  copyInvoice(): Promise<void>;
  openWallet(): string;
}

export interface CreateCheckoutStateOptions {
  readonly now?: number;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  /**
   * How this state was produced. Controls which browser log events fire:
   * - `create` (default): `checkout.state.created`
   * - `refresh`: `checkout.state.refreshed` plus `swap.state.changed` when swap fields move
   * - `countdown`: no log (avoids per-second spam from the expiry ticker)
   */
  readonly source?: "create" | "refresh" | "countdown";
  /** Prior checkout state; used with `source: "refresh"` to emit swap transition audits. */
  readonly previousState?: CheckoutState;
}

export type OpenReceivePaymentMethod = "bitcoin";
export type OpenReceiveThemePreference = "light" | "dark" | "system";
export type OpenReceiveResolvedTheme = "light" | "dark";

export interface OpenReceivePaymentMethodOption {
  readonly id: OpenReceivePaymentMethod;
  readonly title: string;
  readonly detail: string;
}

export interface ParseOpenReceiveOptionalIntegerOptions {
  readonly label?: string;
}

export interface OpenReceiveThemeModelOptions {
  readonly systemDark?: boolean;
}

export interface OpenReceiveThemeStorageOptions {
  readonly storage?: Storage;
  readonly storageKey?: string;
}

export interface OpenReceiveReadThemePreferenceOptions extends OpenReceiveThemeStorageOptions {
  readonly defaultTheme?: OpenReceiveThemePreference;
}

export interface OpenReceiveStoredThemeModelOptions
  extends OpenReceiveReadThemePreferenceOptions,
    OpenReceiveThemeModelOptions {}

export interface OpenReceiveThemeAttributeTarget {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface OpenReceiveThemeLabelTarget {
  textContent: string | null;
}

export interface OpenReceiveThemeControlTargets {
  readonly root?: OpenReceiveThemeAttributeTarget | null;
  readonly checkout?: OpenReceiveThemeAttributeTarget | null;
  readonly toggle?: OpenReceiveThemeLabelTarget | null;
}

export interface OpenReceiveThemeModel {
  readonly theme: OpenReceiveThemePreference;
  readonly resolvedTheme: OpenReceiveResolvedTheme;
  readonly nextTheme: OpenReceiveThemePreference;
  readonly toggleLabel: string;
  readonly attributes: {
    readonly "data-theme": OpenReceiveResolvedTheme;
    readonly "data-openreceive-theme": OpenReceiveResolvedTheme;
  };
  readonly checkoutElementAttributes: {
    readonly theme: OpenReceiveResolvedTheme;
  };
}

export interface OpenReceivePaymentWizardRequest {
  readonly selectedMethod: OpenReceivePaymentMethod | null;
  readonly selectedBitcoinRoute?: string | null;
}

export interface OpenReceivePaymentWizardSelection {
  readonly selectedMethod: OpenReceivePaymentMethod | null;
  readonly selectedBitcoinRoute: string | null;
}

export type OpenReceivePaymentWizardSelectionAction =
  | {
      readonly type: "select_method";
      readonly method: OpenReceivePaymentMethod;
    }
  | {
      readonly type: "change_method";
    }
  | {
      readonly type: "change_route";
    }
  | {
      readonly type: "select_route";
      readonly route: string;
    };

export interface OpenReceivePaymentWizardState {
  readonly selectedRouteId: string | null;
  readonly routes: readonly PaymentWizardRoute[];
}

export interface OpenReceivePaymentWizardModel {
  readonly selection: OpenReceivePaymentWizardSelection;
  readonly wizard: OpenReceivePaymentWizardState;
  readonly routeAssets: readonly AssetIndexEntry[];
  readonly selectedRoute: string | null;
}

export interface OpenReceivePaymentWizardControllerOptions {
  readonly selection?: OpenReceivePaymentWizardSelection;
  readonly onSelection?: (selection: OpenReceivePaymentWizardSelection) => void;
}

export interface OpenReceivePaymentWizardController {
  getSelection(): OpenReceivePaymentWizardSelection;
  getModel(): OpenReceivePaymentWizardModel;
  update(action: OpenReceivePaymentWizardSelectionAction): OpenReceivePaymentWizardSelection;
  selectMethod(method: OpenReceivePaymentMethod): OpenReceivePaymentWizardSelection;
  changeMethod(): OpenReceivePaymentWizardSelection;
  selectRoute(route: string): OpenReceivePaymentWizardSelection;
}

export interface OpenReceiveWizardRouteAssetDisplay {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly selected: boolean;
}

export interface OpenReceiveWizardProviderTutorialDisplay {
  readonly index: number;
  readonly path: string;
  readonly image: string;
  readonly caption: string;
}

export interface OpenReceiveWizardProviderDisplay {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url: string;
  readonly icon: string;
  readonly tutorials: readonly OpenReceiveWizardProviderTutorialDisplay[];
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly openLabel: string;
}

export interface OpenReceiveWizardRouteDisplay {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly providers: readonly OpenReceiveWizardProviderDisplay[];
}

/**
 * One display row for post-settlement transaction details. Values are already
 * formatted for UI; `copyValue` is the full string when the display value is truncated.
 * Never includes NWC secrets — those are not part of checkout public state.
 * Optional `href` is a block-explorer or Lightning invoice decode link.
 */
export interface OpenReceiveTransactionDetailRow {
  readonly label: string;
  readonly value: string;
  readonly copyValue?: string;
  readonly href?: string;
  readonly hrefLabel?: string;
}

export interface OpenReceiveTransactionDetailsInput {
  readonly order_id?: string;
  readonly checkout_id?: string;
  readonly invoice_id?: string;
  readonly invoice?: string | null;
  readonly rail?: "lightning" | "swap" | "checkout_lock";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutInvoiceSnapshot["fiat_quote"];
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly expires_at?: number;
  readonly settled_at?: number;
  readonly swap?: CheckoutInvoiceSwapSnapshot;
  /**
   * Base URL of a host-chosen bolt11 decoder. Omitted (the default), the
   * Lightning invoice row carries no decode link and the invoice is never
   * handed to a third party.
   */
  readonly decodeLinkUrl?: string;
}
