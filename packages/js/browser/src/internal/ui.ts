import type {
  AssetIndexEntry,
  Country,
  FiatRailId,
  PaymentWizardRoute,
} from "@openreceive/provider-data";
import type { Status } from "../status.ts";
import { openReceiveCompiledStyles } from "../generated/compiled-styles.ts";

export { type Status, type StatusInvoiceLike, status } from "../status.ts";

export const OPENRECEIVE_QR_QUIET_ZONE_MODULES = 4 as const;
export const OPENRECEIVE_QR_DARK_COLOR = "#000000" as const;
export const OPENRECEIVE_QR_LIGHT_COLOR = "#FFFFFFFF" as const;
export const OPENRECEIVE_QR_ERROR_CORRECTION = "M" as const;
export const OPENRECEIVE_COUNTRY_STORAGE_KEY = "openreceive.checkout.country" as const;
export const OPENRECEIVE_LEGACY_DEMO_COUNTRY_STORAGE_KEY = "openreceive-demo.country" as const;
export const OPENRECEIVE_THEME_STORAGE_KEY = "openreceive.theme" as const;
export const OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS = 3000 as const;
/**
 * Default base path the shipped OpenReceive router is mounted at. When a developer passes
 * only an order id (React `<Checkout orderId>` / `<openreceive-checkout order-id>`), this is
 * the prefix used to derive the create route (`${prefix}/checkouts`) and the order route
 * (`${prefix}/orders/${orderId}`).
 */
export const OPENRECEIVE_DEFAULT_PREFIX = "/openreceive" as const;
export const OPENRECEIVE_COPY_FEEDBACK_MS = 1800 as const;
export const OPENRECEIVE_PROVIDER_PREVIEW_LIMIT = 4 as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME = "openreceive-checkout" as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME = "openreceive-theme-toggle" as const;
export const OPENRECEIVE_COUNTRY_MAP_WIDTH = 820 as const;
export const OPENRECEIVE_COUNTRY_MAP_HEIGHT = 420 as const;
export const OPENRECEIVE_COUNTRY_MAP_VIEW_BOX =
  `0 0 ${OPENRECEIVE_COUNTRY_MAP_WIDTH} ${OPENRECEIVE_COUNTRY_MAP_HEIGHT}` as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS = {
  copy: "openreceive-copy",
  openWallet: "openreceive-open-wallet",
  state: "openreceive-state",
  settled: "openreceive-settled",
  providerCopy: "openreceive-provider-copy",
  startOver: "openreceive-start-over",
  error: "openreceive-error",
} as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS = {
  change: "openreceive-theme-change",
} as const;
export const OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES = {
  root: "data-openreceive-wizard",
  breadcrumb: "data-or-breadcrumb",
  method: "data-or-method",
  region: "data-or-region",
  regionShape: "data-or-region-shape",
  country: "data-or-country",
  switchCountry: "data-or-switch-country",
  route: "data-or-route",
  swapStart: "data-or-swap-start",
  swapBack: "data-or-swap-back",
  swapQr: "data-or-swap-qr",
  swapCopy: "data-or-swap-copy",
  swapNetwork: "data-or-swap-network",
  swapNetworkValue: "data-or-swap-network-value",
  pickerSelect: "data-or-picker-select",
  pickerContinue: "data-or-picker-continue",
  swapRefundForm: "data-or-swap-refund-form",
  swapRefundAddress: "data-or-swap-refund-address",
  swapRefundNonce: "data-or-swap-refund-nonce",
  swapRefundConfirm: "data-or-swap-refund-confirm",
  providerCopy: "data-or-provider-copy",
  providerTutorial: "data-or-provider-tutorial",
  providerTutorialIndex: "data-or-provider-tutorial-index",
} as const;
export const OPENRECEIVE_PAYMENT_WIZARD_SELECTORS = {
  root: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}]`,
  breadcrumb: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}]`,
  method: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}]`,
  region: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.region}]`,
  regionShape: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.regionShape}]`,
  country: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country}]`,
  switchCountry: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.switchCountry}]`,
  route: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.route}]`,
  swapStart: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}]`,
  swapBack: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapBack}]`,
  swapQr: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr}]`,
  swapCopy: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy}]`,
  swapNetwork: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork}]`,
  swapNetworkValue: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetworkValue}]`,
  pickerSelect: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect}]`,
  pickerContinue: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerContinue}]`,
  swapRefundForm: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}]`,
  swapRefundAddress: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAddress}]`,
  swapRefundNonce: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce}]`,
  swapRefundConfirm: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm}]`,
  providerCopy: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerCopy}]`,
  providerTutorial: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}]`,
  providerTutorialIndex: `[${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}]`,
} as const;
export const OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES = {
  root: "data-openreceive-checkout",
  qr: "data-openreceive-qr",
  meta: "data-openreceive-meta",
  state: "data-openreceive-state",
  actions: "data-openreceive-actions",
  theme: "data-openreceive-theme",
  themeToggle: "data-openreceive-theme-toggle",
} as const;
export const OPENRECEIVE_CHECKOUT_DATA_SELECTORS = {
  root: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root}]`,
  qr: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr}]`,
  meta: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.meta}]`,
  state: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.state}]`,
  actions: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions}]`,
  theme: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.theme}]`,
  themeToggle: `[${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle}]`,
} as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_PARTS = {
  copy: "copy",
  open: "open",
  startOver: "start-over",
} as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS = {
  copy: `[part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.copy}"]`,
  open: `[part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.open}"]`,
  startOver: `[part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.startOver}"]`,
} as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS = {
  button: "button",
} as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS = {
  button: `[part="${OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS.button}"]`,
} as const;
export type CheckoutElementEventName =
  (typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS)[keyof typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS];
export interface CheckoutProviderCopyEventDetail {
  readonly providerId: string;
}
export interface CheckoutStateEventDetail {
  readonly state: CheckoutState;
}
export interface CheckoutErrorEventDetail {
  readonly error: unknown;
}
export interface OpenReceiveThemeChangeEventDetail {
  readonly theme: OpenReceiveThemePreference;
  readonly resolvedTheme: OpenReceiveResolvedTheme;
}

export function createCheckoutProviderCopyEvent(
  providerId: string,
): CustomEvent<CheckoutProviderCopyEventDetail> {
  return new CustomEvent<CheckoutProviderCopyEventDetail>(
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy,
    {
      detail: {
        providerId,
      },
    },
  );
}

export function createCheckoutActionEvent(
  eventName:
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver,
): CustomEvent {
  return new CustomEvent(eventName);
}

export function createCheckoutStateEvent(
  eventName:
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled,
  state: CheckoutState,
): CustomEvent<CheckoutStateEventDetail> {
  return new CustomEvent<CheckoutStateEventDetail>(eventName, {
    detail: {
      state,
    },
  });
}

export function createCheckoutErrorEvent(error: unknown): CustomEvent<CheckoutErrorEventDetail> {
  return new CustomEvent<CheckoutErrorEventDetail>(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error, {
    detail: {
      error,
    },
  });
}

export function createOpenReceiveThemeChangeEvent(
  theme: OpenReceiveThemeModel,
): CustomEvent<OpenReceiveThemeChangeEventDetail> {
  return new CustomEvent<OpenReceiveThemeChangeEventDetail>(
    OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS.change,
    {
      detail: {
        theme: theme.theme,
        resolvedTheme: theme.resolvedTheme,
      },
    },
  );
}

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

export type OpenReceivePaymentIconId =
  | "bank"
  | "bnb"
  | "btc"
  | "card"
  | "crypto"
  | "doge"
  | "eth"
  | "lightning"
  | "ltc"
  | "sol"
  | "trx"
  | "usdc"
  | "usdt"
  | "xmr"
  | "xrp";

declare const __filename: string | undefined;

const moduleUrl =
  typeof import.meta.url === "string" && import.meta.url.length > 0
    ? import.meta.url
    : fileUrlFromPath(__filename as string);

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function assetUrl(path: string): string {
  return new URL(path, moduleUrl).href;
}

const paymentIconRoot = moduleUrl.includes("/src/internal/")
  ? "../assets/icons/"
  : "./assets/icons/";

function paymentIconUrl(file: string): string {
  return assetUrl(`${paymentIconRoot}${file}`);
}

const bankIcon = paymentIconUrl("bank.svg");
const bnbIcon = paymentIconUrl("bnb.svg");
const btcIcon = paymentIconUrl("btc.svg");
const cardIcon = paymentIconUrl("card.svg");
const cryptoIcon = paymentIconUrl("crypto.svg");
const dogeIcon = paymentIconUrl("doge.svg");
const ethIcon = paymentIconUrl("eth.svg");
const lightningIcon = paymentIconUrl("lightning.svg");
const ltcIcon = paymentIconUrl("ltc.svg");
const solIcon = paymentIconUrl("sol.svg");
const trxIcon = paymentIconUrl("trx.svg");
const usdcIcon = paymentIconUrl("usdc.svg");
const usdtIcon = paymentIconUrl("usdt.svg");
const xmrIcon = paymentIconUrl("xmr.svg");
const xrpIcon = paymentIconUrl("xrp.svg");

export const openReceivePaymentIconUrls: Readonly<Record<OpenReceivePaymentIconId, string>> = {
  bank: bankIcon,
  bnb: bnbIcon,
  btc: btcIcon,
  card: cardIcon,
  crypto: cryptoIcon,
  doge: dogeIcon,
  eth: ethIcon,
  lightning: lightningIcon,
  ltc: ltcIcon,
  sol: solIcon,
  trx: trxIcon,
  usdc: usdcIcon,
  usdt: usdtIcon,
  xmr: xmrIcon,
  xrp: xrpIcon,
} as const;

export const openReceivePaymentMethodIconIds: Readonly<
  Record<OpenReceivePaymentMethod, OpenReceivePaymentIconId>
> = {
  bitcoin: "btc",
  crypto: "crypto",
} as const;

export const openReceiveAssetIconIds: Readonly<Record<string, OpenReceivePaymentIconId>> = {
  bnb: "bnb",
  btc: "btc",
  doge: "doge",
  eth: "eth",
  ltc: "ltc",
  sol: "sol",
  trx: "trx",
  usdc: "usdc",
  usdt: "usdt",
  xmr: "xmr",
  xrp: "xrp",
} as const;

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
  logger?: OpenReceiveBrowserLogger;
  logContext?: OpenReceiveBrowserLogContext;
}

export interface OpenWalletOptions {
  invoice: string;
  open?: (uri: string) => void;
  logger?: OpenReceiveBrowserLogger;
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
  readonly providerOrderId?: string;
}

export interface CheckoutInvoiceSnapshot {
  readonly invoice_id: string;
  readonly invoice?: string | null;
  readonly rail: "lightning" | "swap";
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

export interface CheckoutSnapshot {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly status: "open" | "superseded" | "paid" | "expired";
  readonly paid_at?: number;
  readonly amount_msats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: CheckoutInvoiceSnapshot;
  readonly invoices: readonly CheckoutInvoiceSnapshot[];
  readonly wallet_scan_performed?: boolean;
  readonly transactions_checked?: number;
  readonly payment_methods?: readonly OpenReceiveCheckoutPaymentMethod[];
}

export interface CheckoutDisplayData {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly rail: "lightning" | "swap";
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

export interface CheckoutDisplayModel extends CheckoutDisplayData {
  readonly lightning_uri: string;
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
  readonly transactionStateLabel?: string;
}

export const OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES = {
  orderId: "order-id",
  prefix: "prefix",
  invoiceId: "invoice-id",
  invoice: "invoice",
  rail: "rail",
  paymentHash: "payment-hash",
  amountMsats: "amount-msats",
  fiatCurrency: "fiat-currency",
  fiatValue: "fiat-value",
  status: "status",
  expiresAt: "expires-at",
  orderUrl: "order-url",
  theme: "theme",
  paymentWizard: "payment-wizard",
} as const;

export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES = {
  rootSelector: "root-selector",
  checkoutSelector: "checkout-selector",
  defaultTheme: "default-theme",
  storageKey: "storage-key",
} as const;

export interface CheckoutElementAttributeOptions {
  readonly orderUrl?: string;
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
   * Optional create-time metadata, for parity with the React `<Checkout metadata>` prop. The
   * custom element derives its create request from `order-id`/`prefix` and has no metadata
   * attribute, so this is accepted on the wrapper API but not forwarded to the element.
   */
  readonly metadata?: Record<string, unknown>;
  readonly theme?: OpenReceiveResolvedTheme;
  readonly paymentWizard?: boolean;
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
}

export interface OpenReceiveCheckoutProps extends CheckoutElementEventHandlers {
  readonly checkout: CheckoutSnapshot;
  readonly status?: Status;
  readonly providers?: readonly OpenReceiveWizardProviderDisplay[];
  readonly theme?: OpenReceiveThemePreference;
}

export interface OpenReceiveCheckoutShellProps
  extends OpenReceiveCheckoutProps,
    Omit<CheckoutShellOptions, keyof CheckoutElementEventHandlers | "defaultTheme"> {
  readonly defaultTheme?: OpenReceiveThemePreference;
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
  readonly rootAttributes: OpenReceiveThemeModel["attributes"];
  readonly checkout: CheckoutShellCheckoutBinding;
  readonly themeToggle: CheckoutShellThemeToggleBinding;
}

export interface CheckoutElementTarget extends OpenReceiveThemeAttributeTarget {
  addEventListener(name: string, listener: (event: Event) => void): void;
}

export interface CheckoutElementDocument {
  createElement(tagName: string): HTMLElement;
}

export interface CreateCheckoutElementOptions
  extends CheckoutElementAttributeOptions,
    CheckoutElementEventHandlers {
  readonly document?: CheckoutElementDocument;
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
  readonly rootAttributes: OpenReceiveThemeModel["attributes"];
  readonly checkout: HTMLElement;
  readonly themeToggle: HTMLElement;
}

export interface CheckoutState {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly invoice_id: string;
  readonly invoice: string;
  readonly rail: "lightning" | "swap";
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

/**
 * Trusted create-checkout amount for custom `checkoutUrl` posts. Matches Node's
 * `CreateCheckoutAmount`: exactly one of `{ sats }` or `{ currency, value }`.
 */
export type RequestCheckoutAmount =
  | { readonly sats: number | string; readonly currency?: never; readonly value?: never }
  | { readonly currency: string; readonly value: string; readonly sats?: never };

export type RequestCheckoutOptions = RequestCheckoutBaseOptions &
  (
    | {
        readonly amount: RequestCheckoutAmount;
      }
    // Amount-less create: `{ prefix, orderId }` (or `{ checkoutUrl, orderId }`) with no amount.
    // The mounted server's getCheckoutAmount sets the authoritative price; the client POSTs a body
    // of only `{ order_id }`.
    | {
        readonly amount?: never;
      }
  );

export interface RequestCheckoutBaseOptions {
  /**
   * Absolute or app-relative URL of the checkout-create endpoint. Supports `{orderId}` /
   * `{order_id}` templating and a `(orderId) => string` builder. Optional when `prefix` is
   * given; `checkoutUrl` wins when both are set.
   */
  readonly checkoutUrl?: string | ((orderId: string) => string);
  /**
   * Base path the shipped router is mounted at (e.g. `/openreceive`). When set and
   * `checkoutUrl` is not, the create URL is derived as `${prefix}/checkouts` (a trailing
   * slash on the prefix is stripped). Lets a developer point the client at a mounted router
   * without spelling out each route.
   */
  readonly prefix?: string;
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateOpenReceiveStatusFetcherOptions {
  readonly orderUrl: string;
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
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onState: (state: CheckoutState) => void;
  readonly onSnapshot?: (snapshot: CheckoutSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

export interface CheckoutControllerOptions extends Omit<CheckoutWatcherOptions, "onState"> {
  readonly onState?: (state: CheckoutState) => void;
  readonly orderUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly statusHeaders?: Readonly<Record<string, string>>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
}

export interface CheckoutController {
  start(): CheckoutState;
  update(options: CheckoutControllerOptions): CheckoutState;
  stop(): void;
  getState(): CheckoutState | undefined;
  reloadState(): Promise<CheckoutState>;
  retry(): Promise<CheckoutState>;
  cancel(): CheckoutState;
  copyInvoice(): Promise<void>;
  openWallet(): string;
}

/**
 * Options for {@link createOpenReceiveCheckoutSession}: everything a controller accepts (minus
 * the fields the session derives itself — `snapshot`, `orderUrl`, `refreshStatus`) plus the
 * create inputs. Amount is optional; omit it to let the mounted server set the price.
 */
export interface CreateOpenReceiveCheckoutSessionOptions
  extends Omit<CheckoutControllerOptions, "snapshot" | "orderUrl" | "refreshStatus"> {
  /** Base path the shipped router is mounted at; defaults to {@link OPENRECEIVE_DEFAULT_PREFIX}. */
  readonly prefix?: string;
  readonly orderId: string;
  readonly metadata?: Record<string, unknown>;
  readonly memo?: string;
  /** Extra headers for the create POST (status polls use `statusHeaders`). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly amount?: RequestCheckoutAmount;
}

/** A created checkout paired with the order route it polls and a ready-to-start controller. */
export interface OpenReceiveCheckoutSession {
  readonly checkout: CheckoutSnapshot;
  readonly orderUrl: string;
  readonly controller: CheckoutController;
}

export interface CreateCheckoutStateOptions {
  readonly now?: number;
  readonly logger?: OpenReceiveBrowserLogger;
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

export type OpenReceivePaymentMethod = "bitcoin" | "crypto";
export type OpenReceiveThemePreference = "light" | "dark" | "system";
export type OpenReceiveResolvedTheme = "light" | "dark";
export type OpenReceiveRegionId =
  | "north-america"
  | "latin-america"
  | "europe"
  | "africa"
  | "middle-east"
  | "asia-pacific";

export interface OpenReceivePaymentMethodOption {
  readonly id: OpenReceivePaymentMethod;
  readonly title: string;
  readonly detail: string;
}

export interface ParseOpenReceiveOptionalIntegerOptions {
  readonly label?: string;
}

export interface OpenReceiveCountryMapPin {
  readonly region: OpenReceiveRegionId;
  readonly coordinates: readonly [number, number];
}

export interface OpenReceiveCountryPickerRegion {
  readonly id: OpenReceiveRegionId;
  readonly label: string;
  readonly count: number;
  readonly enabled: boolean;
  readonly selected: boolean;
}

export interface OpenReceiveCountryDisplay {
  readonly country: Country;
  readonly code: string;
  readonly label: string;
  readonly metaLabel: string;
  readonly selected: boolean;
}

export interface OpenReceiveCountryPickerMapCountry {
  readonly country: Country;
  readonly region: OpenReceiveRegionId;
  readonly coordinates: readonly [number, number];
  readonly point: readonly [number, number];
  readonly selected: boolean;
  readonly hovered: boolean;
  readonly label: string;
  readonly metaLabel: string;
}

export interface OpenReceiveCountryPickerModel {
  readonly countries: readonly Country[];
  readonly regions: readonly OpenReceiveCountryPickerRegion[];
  readonly selectedCountry?: Country;
  readonly hoveredCountry?: Country;
  readonly selectedCountryDisplay?: OpenReceiveCountryDisplay;
  readonly hoveredCountryDisplay?: OpenReceiveCountryDisplay;
  readonly readoutLabel: string;
  readonly readoutMetaLabel?: string;
  readonly visibleRegionCountries: readonly Country[];
  readonly visibleRegionCountryDisplays: readonly OpenReceiveCountryDisplay[];
  readonly mapCountries: readonly OpenReceiveCountryPickerMapCountry[];
}

export interface OpenReceiveCountryPickerModelRequest {
  readonly countries: readonly Country[];
  readonly selectedCountryCode: string;
  readonly selectedRegion: OpenReceiveRegionId;
  readonly hoveredCountryCode?: string | null;
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
  readonly selectedCountryCode?: string;
  readonly selectedBitcoinRoute?: string | null;
  readonly selectedCryptoRoute?: string | null;
}

export interface OpenReceivePaymentWizardSelection {
  readonly selectedMethod: OpenReceivePaymentMethod | null;
  readonly selectedCountryCode: string;
  readonly selectedBitcoinRoute: string | null;
  readonly selectedCryptoRoute: string | null;
  readonly selectedRegion: OpenReceiveRegionId;
  readonly countryPickerOpen: boolean;
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
      readonly type: "select_region";
      readonly region: OpenReceiveRegionId;
    }
  | {
      readonly type: "select_country";
      readonly countryCode: string;
    }
  | {
      readonly type: "open_country_picker";
    }
  | {
      readonly type: "select_route";
      readonly route: string;
    };

export interface OpenReceivePaymentWizardState {
  readonly selectedRail: FiatRailId | null;
  readonly selectedCountry?: Country;
  readonly railCountries: readonly Country[];
  readonly selectedRouteId: string | null;
  readonly routes: readonly PaymentWizardRoute[];
}

export interface OpenReceivePaymentWizardModel {
  readonly selection: OpenReceivePaymentWizardSelection;
  readonly wizard: OpenReceivePaymentWizardState;
  readonly countryPicker: OpenReceiveCountryPickerModel;
  readonly countryDisplays: readonly OpenReceiveCountryDisplay[];
  readonly visibleRegionCountries: readonly Country[];
  readonly visibleRegionCountryDisplays: readonly OpenReceiveCountryDisplay[];
  readonly selectedCountryDisplay?: OpenReceiveCountryDisplay;
  readonly routeAssets: readonly AssetIndexEntry[];
  readonly selectedRoute: string | null;
}

export interface OpenReceivePaymentWizardControllerOptions {
  readonly selection?: OpenReceivePaymentWizardSelection;
  readonly storedCountryCode?: string | null;
  readonly defaultCountryCode?: string;
  readonly storage?: Storage;
  readonly storageKey?: string;
  readonly onSelection?: (selection: OpenReceivePaymentWizardSelection) => void;
}

export interface OpenReceivePaymentWizardController {
  getSelection(): OpenReceivePaymentWizardSelection;
  getModel(): OpenReceivePaymentWizardModel;
  update(action: OpenReceivePaymentWizardSelectionAction): OpenReceivePaymentWizardSelection;
  selectMethod(method: OpenReceivePaymentMethod): OpenReceivePaymentWizardSelection;
  changeMethod(): OpenReceivePaymentWizardSelection;
  selectRegion(region: OpenReceiveRegionId): OpenReceivePaymentWizardSelection;
  selectCountry(countryCode: string): OpenReceivePaymentWizardSelection;
  openCountryPicker(): OpenReceivePaymentWizardSelection;
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
  readonly recommended: boolean;
  readonly recommendedLabel: string | null;
  readonly usBadge: string | null;
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

export const openReceiveCheckoutLabels = {
  copyInvoice: "Copy invoice",
  copied: "Copied!",
  openWallet: "Open Wallet",
  bitcoinLightningInvoice: "Bitcoin Lightning invoice",
  paymentStatus: {
    waitingTitle: "Waiting for payment",
    waitingDetail: "Keep this page open while we verify settlement.",
    settledTitle: "Payment received",
    settledDetail: "Backend settlement verified.",
    expiredTitle: "Invoice expired",
    expiredDetail: "Create a fresh invoice to keep going.",
  },
  countdownPrefix: "Invoice expires in",
  startOver: "Start over",
  wizardTitle: "Pay this invoice",
  wizardSubtitle: "Choose how you want to pay.",
  paymentMethod: "Payment method",
  loadingCurrencies: "Loading currencies...",
  emptyBitcoin: "Choose Bitcoin Lightning.",
  emptyCrypto: "Choose an altcoin.",
  emptyFiat: "No providers found for this country yet.",
  recommended: "Recommended",
  openProvider: "How To Pay",
  tutorialTitlePrefix: "Pay a Lightning invoice with",
  tutorialIntroPrefix: "It's easy to make this payment using",
  tutorialIntroCopy: "The first step is to copy the invoice to your clipboard.",
  tutorialCopiedContinue: "Copied! Click next below to continue with tutorial.",
  tutorialExit: "Exit",
  lightningNetwork: "Lightning Network",
  chooseCountry: "Choose a country",
  chooseNetwork: "Choose network",
  selectNetwork: "Select network",
  continue: "Continue",
  preparingPayment: "Preparing payment",
  networkSummary: "{asset} will be sent on {network}.",
  chooseAssetNetwork: "Choose {asset} network",
  selectNetworkToContinue: "Select a network to continue",
  transactionDetails: "Transaction details",
} as const;

/**
 * One display row for post-settlement transaction details. Values are already
 * formatted for UI; `copyValue` is the full string when the display value is truncated.
 * Never includes NWC secrets — those are not part of checkout public state.
 */
export interface OpenReceiveTransactionDetailRow {
  readonly label: string;
  readonly value: string;
  readonly copyValue?: string;
}

export interface OpenReceiveTransactionDetailsInput {
  readonly order_id?: string;
  readonly checkout_id?: string;
  readonly invoice_id?: string;
  readonly invoice?: string | null;
  readonly rail?: "lightning" | "swap";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutInvoiceSnapshot["fiat_quote"];
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly expires_at?: number;
  readonly settled_at?: number;
  readonly swap?: CheckoutInvoiceSwapSnapshot;
}

export { orClasses } from "../ui-classes.ts";
export { openReceiveCompiledStyles };

export const openReceiveCheckoutElementStyles = `:host{display:block}${openReceiveCompiledStyles}`;
export const openReceiveThemeToggleElementStyles = openReceiveCheckoutElementStyles;

export const openReceivePaymentMethods: readonly OpenReceivePaymentMethodOption[] = [
  {
    id: "bitcoin",
    title: "Bitcoin",
    detail: "Pay from Lightning or send on-chain into a swap.",
  },
  {
    id: "crypto",
    title: "Crypto",
    detail: "Use stablecoins or altcoins through Lightning-capable services.",
  },
];

export const openReceiveRegionLabels: Readonly<Record<OpenReceiveRegionId, string>> = {
  "north-america": "North America",
  "latin-america": "Latin America",
  europe: "Europe",
  africa: "Africa",
  "middle-east": "Middle East",
  "asia-pacific": "Asia Pacific",
};

export const openReceiveRegionOrder: readonly OpenReceiveRegionId[] = [
  "north-america",
  "latin-america",
  "europe",
  "africa",
  "middle-east",
  "asia-pacific",
];

export function parseOpenReceiveOptionalInteger(
  value: string | null | undefined,
  options: ParseOpenReceiveOptionalIntegerOptions = {},
): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${options.label ?? "value"} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parseOpenReceiveBooleanAttribute(
  value: string | null | undefined,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return value !== "false";
}

export function parseOpenReceiveResolvedTheme(
  value: string | null | undefined,
): OpenReceiveResolvedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

export function parseOpenReceiveThemePreference(
  value: string | null | undefined,
): OpenReceiveThemePreference | undefined {
  return value === "light" || value === "dark" || value === "system" ? value : undefined;
}

export function parseOpenReceivePaymentMethod(
  value: string | null,
): OpenReceivePaymentMethod | null {
  return value === "bitcoin" || value === "crypto" ? value : null;
}
