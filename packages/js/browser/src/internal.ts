import {
  getAssets,
  getCountries,
  getCountryRoutes,
  getPaymentWizardRoutes,
  openReceivePayTutorialUrls,
  openReceiveProviderIconUrls,
  type AssetIndexEntry,
  type Country,
  type FiatRailId,
  type PaymentWizardRoute,
  type Provider,
  type ResolvedProviderRef,
} from "@openreceive/provider-data";
import { status as deriveStatus, type Status } from "./status.ts";
export { status, type Status, type StatusInvoiceLike } from "./status.ts";

export const OPENRECEIVE_QR_QUIET_ZONE_MODULES = 4 as const;
export const OPENRECEIVE_QR_DARK_COLOR = "#000000" as const;
export const OPENRECEIVE_QR_LIGHT_COLOR = "#FFFFFFFF" as const;
export const OPENRECEIVE_QR_ERROR_CORRECTION = "M" as const;
export const OPENRECEIVE_COUNTRY_STORAGE_KEY = "openreceive.checkout.country" as const;
export const OPENRECEIVE_LEGACY_DEMO_COUNTRY_STORAGE_KEY = "openreceive-demo.country" as const;
export const OPENRECEIVE_THEME_STORAGE_KEY = "openreceive.theme" as const;
export const OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS = 3000 as const;
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
export type OpenReceiveThemeToggleElementEventName =
  (typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS)[keyof typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS];
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

const bankIcon = new URL("./assets/icons/bank.svg", import.meta.url).href;
const bnbIcon = new URL("./assets/icons/bnb.svg", import.meta.url).href;
const btcIcon = new URL("./assets/icons/btc.svg", import.meta.url).href;
const cardIcon = new URL("./assets/icons/card.svg", import.meta.url).href;
const cryptoIcon = new URL("./assets/icons/crypto.svg", import.meta.url).href;
const dogeIcon = new URL("./assets/icons/doge.svg", import.meta.url).href;
const ethIcon = new URL("./assets/icons/eth.svg", import.meta.url).href;
const lightningIcon = new URL("./assets/icons/lightning.svg", import.meta.url).href;
const ltcIcon = new URL("./assets/icons/ltc.svg", import.meta.url).href;
const solIcon = new URL("./assets/icons/sol.svg", import.meta.url).href;
const trxIcon = new URL("./assets/icons/trx.svg", import.meta.url).href;
const usdcIcon = new URL("./assets/icons/usdc.svg", import.meta.url).href;
const usdtIcon = new URL("./assets/icons/usdt.svg", import.meta.url).href;
const xmrIcon = new URL("./assets/icons/xmr.svg", import.meta.url).href;
const xrpIcon = new URL("./assets/icons/xrp.svg", import.meta.url).href;

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
  card: "card",
  bank: "bank",
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

export interface CheckoutInvoiceSnapshot {
  readonly invoice_id: string;
  readonly invoice: string;
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
}

export interface CheckoutDisplayData {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly invoice: string;
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
  invoiceId: "invoice-id",
  invoice: "invoice",
  paymentHash: "payment-hash",
  amountMsats: "amount-msats",
  fiatCurrency: "fiat-currency",
  fiatValue: "fiat-value",
  status: "status",
  expiresAt: "expires-at",
  statusUrl: "status-url",
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
  readonly statusUrl?: string;
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

export type CheckoutStatusRefresh = (order_id: string) => Promise<CheckoutSnapshot | null>;

export type RequestCheckoutAmount =
  | {
      readonly btc: {
        readonly currency: "BTC" | "SAT" | "SATS";
        readonly value: string;
      };
    }
  | {
      readonly fiat: {
        readonly currency: string;
        readonly value: string;
      };
    };

export interface RequestCheckoutOptions {
  readonly checkoutUrl: string | ((orderId: string) => string);
  readonly order_id: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly amount: RequestCheckoutAmount;
  readonly memo?: string;
  readonly description_hash?: string;
  readonly expires_in_seconds?: number;
}

export interface CreateOpenReceiveStatusFetcherOptions {
  readonly statusUrl: string;
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
  readonly onError?: (error: unknown) => void;
}

export interface CheckoutControllerOptions extends Omit<CheckoutWatcherOptions, "onState"> {
  readonly onState?: (state: CheckoutState) => void;
  readonly statusUrl?: string;
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

export interface CreateCheckoutStateOptions {
  readonly now?: number;
  readonly logger?: OpenReceiveBrowserLogger;
}

export type OpenReceivePaymentMethod = "card" | "bank" | "bitcoin" | "crypto";
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
      readonly storedCountryCode?: string | null;
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
} as const;

export const openReceiveCheckoutElementStyles = `
  :host {
    --or-bg: #ffffff;
    --or-bg-soft: #fafafa;
    --or-text: #171717;
    --or-muted: #525252;
    --or-border: #d4d4d4;
    --or-warm: #f97316;
    --or-good-bg: #e8f5ee;
    --or-good: #11613b;
    color: var(--or-text);
    display: block;
    font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  :host([theme="dark"]),
  [part="root"][data-theme="dark"] {
    --or-bg: #1c2230;
    --or-bg-soft: #121620;
    --or-text: #f7f8fb;
    --or-muted: #b7c0cf;
    --or-border: #333c4d;
    --or-warm: #ff9f1c;
    --or-good-bg: #173828;
    --or-good: #86efac;
  }

  [part="root"] {
    background: var(--or-bg);
    border: 1px solid var(--or-border);
    border-radius: 8px;
    display: grid;
    gap: 12px;
    padding: 12px;
  }

  [part="qr"] {
    aspect-ratio: 1;
    align-items: center;
    background: #ffffff;
    border: 1px solid var(--or-border);
    border-radius: 6px;
    display: flex;
    justify-content: center;
    justify-self: center;
    min-width: 0;
    overflow: hidden;
    width: min(100%, 420px);
  }

  [part="qr"] svg {
    display: block;
    height: 100%;
    width: 100%;
  }

  [part="meta"] {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  [part="state"] {
    background: var(--or-good-bg);
    border-radius: 999px;
    color: var(--or-good);
    padding: 2px 8px;
  }

  [part="payment-hash"] {
    color: var(--or-muted);
    font-size: 12px;
  }

  [part="invoice"] {
    background: var(--or-bg-soft);
    border: 1px solid var(--or-border);
    border-radius: 6px;
    box-sizing: border-box;
    color: var(--or-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-height: 68px;
    overflow-wrap: anywhere;
    padding: 8px;
    resize: vertical;
    width: 100%;
  }

  [part="status"] {
    align-items: center;
    background: var(--or-bg-soft);
    border: 1px solid var(--or-border);
    border-radius: 6px;
    display: flex;
    gap: 10px;
    padding: 8px;
  }

  [part="status"] p {
    color: var(--or-muted);
    margin: 2px 0 0;
  }

  [part="spinner"] {
    border: 3px solid var(--or-border);
    border-radius: 999px;
    border-top-color: var(--or-text);
    flex: 0 0 auto;
    height: 22px;
    width: 22px;
    animation: openreceive-spin 850ms linear infinite;
  }

  [part="countdown"] {
    color: var(--or-muted);
  }

  [part="actions"] {
    display: grid;
    gap: 8px;
  }

  [part="wizard"] {
    border-top: 1px solid var(--or-border);
    display: grid;
    gap: 12px;
    padding-top: 12px;
  }

  [part="wizard"] h2,
  [part="wizard"] h3,
  [part="wizard"] h4,
  [part="wizard"] p {
    margin: 0;
  }

  [part="wizard"] p,
  [part="wizard"] small {
    color: var(--or-muted);
  }

	  [part="method-grid"],
	  [part="route-picker"],
	  [part="country-grid"],
	  [part="provider-grid"],
	  [part="provider-actions"] {
    display: grid;
    gap: 8px;
  }

  [part="method-grid"],
  [part="route-picker"],
  [part="country-grid"],
  [part="provider-grid"],
  [part="provider-actions"] {
    grid-template-columns: 1fr 1fr;
  }

	  [part="method"],
	  [part="route"],
	  [part="country"],
  [part="provider"] {
    background: var(--or-bg);
    border: 1px solid var(--or-border);
    border-radius: 6px;
    box-sizing: border-box;
    color: var(--or-text);
  }

  [part="method"],
  [part="route"],
  [part="country"],
  [part="provider"] {
    display: grid;
    gap: 4px;
    min-height: 64px;
    padding: 8px;
    text-align: left;
  }

  [part="method"] img,
  [part="route"] img {
    height: 28px;
    width: 28px;
  }

  [part~="selected"] {
    border-color: var(--or-text);
    box-shadow: 0 0 0 1px var(--or-text);
  }

  [part="country-summary"] {
    align-items: center;
    border: 1px solid var(--or-border);
    border-radius: 6px;
    display: flex;
    gap: 8px;
    justify-content: space-between;
    padding: 8px;
  }

	  [part="wizard-results"] {
	    display: grid;
	    gap: 12px;
	  }

  [part="wizard-breadcrumbs"] {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  [part="wizard-breadcrumb"] {
    background: transparent;
    border: 0;
    color: var(--or-muted);
    gap: 6px;
    min-height: 32px;
    padding: 0;
  }

  [part="wizard-breadcrumb"]:hover {
    color: var(--or-text);
  }

  [part="wizard-breadcrumb-current"] {
    color: var(--or-text);
    font-weight: 700;
  }

  [part="wizard-breadcrumb-separator"] {
    color: var(--or-muted);
  }

  [part="wizard-route"] {
    display: grid;
    gap: 18px;
  }

  [part="wizard-route"] h3 {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  [part="country-select"] {
    align-items: center;
    display: inline-flex;
    font-size: 0.78em;
    gap: 6px;
  }

  [part="country-select"] span {
    clip: rect(0 0 0 0);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  [part="country-select"] select {
    background: var(--or-bg);
    border: 1px solid var(--or-border);
    border-radius: 6px;
    color: var(--or-text);
    font: inherit;
    min-height: 34px;
    padding: 0 8px;
  }

	  [part="provider"] {
	    align-items: center;
	    column-gap: 10px;
	    display: grid;
	    grid-template-columns: minmax(0, 1fr) auto auto;
	    min-height: 0;
	    row-gap: 4px;
	  }

  [part="provider-badges"] {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  [part="provider-heading"] {
    align-items: center;
    display: flex;
    gap: 8px;
    grid-column: 1;
    justify-content: start;
    min-width: 0;
  }

  [part="provider-heading"] img {
    border-radius: 6px;
    flex: 0 0 auto;
    height: 28px;
    width: 28px;
  }

  [part="provider-heading"] h4 {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  [part="provider-kind"] {
    grid-column: 1;
    color: var(--or-muted);
    font-size: 0.9em;
    line-height: 1.3;
    margin: -2px 0 0;
  }

  [part="provider-badges"] span,
  [part="recommended"] {
    background: var(--or-bg-soft);
    border-radius: 999px;
    color: var(--or-muted);
    font-size: 12px;
    grid-column: 2;
    justify-self: end;
    padding: 2px 7px;
    white-space: nowrap;
  }

  button,
  a[part="open"],
  button[part="provider-open"] {
    align-items: center;
    border: 1px solid var(--or-text);
    border-radius: 6px;
    box-sizing: border-box;
    color: var(--or-text);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    justify-content: center;
    min-height: 40px;
    padding: 8px 10px;
    text-decoration: none;
  }

  button {
    background: var(--or-bg);
  }

  a[part="open"],
  button[part="provider-open"] {
    background: var(--or-text);
    color: var(--or-bg);
  }

  [part="provider-actions"] {
    align-self: center;
    display: flex;
    grid-column: 3;
    grid-row: 1 / span 2;
    justify-self: end;
  }

  button[part="provider-open"],
  [part="provider-actions"] a {
    background: var(--or-bg-soft);
    color: var(--or-text);
    min-height: 36px;
    padding: 7px 12px;
    white-space: nowrap;
  }

  [part="tutorial"] {
    align-items: center;
    background: rgb(0 0 0 / 0.6);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 16px;
    position: fixed;
    z-index: 10;
  }

  [part="tutorial"][hidden] {
    display: none;
  }

  [part="tutorial-dialog"] {
    background: var(--or-bg);
    border: 1px solid var(--or-border);
    border-radius: 8px;
    box-shadow: 0 20px 70px rgb(0 0 0 / 0.32);
    box-sizing: border-box;
    display: grid;
    gap: 12px;
    max-height: min(92vh, 900px);
    max-width: min(440px, 100%);
    min-width: 0;
    overflow: hidden;
    padding: 12px;
    width: 100%;
  }

  [part="tutorial-header"],
  [part="tutorial-controls"] {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  [part="tutorial-header"] h3 {
    font-size: 16px;
    line-height: 1.25;
    min-width: 0;
  }

  [part="tutorial-title"] {
    align-items: center;
    display: flex;
    gap: 10px;
    min-width: 0;
  }

  [part="tutorial-header-logo"] {
    border-radius: 8px;
    flex: 0 0 auto;
    height: 36px;
    width: 36px;
  }

  [part="tutorial-close"] {
    background: var(--or-bg-soft);
    border-color: var(--or-border);
    color: var(--or-text);
    flex: 0 0 auto;
    font-size: 16px;
    font-weight: 700;
    height: 36px;
    min-height: 36px;
    padding: 0;
    width: 36px;
  }

  [part="tutorial-frame"] {
    align-items: center;
    background: var(--or-bg-soft);
    border: 1px solid var(--or-border);
    border-radius: 8px;
    display: flex;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
  }

  [part="tutorial-image"] {
    display: block;
    height: auto;
    max-height: min(66vh, 720px);
    max-width: 100%;
    object-fit: contain;
    width: auto;
  }

  [part="tutorial-caption"] {
    color: var(--or-text);
    font-size: 16px;
    font-weight: 700;
    text-align: center;
  }

  [part="tutorial-intro"] {
    display: grid;
    gap: 12px;
    padding: 16px 8px;
    text-align: center;
  }

  [part="tutorial-provider-logo"] {
    border-radius: 8px;
    height: 52px;
    justify-self: center;
    width: 52px;
  }

  [part="tutorial-intro"] p {
    color: var(--or-text);
    font-size: 15px;
  }

  [part="tutorial-copy"] {
    background: var(--or-warm);
    border-color: var(--or-warm);
    color: #111827;
    justify-self: center;
    min-width: min(240px, 100%);
  }

  [part="tutorial-copy-message"] {
    color: var(--or-good);
    font-weight: 700;
  }

  [part="tutorial-progress"] {
    color: var(--or-muted);
    font-size: 12px;
    text-align: center;
  }

  [part="tutorial-steps"] {
    display: flex;
    gap: 6px;
    justify-content: center;
  }

  [part="tutorial-step"],
  [part="tutorial-step-active"] {
    background: var(--or-border);
    border-radius: 999px;
    height: 7px;
    width: 7px;
  }

  [part="tutorial-step-active"] {
    background: var(--or-text);
  }

  [part="tutorial-nav"] {
    flex: 1 1 0;
  }

  [part="tutorial-controls"] [part="tutorial-nav"]:last-child:not(:disabled) {
    background: var(--or-warm);
    border-color: var(--or-warm);
    color: #111827;
  }

  [part="tutorial-nav"]:disabled {
    background: var(--or-bg-soft);
    border-color: var(--or-border);
    color: var(--or-muted);
    cursor: not-allowed;
  }

	  @media (max-width: 420px) {
	    [part="method-grid"],
	    [part="route-picker"],
	    [part="country-grid"],
    [part="provider-grid"],
    [part="provider-actions"] {
      grid-template-columns: 1fr;
    }

    [part="tutorial"] {
      align-items: stretch;
      padding: 8px;
    }

    [part="tutorial-dialog"] {
      max-height: calc(100vh - 16px);
    }

    [part="tutorial-controls"] {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
  }

  @keyframes openreceive-spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

export const openReceiveThemeToggleElementStyles = `
  :host {
    display: inline-block;
  }

	  button {
	    align-items: center;
	    background: var(--or-theme-toggle-bg, transparent);
	    border: var(--or-theme-toggle-border, 1px solid currentColor);
	    border-radius: var(--or-theme-toggle-radius, 999px);
	    color: inherit;
	    cursor: pointer;
	    display: inline-flex;
	    gap: 8px;
	    font: inherit;
	    min-height: var(--or-theme-toggle-min-height, 34px);
	    padding: var(--or-theme-toggle-padding, 4px 12px 4px 4px);
	  }

	  .or-theme-toggle-track {
	    align-items: center;
	    background: transparent;
	    border: 0;
	    border-radius: 999px;
	    display: grid;
	    flex: 0 0 auto;
	    grid-template-columns: 1fr;
	    height: 24px;
	    padding: 0;
	    width: 24px;
	  }

	  .or-theme-toggle-icon {
	    border-radius: 999px;
	    display: block;
	    grid-area: 1 / 1;
	    height: 24px;
	    position: relative;
	    transition: background 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
	    width: 24px;
	  }

	  .or-theme-toggle-icon-light {
	    opacity: 1;
	  }

	  .or-theme-toggle-dark .or-theme-toggle-icon-light {
	    background: #94a3b8;
	    box-shadow: none;
	    opacity: 0.72;
	  }

	  .or-theme-toggle-label {
	    font-size: 14px;
	    font-weight: 700;
	    line-height: 1;
	    white-space: nowrap;
	  }

  .or-theme-toggle-icon-light {
    background: #facc15;
    box-shadow: 0 0 0 2px rgb(250 204 21 / 0.2);
  }

  .or-theme-toggle-icon-light::before,
  .or-theme-toggle-icon-light::after {
    content: "";
    position: absolute;
  }

  .or-theme-toggle-icon-light::before {
    border: 2px solid rgb(255 255 255 / 0.72);
    border-radius: 999px;
    inset: 5px;
  }

  .or-theme-toggle-icon-light::after {
    background:
      radial-gradient(circle, transparent 50%, #facc15 52%),
      conic-gradient(
        from 0deg,
        transparent 0 8deg,
        rgb(255 255 255 / 0.75) 8deg 14deg,
        transparent 14deg 45deg,
        rgb(255 255 255 / 0.75) 45deg 51deg,
        transparent 51deg 82deg,
        rgb(255 255 255 / 0.75) 82deg 88deg,
        transparent 88deg 127deg,
        rgb(255 255 255 / 0.75) 127deg 133deg,
        transparent 133deg 172deg,
        rgb(255 255 255 / 0.75) 172deg 178deg,
        transparent 178deg 217deg,
        rgb(255 255 255 / 0.75) 217deg 223deg,
        transparent 223deg 262deg,
        rgb(255 255 255 / 0.75) 262deg 268deg,
        transparent 268deg 307deg,
        rgb(255 255 255 / 0.75) 307deg 313deg,
        transparent 313deg 360deg
      );
    border-radius: 999px;
    inset: 3px;
  }

`;

export const openReceivePaymentMethods: readonly OpenReceivePaymentMethodOption[] = [
  {
    id: "card",
    title: "Credit Card",
    detail: "Pick your country, then use a card-friendly provider.",
  },
  {
    id: "bank",
    title: "Bank Transfer",
    detail: "Choose a country for local bank rails and cash apps.",
  },
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
  return value === "card" || value === "bank" || value === "bitcoin" || value === "crypto"
    ? value
    : null;
}

export function parseOpenReceiveRegion(value: string | null): OpenReceiveRegionId | null {
  return openReceiveRegionOrder.includes(value as OpenReceiveRegionId)
    ? (value as OpenReceiveRegionId)
    : null;
}

export const openReceiveCountryMapRegions = [
  {
    id: "north-america",
    cx: 180,
    cy: 125,
    rx: 150,
    ry: 78,
  },
  {
    id: "latin-america",
    cx: 265,
    cy: 260,
    rx: 82,
    ry: 130,
  },
  {
    id: "europe",
    cx: 425,
    cy: 145,
    rx: 105,
    ry: 64,
  },
  {
    id: "africa",
    cx: 455,
    cy: 255,
    rx: 76,
    ry: 102,
  },
  {
    id: "middle-east",
    cx: 535,
    cy: 213,
    rx: 78,
    ry: 58,
  },
  {
    id: "asia-pacific",
    cx: 655,
    cy: 215,
    rx: 165,
    ry: 120,
  },
] as const satisfies ReadonlyArray<{
  readonly id: OpenReceiveRegionId;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}>;

export const openReceiveCountryPins: Readonly<Record<string, OpenReceiveCountryMapPin>> = {
  AR: { region: "latin-america", coordinates: [-64, -34] },
  AU: { region: "asia-pacific", coordinates: [134, -25] },
  BD: { region: "asia-pacific", coordinates: [90, 24] },
  BR: { region: "latin-america", coordinates: [-52, -10] },
  CA: { region: "north-america", coordinates: [-106, 56] },
  CH: { region: "europe", coordinates: [8, 47] },
  CL: { region: "latin-america", coordinates: [-71, -30] },
  CO: { region: "latin-america", coordinates: [-74, 4] },
  DE: { region: "europe", coordinates: [10, 51] },
  EG: { region: "africa", coordinates: [30, 27] },
  ES: { region: "europe", coordinates: [-4, 40] },
  FR: { region: "europe", coordinates: [2, 47] },
  GB: { region: "europe", coordinates: [-2, 54] },
  GH: { region: "africa", coordinates: [-1, 8] },
  IE: { region: "europe", coordinates: [-8, 53] },
  ID: { region: "asia-pacific", coordinates: [118, -2] },
  IN: { region: "asia-pacific", coordinates: [78, 22] },
  IT: { region: "europe", coordinates: [12, 43] },
  JP: { region: "asia-pacific", coordinates: [138, 37] },
  KE: { region: "africa", coordinates: [38, 0] },
  KR: { region: "asia-pacific", coordinates: [128, 36] },
  MX: { region: "latin-america", coordinates: [-102, 23] },
  NG: { region: "africa", coordinates: [8, 9] },
  NL: { region: "europe", coordinates: [5, 52] },
  PH: { region: "asia-pacific", coordinates: [122, 13] },
  PK: { region: "asia-pacific", coordinates: [70, 30] },
  PL: { region: "europe", coordinates: [19, 52] },
  PT: { region: "europe", coordinates: [-8, 39] },
  SA: { region: "middle-east", coordinates: [45, 24] },
  SG: { region: "asia-pacific", coordinates: [104, 1.3] },
  SV: { region: "latin-america", coordinates: [-89, 13.8] },
  TH: { region: "asia-pacific", coordinates: [101, 15] },
  TR: { region: "middle-east", coordinates: [35, 39] },
  UA: { region: "europe", coordinates: [31, 49] },
  US: { region: "north-america", coordinates: [-98, 39] },
  VE: { region: "latin-america", coordinates: [-66, 7] },
  VN: { region: "asia-pacific", coordinates: [108, 16] },
  ZA: { region: "africa", coordinates: [24, -29] },
  AE: { region: "middle-east", coordinates: [54, 24] },
};

export function getOpenReceiveDefaultCountryCode(): string {
  return (
    getCountries().find((country) => country.code === "US")?.code ?? getCountries()[0]?.code ?? ""
  );
}

export function getOpenReceiveBitcoinAssets(): readonly AssetIndexEntry[] {
  return getAssets().filter((asset) => asset.symbol === "btc" && asset.route !== undefined);
}

function getOpenReceiveDefaultBitcoinRoute(): string | null {
  const routes = [
    ...new Set(
      getOpenReceiveBitcoinAssets().flatMap((asset) =>
        asset.route === undefined ? [] : [asset.route],
      ),
    ),
  ];
  return routes.length === 1 ? (routes[0] ?? null) : null;
}

export function getOpenReceiveAltcoinAssets(): readonly AssetIndexEntry[] {
  return getAssets().filter(
    (asset) =>
      asset.route !== undefined &&
      asset.symbol !== "btc" &&
      !["usd", "eur", "gbp"].includes(asset.symbol),
  );
}

export function getOpenReceiveRegionForCountry(countryCode: string): OpenReceiveRegionId {
  return openReceiveCountryPins[countryCode]?.region ?? "north-america";
}

export function getOpenReceiveCoverageLabel(coverage: Country["coverage"]): string {
  void coverage;
  return "";
}

export function formatOpenReceiveCountryMetaLabel(country: Country): string {
  return country.currency;
}

export function createOpenReceiveCountryDisplay(
  country: Country,
  options: { readonly selectedCountryCode?: string } = {},
): OpenReceiveCountryDisplay {
  return {
    country,
    code: country.code,
    label: country.name,
    metaLabel: formatOpenReceiveCountryMetaLabel(country),
    selected: country.code === options.selectedCountryCode,
  };
}

export function getOpenReceivePaymentStatusText(phase: CheckoutPhase): {
  readonly title: string;
  readonly detail: string;
} {
  if (phase === "settled") {
    return {
      title: openReceiveCheckoutLabels.paymentStatus.settledTitle,
      detail: openReceiveCheckoutLabels.paymentStatus.settledDetail,
    };
  }
  if (phase === "expired") {
    return {
      title: openReceiveCheckoutLabels.paymentStatus.expiredTitle,
      detail: openReceiveCheckoutLabels.paymentStatus.expiredDetail,
    };
  }
  return {
    title: openReceiveCheckoutLabels.paymentStatus.waitingTitle,
    detail: openReceiveCheckoutLabels.paymentStatus.waitingDetail,
  };
}

export function getOpenReceiveWizardEmptyMessage(method: OpenReceivePaymentMethod | null): string {
  if (method === "bitcoin") return openReceiveCheckoutLabels.emptyBitcoin;
  if (method === "crypto") return openReceiveCheckoutLabels.emptyCrypto;
  return openReceiveCheckoutLabels.emptyFiat;
}

export function getCheckoutProviderUsBadge(us: boolean | null): string | null {
  void us;
  return null;
}

export function getCheckoutProviderOpenLabel(providerName: string): string {
  void providerName;
  return openReceiveCheckoutLabels.openProvider;
}

export function getCheckoutProviderIcon(provider: Pick<Provider, "icon_path">): string {
  return openReceiveProviderIconUrls[provider.icon_path] ?? openReceivePaymentIconUrls.crypto;
}

export function getCheckoutProviderTutorials(
  provider: Pick<Provider, "tutorials">,
): readonly OpenReceiveWizardProviderTutorialDisplay[] {
  return (provider.tutorials ?? []).map((tutorial) => ({
    index: tutorial.index,
    path: tutorial.path,
    image: openReceivePayTutorialUrls[tutorial.path] ?? tutorial.path,
    caption: tutorial.caption,
  }));
}

export function getOpenReceiveRouteNetworkLabel(routeId: string): string {
  return routeId === "lightning" || routeId === "btc-lightning"
    ? openReceiveCheckoutLabels.lightningNetwork
    : routeId;
}

export function createOpenReceiveWizardRouteAssetDisplays(
  assets: readonly AssetIndexEntry[],
  options: {
    readonly selectedRoute?: string | null;
  } = {},
): readonly OpenReceiveWizardRouteAssetDisplay[] {
  return assets.map((asset) => {
    const id = asset.route ?? asset.symbol;
    return {
      id,
      label: asset.label,
      subtitle: getOpenReceiveRouteNetworkLabel(id),
      icon: getOpenReceiveRouteIcon(asset),
      selected: options.selectedRoute === id,
    };
  });
}

export function createOpenReceiveWizardRouteDisplays(
  routes: readonly PaymentWizardRoute[],
  options: {
    readonly providerPreviewLimit?: number;
  } = {},
): readonly OpenReceiveWizardRouteDisplay[] {
  return routes.map((route) => ({
    key: getOpenReceiveWizardRouteDisplayKey(route),
    title: getOpenReceiveWizardRouteDisplayTitle(route),
    subtitle: getOpenReceiveWizardRouteDisplaySubtitle(route),
    providers: (options.providerPreviewLimit === undefined
      ? route.providers
      : route.providers.slice(0, options.providerPreviewLimit)
    ).map((entry) => createOpenReceiveWizardProviderDisplay(entry)),
  }));
}

function getOpenReceiveWizardRouteDisplayKey(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.id : `${route.rail.id}:${route.country.code}`;
}

function getOpenReceiveWizardRouteDisplayTitle(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.label : route.rail.label;
}

function getOpenReceiveWizardRouteDisplaySubtitle(route: PaymentWizardRoute): string {
  return route.kind === "crypto" ? route.route.symbol.toUpperCase() : route.country.currency;
}

function createOpenReceiveWizardProviderDisplay(
  entry: ResolvedProviderRef,
): OpenReceiveWizardProviderDisplay {
  return {
    id: entry.provider.id,
    name: entry.provider.name,
    kind: entry.provider.kind,
    url: entry.provider.lightning_docs_url ?? entry.provider.url,
    icon: getCheckoutProviderIcon(entry.provider),
    tutorials: getCheckoutProviderTutorials(entry.provider),
    recommended: entry.flagship,
    recommendedLabel: entry.flagship ? openReceiveCheckoutLabels.recommended : null,
    usBadge: null,
    copyLabel: openReceiveCheckoutLabels.copyInvoice,
    copiedLabel: openReceiveCheckoutLabels.copied,
    openLabel: getCheckoutProviderOpenLabel(entry.provider.name),
  };
}

export function getOpenReceivePaymentMethodIcon(method: OpenReceivePaymentMethod): string {
  return openReceivePaymentIconUrls[openReceivePaymentMethodIconIds[method]];
}

export function getOpenReceiveAssetIcon(symbol: string): string {
  return openReceivePaymentIconUrls[openReceiveAssetIconIds[symbol] ?? "crypto"];
}

export function getOpenReceiveRouteIcon(asset: Pick<AssetIndexEntry, "route" | "symbol">): string {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) {
    return openReceivePaymentIconUrls.lightning;
  }
  return getOpenReceiveAssetIcon(asset.symbol);
}

export function getOpenReceiveCountriesForRail(rail: FiatRailId): readonly Country[] {
  return getCountries()
    .filter(
      (country) =>
        openReceiveCountryPins[country.code] !== undefined &&
        getCountryRoutes(country.code).some((route) => route.rail.id === rail),
    )
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
}

export function projectOpenReceiveCountryMapPoint(
  coordinates: readonly [number, number],
  options: {
    readonly width?: number;
    readonly height?: number;
  } = {},
): readonly [number, number] {
  const width = options.width ?? OPENRECEIVE_COUNTRY_MAP_WIDTH;
  const height = options.height ?? OPENRECEIVE_COUNTRY_MAP_HEIGHT;
  const longitude = Math.max(-180, Math.min(180, coordinates[0]));
  const latitude = Math.max(-85, Math.min(85, coordinates[1]));
  return [((longitude + 180) / 360) * width, ((85 - latitude) / 170) * height];
}

export function createOpenReceiveCountryPickerModel(
  request: OpenReceiveCountryPickerModelRequest,
): OpenReceiveCountryPickerModel {
  const selectedCountry = request.countries.find(
    (country) => country.code === request.selectedCountryCode,
  );
  const hoveredCountry =
    request.hoveredCountryCode === undefined || request.hoveredCountryCode === null
      ? undefined
      : request.countries.find((country) => country.code === request.hoveredCountryCode);
  const visibleRegionCountries = request.countries.filter(
    (country) => getOpenReceiveRegionForCountry(country.code) === request.selectedRegion,
  );
  const selectedCountryDisplay =
    selectedCountry === undefined
      ? undefined
      : createOpenReceiveCountryDisplay(selectedCountry, {
          selectedCountryCode: request.selectedCountryCode,
        });
  const hoveredCountryDisplay =
    hoveredCountry === undefined
      ? undefined
      : createOpenReceiveCountryDisplay(hoveredCountry, {
          selectedCountryCode: request.selectedCountryCode,
        });
  const visibleRegionCountryDisplays = visibleRegionCountries.map((country) =>
    createOpenReceiveCountryDisplay(country, {
      selectedCountryCode: request.selectedCountryCode,
    }),
  );
  const regions = openReceiveRegionOrder.map((region) => {
    const count = request.countries.filter(
      (country) => getOpenReceiveRegionForCountry(country.code) === region,
    ).length;
    return {
      id: region,
      label: openReceiveRegionLabels[region],
      count,
      enabled: count > 0,
      selected: region === request.selectedRegion,
    };
  });
  const mapCountries = request.countries.flatMap((country) => {
    const pin = openReceiveCountryPins[country.code];
    if (pin === undefined) return [];
    return [
      {
        country,
        region: pin.region,
        coordinates: pin.coordinates,
        point: projectOpenReceiveCountryMapPoint(pin.coordinates),
        selected: country.code === request.selectedCountryCode,
        hovered: country.code === request.hoveredCountryCode,
        label: country.name,
        metaLabel: formatOpenReceiveCountryMetaLabel(country),
      },
    ];
  });

  return {
    countries: request.countries,
    regions,
    selectedCountry,
    hoveredCountry,
    ...(selectedCountryDisplay === undefined ? {} : { selectedCountryDisplay }),
    ...(hoveredCountryDisplay === undefined ? {} : { hoveredCountryDisplay }),
    readoutLabel:
      hoveredCountryDisplay?.label ??
      selectedCountryDisplay?.label ??
      openReceiveCheckoutLabels.chooseCountry,
    ...((hoveredCountryDisplay ?? selectedCountryDisplay) === undefined
      ? {}
      : { readoutMetaLabel: (hoveredCountryDisplay ?? selectedCountryDisplay)?.metaLabel }),
    visibleRegionCountries,
    visibleRegionCountryDisplays,
    mapCountries,
  };
}

export function createOpenReceivePaymentWizardState(
  request: OpenReceivePaymentWizardRequest,
): OpenReceivePaymentWizardState {
  const selectedRail = getRailForPaymentMethod(request.selectedMethod);
  const railCountries = selectedRail === null ? [] : getOpenReceiveCountriesForRail(selectedRail);
  const selectedCountry =
    request.selectedCountryCode === undefined
      ? railCountries[0]
      : (railCountries.find((country) => country.code === request.selectedCountryCode) ??
        railCountries[0]);
  const selectedRouteId =
    request.selectedMethod === "bitcoin"
      ? (request.selectedBitcoinRoute ?? getOpenReceiveDefaultBitcoinRoute())
      : request.selectedMethod === "crypto"
        ? (request.selectedCryptoRoute ?? null)
        : null;
  const routes =
    selectedRail !== null && selectedCountry !== undefined
      ? getPaymentWizardRoutes({
          country: selectedCountry.code,
          rail: selectedRail,
        })
      : selectedRouteId === null
        ? []
        : getPaymentWizardRoutes({ route: selectedRouteId });

  return {
    selectedRail,
    ...(selectedCountry === undefined ? {} : { selectedCountry }),
    railCountries,
    selectedRouteId,
    routes,
  };
}

export function createOpenReceivePaymentWizardSelection(
  options: {
    readonly storedCountryCode?: string | null;
    readonly defaultCountryCode?: string;
  } = {},
): OpenReceivePaymentWizardSelection {
  const selectedCountryCode =
    options.storedCountryCode ?? options.defaultCountryCode ?? getOpenReceiveDefaultCountryCode();
  return {
    selectedMethod: null,
    selectedCountryCode,
    selectedBitcoinRoute: null,
    selectedCryptoRoute: null,
    selectedRegion: getOpenReceiveRegionForCountry(selectedCountryCode),
    countryPickerOpen:
      options.storedCountryCode === undefined ? true : options.storedCountryCode === null,
  };
}

export function createOpenReceivePaymentWizardModel(
  selection: OpenReceivePaymentWizardSelection,
): OpenReceivePaymentWizardModel {
  const wizard = createOpenReceivePaymentWizardState({
    selectedMethod: selection.selectedMethod,
    selectedCountryCode: selection.selectedCountryCode,
    selectedBitcoinRoute: selection.selectedBitcoinRoute,
    selectedCryptoRoute: selection.selectedCryptoRoute,
  });
  const routeAssets =
    selection.selectedMethod === "bitcoin"
      ? getOpenReceiveBitcoinAssets()
      : selection.selectedMethod === "crypto"
        ? getOpenReceiveAltcoinAssets()
        : [];
  const selectedRoute = wizard.selectedRouteId;
  const countryPicker = createOpenReceiveCountryPickerModel({
    countries: wizard.railCountries,
    selectedCountryCode: selection.selectedCountryCode,
    selectedRegion: selection.selectedRegion,
  });
  const countryDisplays = wizard.railCountries.map((country) =>
    createOpenReceiveCountryDisplay(country, {
      selectedCountryCode: selection.selectedCountryCode,
    }),
  );

  return {
    selection,
    wizard,
    countryPicker,
    countryDisplays,
    visibleRegionCountries: countryPicker.visibleRegionCountries,
    visibleRegionCountryDisplays: countryPicker.visibleRegionCountryDisplays,
    ...(countryPicker.selectedCountryDisplay === undefined
      ? {}
      : { selectedCountryDisplay: countryPicker.selectedCountryDisplay }),
    routeAssets,
    selectedRoute,
  };
}

export function updateOpenReceivePaymentWizardSelection(
  selection: OpenReceivePaymentWizardSelection,
  action: OpenReceivePaymentWizardSelectionAction,
): OpenReceivePaymentWizardSelection {
  switch (action.type) {
    case "select_method": {
      if (action.method !== "card" && action.method !== "bank") {
        return {
          ...selection,
          selectedMethod: action.method,
          selectedBitcoinRoute:
            action.method === "bitcoin"
              ? (selection.selectedBitcoinRoute ?? getOpenReceiveDefaultBitcoinRoute())
              : selection.selectedBitcoinRoute,
          countryPickerOpen: false,
        };
      }

      const selectedCountryCode = action.storedCountryCode ?? selection.selectedCountryCode;
      return {
        ...selection,
        selectedMethod: action.method,
        selectedCountryCode,
        selectedRegion: getOpenReceiveRegionForCountry(selectedCountryCode),
        countryPickerOpen: false,
      };
    }
    case "change_method": {
      return {
        ...selection,
        selectedMethod: null,
        selectedBitcoinRoute: null,
        selectedCryptoRoute: null,
        countryPickerOpen: false,
      };
    }
    case "change_route": {
      if (selection.selectedMethod === "bitcoin") {
        return {
          ...selection,
          selectedBitcoinRoute: null,
        };
      }
      if (selection.selectedMethod === "crypto") {
        return {
          ...selection,
          selectedCryptoRoute: null,
        };
      }
      return selection;
    }
    case "select_region": {
      const nextSelection = {
        ...selection,
        selectedRegion: action.region,
      };
      const regionCountries = createOpenReceivePaymentWizardModel(
        nextSelection,
      ).wizard.railCountries.filter(
        (country) => getOpenReceiveRegionForCountry(country.code) === action.region,
      );
      if (regionCountries.some((country) => country.code === selection.selectedCountryCode)) {
        return nextSelection;
      }
      const first = regionCountries[0];
      return first === undefined
        ? nextSelection
        : {
            ...nextSelection,
            selectedCountryCode: first.code,
          };
    }
    case "select_country": {
      return {
        ...selection,
        selectedCountryCode: action.countryCode,
        selectedRegion: getOpenReceiveRegionForCountry(action.countryCode),
        countryPickerOpen: false,
      };
    }
    case "open_country_picker": {
      return {
        ...selection,
        countryPickerOpen: true,
      };
    }
    case "select_route": {
      if (selection.selectedMethod === "bitcoin") {
        return {
          ...selection,
          selectedBitcoinRoute: action.route,
        };
      }
      if (selection.selectedMethod === "crypto") {
        return {
          ...selection,
          selectedCryptoRoute: action.route,
        };
      }
      return selection;
    }
  }
}

export class OpenReceiveBrowserPaymentWizardController
  implements OpenReceivePaymentWizardController
{
  private readonly options: OpenReceivePaymentWizardControllerOptions;
  private selection: OpenReceivePaymentWizardSelection;

  constructor(options: OpenReceivePaymentWizardControllerOptions = {}) {
    this.options = options;
    this.selection =
      options.selection ??
      createOpenReceivePaymentWizardSelection({
        storedCountryCode:
          options.storedCountryCode ??
          readOpenReceiveStoredCountryCode({
            storage: options.storage,
            storageKey: options.storageKey,
          }),
        defaultCountryCode: options.defaultCountryCode,
      });
  }

  getSelection(): OpenReceivePaymentWizardSelection {
    return this.selection;
  }

  getModel(): OpenReceivePaymentWizardModel {
    return createOpenReceivePaymentWizardModel(this.selection);
  }

  update(action: OpenReceivePaymentWizardSelectionAction): OpenReceivePaymentWizardSelection {
    const normalizedAction =
      action.type === "select_method" &&
      (action.method === "card" || action.method === "bank") &&
      action.storedCountryCode === undefined
        ? {
            ...action,
            storedCountryCode: readOpenReceiveStoredCountryCode({
              storage: this.options.storage,
              storageKey: this.options.storageKey,
            }),
          }
        : action;
    const next = updateOpenReceivePaymentWizardSelection(this.selection, normalizedAction);
    if (action.type === "select_country") {
      writeOpenReceiveStoredCountryCode(action.countryCode, {
        storage: this.options.storage,
        storageKey: this.options.storageKey,
      });
    }
    this.selection = next;
    this.options.onSelection?.(next);
    return next;
  }

  selectMethod(method: OpenReceivePaymentMethod): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_method",
      method,
    });
  }

  changeMethod(): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "change_method",
    });
  }

  selectRegion(region: OpenReceiveRegionId): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_region",
      region,
    });
  }

  selectCountry(countryCode: string): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_country",
      countryCode,
    });
  }

  openCountryPicker(): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "open_country_picker",
    });
  }

  selectRoute(route: string): OpenReceivePaymentWizardSelection {
    return this.update({
      type: "select_route",
      route,
    });
  }
}

export function createOpenReceivePaymentWizardController(
  options: OpenReceivePaymentWizardControllerOptions = {},
): OpenReceivePaymentWizardController {
  return new OpenReceiveBrowserPaymentWizardController(options);
}

export function readOpenReceiveStoredCountryCode(
  options: {
    readonly storage?: Storage;
    readonly storageKey?: string;
    readonly legacyStorageKey?: string;
  } = {},
): string | null {
  const storage = options.storage ?? getBrowserStorage();
  const storageKey = options.storageKey ?? OPENRECEIVE_COUNTRY_STORAGE_KEY;
  const legacyStorageKey = options.legacyStorageKey ?? OPENRECEIVE_LEGACY_DEMO_COUNTRY_STORAGE_KEY;
  const countryCode =
    readStorageValue(storage, storageKey) ?? readStorageValue(storage, legacyStorageKey);

  if (countryCode === null) return null;

  const normalizedCountryCode = countryCode.trim().toUpperCase();
  return isKnownCountryCode(normalizedCountryCode) ? normalizedCountryCode : null;
}

export function writeOpenReceiveStoredCountryCode(
  countryCode: string,
  options: {
    readonly storage?: Storage;
    readonly storageKey?: string;
  } = {},
): void {
  const normalizedCountryCode = countryCode.trim().toUpperCase();
  if (!isKnownCountryCode(normalizedCountryCode)) return;
  writeStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_COUNTRY_STORAGE_KEY,
    normalizedCountryCode,
  );
}

export function readOpenReceiveThemePreference(
  options: OpenReceiveReadThemePreferenceOptions = {},
): OpenReceiveThemePreference {
  const value = readStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
  );
  return value === "light" || value === "dark" || value === "system"
    ? value
    : (options.defaultTheme ?? "system");
}

export function writeOpenReceiveThemePreference(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeStorageOptions = {},
): void {
  writeStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
    theme,
  );
}

export function resolveOpenReceiveTheme(
  theme: OpenReceiveThemePreference,
  options: {
    readonly systemDark?: boolean;
  } = {},
): OpenReceiveResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (options.systemDark !== undefined) return options.systemDark ? "dark" : "light";
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getOpenReceiveNextThemePreference(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {},
): OpenReceiveThemePreference {
  return resolveOpenReceiveTheme(theme, options) === "dark" ? "light" : "dark";
}

export function getOpenReceiveThemeToggleLabel(resolvedTheme: OpenReceiveResolvedTheme): string {
  return `${resolvedTheme} mode`;
}

export function createOpenReceiveThemeModel(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {},
): OpenReceiveThemeModel {
  const resolvedTheme = resolveOpenReceiveTheme(theme, options);
  return {
    theme,
    resolvedTheme,
    nextTheme: getOpenReceiveNextThemePreference(theme, options),
    toggleLabel: getOpenReceiveThemeToggleLabel(resolvedTheme),
    attributes: {
      "data-theme": resolvedTheme,
      "data-openreceive-theme": resolvedTheme,
    },
    checkoutElementAttributes: {
      theme: resolvedTheme,
    },
  };
}

export function createOpenReceiveStoredThemeModel(
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = readOpenReceiveThemePreference(options);
  return createOpenReceiveThemeModel(theme, { systemDark: options.systemDark });
}

export function toggleOpenReceiveStoredThemePreference(
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const currentTheme = createOpenReceiveStoredThemeModel(options);
  writeOpenReceiveThemePreference(currentTheme.nextTheme, options);
  return createOpenReceiveStoredThemeModel(options);
}

export function applyOpenReceiveThemeAttributes(
  target: OpenReceiveThemeAttributeTarget | null | undefined,
  theme: OpenReceiveThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.attributes)) {
    target.setAttribute(name, value);
  }
}

export function applyCheckoutThemeAttributes(
  target: OpenReceiveThemeAttributeTarget | null | undefined,
  theme: OpenReceiveThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.checkoutElementAttributes)) {
    target.setAttribute(name, value);
  }
}

export function applyOpenReceiveThemeControls(
  targets: OpenReceiveThemeControlTargets,
  theme: OpenReceiveThemeModel,
): void {
  applyOpenReceiveThemeAttributes(targets.root, theme);
  applyCheckoutThemeAttributes(targets.checkout, theme);
  if (targets.toggle !== null && targets.toggle !== undefined) {
    targets.toggle.textContent = theme.toggleLabel;
  }
}

export function syncOpenReceiveStoredThemeControls(
  targets: OpenReceiveThemeControlTargets,
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = createOpenReceiveStoredThemeModel(options);
  applyOpenReceiveThemeControls(targets, theme);
  return theme;
}

export function toggleOpenReceiveStoredThemeControls(
  targets: OpenReceiveThemeControlTargets,
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = toggleOpenReceiveStoredThemePreference(options);
  applyOpenReceiveThemeControls(targets, theme);
  return theme;
}

export function createOpenReceiveTransientFeedbackController<T>(
  options: OpenReceiveTransientFeedbackOptions<T>,
): OpenReceiveTransientFeedbackController<T> {
  const delayMs = options.delayMs ?? OPENRECEIVE_COPY_FEEDBACK_MS;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clear = (): void => {
    if (timeout === undefined) return;
    clearTimeoutFn(timeout);
    timeout = undefined;
  };

  return {
    show(value: T): void {
      clear();
      options.onValue(value);
      timeout = setTimeoutFn(() => {
        timeout = undefined;
        options.onValue(options.resetValue);
      }, delayMs);
    },
    clear,
  };
}

export function formatOpenReceiveCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainderSeconds = safeSeconds % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

export function escapeOpenReceiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatOpenReceiveMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${sats} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${amountMsats} msats`;
}

export function formatOpenReceiveFiatAmount(
  fiat:
    | {
        readonly currency?: string;
        readonly value?: string;
      }
    | null
    | undefined,
): string | undefined {
  if (fiat?.currency === undefined || fiat.value === undefined) return undefined;
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

export function formatOpenReceivePaymentHashLabel(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export function assertOpenReceiveDisplayInvoice(invoice: string): void {
  assertInvoice(invoice);
}

export function createCheckoutDisplayModel(data: CheckoutDisplayData): CheckoutDisplayModel {
  return {
    ...data,
    lightning_uri: createLightningUri(data.invoice),
    ...(data.amount_msats === undefined
      ? {}
      : { amountLabel: formatOpenReceiveMsats(data.amount_msats) }),
    ...(formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) === undefined
      ? {}
      : { fiatLabel: formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) }),
    ...(data.payment_hash === undefined
      ? {}
      : { paymentHashLabel: formatOpenReceivePaymentHashLabel(data.payment_hash) }),
    ...(data.transaction_state === undefined
      ? {}
      : { transactionStateLabel: data.transaction_state }),
  };
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

export function createCheckoutElementAttributes(
  snapshot: CheckoutSnapshot,
  options: CheckoutElementAttributeOptions = {},
): CheckoutElementAttributes {
  const invoice = checkoutInvoiceFromOrderSnapshot(snapshot);
  assertInvoice(invoice.invoice);
  const attributes: CheckoutElementAttributes = {
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: snapshot.order_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId]: invoice.invoice_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice]: invoice.invoice,
  };

  if (invoice.payment_hash !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash] = invoice.payment_hash;
  }
  const amountMsats = invoice.amount_msats ?? snapshot.amount_msats;
  if (amountMsats !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats] = String(amountMsats);
  }
  const fiat = invoice.fiat_quote?.fiat ?? snapshot.fiat;
  if (fiat?.currency !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency] = fiat.currency;
  }
  if (fiat?.value !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue] = fiat.value;
  }
  attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status] = isPaidCheckoutSnapshot(snapshot)
    ? "settled"
    : snapshot.status === "expired"
      ? "expired"
      : deriveStatus(invoice);
  if (invoice.expires_at !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt] = String(invoice.expires_at);
  }
  if (options.statusUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.statusUrl] = options.statusUrl;
  }
  if (options.theme !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme] = options.theme;
  }
  if (options.paymentWizard !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard] = String(
      options.paymentWizard,
    );
  }

  return attributes;
}

export function createOpenReceiveThemeToggleElementAttributes(
  options: OpenReceiveThemeToggleElementAttributeOptions = {},
): OpenReceiveThemeToggleElementAttributes {
  return {
    ...(options.rootSelector === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector]: options.rootSelector }),
    ...(options.checkoutSelector === undefined
      ? {}
      : {
          [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector]: options.checkoutSelector,
        }),
    ...(options.defaultTheme === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme]: options.defaultTheme }),
    ...(options.storageKey === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey]: options.storageKey }),
  };
}

export function createCheckoutElementListeners(
  handlers: CheckoutElementEventHandlers = {},
): CheckoutElementListeners {
  return {
    ...(handlers.onCopy === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy]: handlers.onCopy }),
    ...(handlers.onOpenWallet === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet]: handlers.onOpenWallet }),
    ...(handlers.onState === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state]: handlers.onState }),
    ...(handlers.onSettled === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled]: handlers.onSettled }),
    ...(handlers.onProviderCopy === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy]: handlers.onProviderCopy }),
    ...(handlers.onStartOver === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver]: handlers.onStartOver }),
    ...(handlers.onError === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error]: handlers.onError }),
  };
}

export function createCheckoutShellModel(
  snapshot: CheckoutSnapshot,
  options: CheckoutShellOptions = {},
): CheckoutShellModel {
  const theme = createOpenReceiveStoredThemeModel(options);
  return {
    theme,
    rootAttributes: theme.attributes,
    checkout: {
      tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
      attributes: createCheckoutElementAttributes(snapshot, {
        ...options,
        theme: theme.resolvedTheme,
      }),
      listeners: createCheckoutElementListeners(options),
    },
    themeToggle: {
      tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
      attributes: createOpenReceiveThemeToggleElementAttributes({
        rootSelector: options.rootSelector,
        checkoutSelector: options.checkoutSelector ?? OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
        defaultTheme: options.defaultTheme,
        storageKey: options.storageKey,
      }),
    },
  };
}

export function createCheckoutShellModelFromProps(
  props: OpenReceiveCheckoutShellProps,
): CheckoutShellModel {
  const {
    checkout,
    status: _status,
    providers: _providers,
    theme,
    defaultTheme,
    ...options
  } = props;
  return createCheckoutShellModel(checkout, {
    ...options,
    defaultTheme: defaultTheme ?? theme,
  });
}

export function createCheckoutShellFromProps(
  props: OpenReceiveCheckoutShellProps & Omit<CreateCheckoutShellOptions, "root">,
): CheckoutShellElements {
  return createCheckoutShell(props.checkout, {
    ...props,
    defaultTheme: props.defaultTheme ?? props.theme,
  });
}

export function applyCheckoutElementAttributes(
  target: OpenReceiveThemeAttributeTarget,
  attributes: CheckoutElementAttributes,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) target.setAttribute(name, value);
  }
}

export function applyCheckoutElementListeners(
  target: Pick<CheckoutElementTarget, "addEventListener">,
  listeners: CheckoutElementListeners,
): void {
  for (const [name, listener] of Object.entries(listeners)) {
    if (listener !== undefined) target.addEventListener(name, listener);
  }
}

export function applyOpenReceiveThemeToggleElementAttributes(
  target: OpenReceiveThemeAttributeTarget,
  attributes: OpenReceiveThemeToggleElementAttributes,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) target.setAttribute(name, value);
  }
}

export function createCheckoutElement(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutElementOptions = {},
): HTMLElement {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive checkout element creation requires document.");
  }

  const element = ownerDocument.createElement(OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  applyCheckoutElementAttributes(element, createCheckoutElementAttributes(snapshot, options));
  applyCheckoutElementListeners(element, createCheckoutElementListeners(options));
  return element;
}

export function createOpenReceiveThemeToggleElement(
  options: CreateOpenReceiveThemeToggleElementOptions = {},
): HTMLElement {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive theme toggle element creation requires document.");
  }

  const element = ownerDocument.createElement(OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  applyOpenReceiveThemeToggleElementAttributes(
    element,
    createOpenReceiveThemeToggleElementAttributes(options),
  );
  return element;
}

export function createCheckoutShell(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutShellOptions = {},
): CheckoutShellElements {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive checkout shell creation requires document.");
  }

  const shell = createCheckoutShellModel(snapshot, options);
  applyOpenReceiveThemeAttributes(options.root, shell.theme);

  const checkout = ownerDocument.createElement(shell.checkout.tagName);
  applyCheckoutElementAttributes(checkout, shell.checkout.attributes);
  applyCheckoutElementListeners(checkout, shell.checkout.listeners);

  const themeToggle = ownerDocument.createElement(shell.themeToggle.tagName);
  applyOpenReceiveThemeToggleElementAttributes(themeToggle, shell.themeToggle.attributes);

  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout,
    themeToggle,
  };
}

export async function requestCheckout(
  options: RequestCheckoutOptions,
): Promise<CheckoutSnapshot> {
  if (options.order_id.length === 0) {
    throw new Error("OpenReceive checkout creation requires order_id.");
  }

  const fetcher = options.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout creation requires fetch.");
  }

  const amountSourceCount = [
    "btc" in options.amount,
    "fiat" in options.amount,
  ].filter(Boolean).length;
  if (amountSourceCount !== 1) {
    throw new Error(
      "OpenReceive checkout creation requires exactly one of amount.btc or amount.fiat.",
    );
  }
  if (options.memo !== undefined && options.memo.length > 500) {
    throw new Error("OpenReceive memo must be 500 characters or fewer.");
  }

  const requestBody = {
    order_id: options.order_id,
    amount: structuredClone(options.amount),
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    ...(options.description_hash === undefined
      ? {}
      : { description_hash: options.description_hash }),
    ...(options.expires_in_seconds === undefined
      ? {}
      : { expires_in_seconds: options.expires_in_seconds }),
  };
  assertOpenReceiveBrowserPayloadSafe(requestBody);

  const headers = options.headers === undefined ? {} : options.headers;
  const response = await fetcher(resolveCheckoutUrl(options.checkoutUrl, options.order_id), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      typeof body?.message === "string" ? body.message : "Could not create checkout.",
    );
  }

  const snapshot = checkoutSnapshotFromResponseBody(body);
  const responseInvoice = snapshot.active;
  if (isRecord(responseInvoice) && typeof responseInvoice.invoice === "string") {
    assertOpenReceiveDisplayInvoice(responseInvoice.invoice);
  }

  return snapshot;
}

export function createOpenReceiveStatusFetcher(
  options: CreateOpenReceiveStatusFetcherOptions,
): CheckoutStatusRefresh {
  return async (order_id) => {
    if (order_id.length === 0) {
      throw new Error("OpenReceive status refresh requires order_id.");
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new Error("OpenReceive status refresh requires fetch.");
    }

    const headers = options.headers === undefined ? {} : options.headers;
    const response = await fetcher(resolveStatusUrl(options.statusUrl, order_id), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        order_id,
      }),
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        typeof body?.message === "string" ? body.message : "Could not refresh invoice status.",
      );
    }

    return checkoutSnapshotFromStatusBody(body);
  };
}

function resolveCheckoutUrl(
  checkoutUrl: string | ((orderId: string) => string),
  orderId: string,
): string {
  const url =
    typeof checkoutUrl === "function" ? checkoutUrl(orderId) : checkoutUrl;
  return url.includes("{order_id}")
    ? url.replaceAll("{order_id}", encodeURIComponent(orderId))
    : url;
}

function resolveStatusUrl(statusUrl: string, orderId: string): string {
  return statusUrl.includes("{order_id}")
    ? statusUrl.replaceAll("{order_id}", encodeURIComponent(orderId))
    : statusUrl;
}

function checkoutSnapshotFromResponseBody(body: unknown): CheckoutSnapshot {
  const record = asRecord(body);
  const wrapped = asRecord(record.checkout);
  const candidate =
    typeof wrapped.checkout_id === "string"
      ? wrapped
      : record;
  return normalizeCheckoutSnapshot(candidate);
}

function checkoutSnapshotFromStatusBody(body: unknown): CheckoutSnapshot | null {
  const record = asRecord(body);
  if (typeof record.checkout_id === "string") {
    return normalizeCheckoutSnapshot(record);
  }

  const displayCheckout = asRecord(record.display_checkout);
  if (typeof displayCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(displayCheckout);
  }

  const paidCheckout = asRecord(record.paid_checkout);
  if (typeof paidCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(paidCheckout);
  }

  const activeCheckout = asRecord(record.active_checkout);
  if (typeof activeCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(activeCheckout);
  }

  if (Array.isArray(record.checkouts)) {
    const first = asRecord(record.checkouts[0]);
    if (typeof first.checkout_id === "string") {
      return normalizeCheckoutSnapshot(first);
    }
  }

  return null;
}

function normalizeCheckoutSnapshot(input: unknown): CheckoutSnapshot {
  const record = asRecord(input);
  const active = record.active === undefined ? undefined : normalizeCheckoutInvoiceSnapshot(record.active);
  const rawInvoices = Array.isArray(record.invoices) ? record.invoices : [];
  const invoices = rawInvoices.map(normalizeCheckoutInvoiceSnapshot);
  const checkoutId = requiredString(record.checkout_id, "checkout_id");
  const orderId = requiredString(record.order_id, "order_id");
  const amountMsats = requiredSafeInteger(record.amount_msats, "amount_msats");
  const status = requiredCheckoutStatus(record.status);

  return {
    checkout_id: checkoutId,
    order_id: orderId,
    status,
    ...(optionalSafeInteger(record.paid_at) === undefined
      ? {}
      : { paid_at: optionalSafeInteger(record.paid_at) }),
    amount_msats: amountMsats,
    ...(normalizeFiat(record.fiat) === undefined ? {} : { fiat: normalizeFiat(record.fiat) }),
    ...(active === undefined ? {} : { active }),
    invoices,
    ...(optionalBoolean(record.wallet_scan_performed) === undefined
      ? {}
      : { wallet_scan_performed: optionalBoolean(record.wallet_scan_performed) }),
    ...(optionalSafeInteger(record.transactions_checked) === undefined
      ? {}
      : { transactions_checked: optionalSafeInteger(record.transactions_checked) }),
  };
}

function normalizeCheckoutInvoiceSnapshot(input: unknown): CheckoutInvoiceSnapshot {
  const record = asRecord(input);
  const invoice = requiredString(record.invoice, "invoice");
  return {
    invoice_id: requiredString(record.invoice_id, "invoice_id"),
    invoice,
    ...(optionalString(record.payment_hash) === undefined
      ? {}
      : { payment_hash: optionalString(record.payment_hash) }),
    ...(optionalSafeInteger(record.amount_msats) === undefined
      ? {}
      : { amount_msats: optionalSafeInteger(record.amount_msats) }),
    ...(isRecord(record.fiat_quote) || record.fiat_quote === null
      ? { fiat_quote: record.fiat_quote as CheckoutInvoiceSnapshot["fiat_quote"] }
      : {}),
    ...(optionalString(record.transaction_state) === undefined
      ? {}
      : { transaction_state: optionalString(record.transaction_state) }),
    ...(optionalString(record.workflow_state) === undefined
      ? {}
      : { workflow_state: optionalString(record.workflow_state) }),
    ...(optionalSafeInteger(record.expires_at) === undefined
      ? {}
      : { expires_at: optionalSafeInteger(record.expires_at) }),
    ...(optionalSafeInteger(record.settled_at) === undefined
      ? {}
      : { settled_at: optionalSafeInteger(record.settled_at) }),
  };
}

function checkoutInvoiceFromOrderSnapshot(snapshot: CheckoutSnapshot): CheckoutInvoiceSnapshot {
  const invoice = snapshot.active ?? snapshot.invoices[0];
  if (invoice === undefined) {
    throw new TypeError("OpenReceive order snapshot requires active or invoices[0].");
  }
  return invoice;
}

function isPaidCheckoutSnapshot(snapshot: CheckoutSnapshot): boolean {
  return snapshot.status === "paid";
}

export function createCheckoutState(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  const invoice = checkoutInvoiceFromOrderSnapshot(snapshot);
  const paid = isPaidCheckoutSnapshot(snapshot);
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  const transactionState = paid ? "settled" : (invoice.transaction_state ?? "pending");
  const workflowState = paid
    ? "settlement_action_completed"
    : (invoice.workflow_state ?? "invoice_created");

  const state = normalizeCheckoutState(
    {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: invoice.invoice_id,
      invoice: invoice.invoice,
      lightning_uri: createLightningUri(invoice.invoice),
      ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
      amount_msats: invoice.amount_msats ?? snapshot.amount_msats,
      ...(invoice.fiat_quote === undefined ? {} : { fiat_quote: invoice.fiat_quote }),
      transaction_state: transactionState,
      workflow_state: workflowState,
      ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
      ...(settledAt === undefined ? {} : { settled_at: settledAt }),
      paid,
    },
    options.now ?? currentUnixSeconds(),
  );
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.state.created",
    "Created checkout state from order snapshot.",
    checkoutLogFields(state),
  );
  return state;
}

export function createCheckoutSnapshotFromDisplayData(data: CheckoutDisplayData): CheckoutSnapshot {
  if (data.invoice_id === undefined) {
    throw new TypeError("invoice_id is required for checkout state");
  }

  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: data.invoice_id,
    invoice: data.invoice,
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.fiat_quote === undefined ? {} : { fiat_quote: data.fiat_quote }),
    ...(data.transaction_state === undefined ? {} : { transaction_state: data.transaction_state }),
    ...(data.workflow_state === undefined ? {} : { workflow_state: data.workflow_state }),
    ...(data.expires_at === undefined ? {} : { expires_at: data.expires_at }),
    ...(data.settled_at === undefined ? {} : { settled_at: data.settled_at }),
  };
  const paid = data.settled_at !== undefined || data.transaction_state === "settled";
  const checkoutId = data.checkout_id ?? data.invoice_id;
  return {
    checkout_id: checkoutId,
    order_id: data.order_id ?? data.invoice_id,
    status: paid ? "paid" : "open",
    ...(data.settled_at === undefined ? {} : { paid_at: data.settled_at }),
    amount_msats: data.amount_msats ?? 0,
    active: paid ? undefined : invoice,
    invoices: [invoice],
  };
}

export function createCheckoutStateFromDisplayData(
  data: CheckoutDisplayData,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(createCheckoutSnapshotFromDisplayData(data), options);
}

export function refreshCheckoutState(
  state: CheckoutState,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(snapshotFromCheckoutState(state), options);
}

export function mergeCheckoutSnapshot(
  current: CheckoutState,
  next: Partial<CheckoutSnapshot>,
): CheckoutSnapshot {
  const currentSnapshot = snapshotFromCheckoutState(current);
  return {
    ...currentSnapshot,
    ...next,
    checkout_id: next.checkout_id ?? currentSnapshot.checkout_id,
    order_id: next.order_id ?? currentSnapshot.order_id,
    status: next.status ?? currentSnapshot.status,
    amount_msats: next.amount_msats ?? currentSnapshot.amount_msats,
    active: next.active ?? currentSnapshot.active,
    invoices: next.invoices ?? currentSnapshot.invoices,
  };
}

export function shouldCheckoutShowWaiting(
  state: CheckoutState,
  options: { readonly now?: number } = {},
): boolean {
  if (state.terminal || state.settled) return false;
  if (state.expires_at === undefined) return true;
  return state.expires_at > (options.now ?? currentUnixSeconds());
}

export function createCheckoutStatusModel(
  source?: CheckoutState | CheckoutStatusModelInput,
  options: { readonly now?: number } = {},
): CheckoutStatusModel {
  const isCheckoutState = source !== undefined && "invoice_id" in source && "invoice" in source;
  const phase = source?.phase ?? "invoice_created";
  const expiresInSeconds = source?.expires_in_seconds;
  const displayPhase =
    phase !== "settled" && phase !== "failed" && phase !== "cancelled" && expiresInSeconds === 0
      ? "expired"
      : phase;
  const statusText = getOpenReceivePaymentStatusText(displayPhase);

  return {
    phase: displayPhase,
    waiting:
      displayPhase === "expired"
        ? false
        : source === undefined
          ? false
          : isCheckoutState
            ? shouldCheckoutShowWaiting(source, options)
            : (source.waiting ?? false),
    title: statusText.title,
    detail: statusText.detail,
    countdownPrefix: openReceiveCheckoutLabels.countdownPrefix,
    ...(expiresInSeconds === undefined || displayPhase === "expired"
          ? {}
          : {
          expires_in_seconds: expiresInSeconds,
          countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
        }),
  };
}

export class CheckoutWatcher {
  private options: CheckoutWatcherOptions;
  private state: CheckoutState | undefined;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private running = false;

  constructor(options: CheckoutWatcherOptions) {
    this.options = options;
  }

  start(): CheckoutState {
    this.stop();
    this.running = true;
    const state = createCheckoutState(this.options.snapshot, {
      now: this.now(),
      logger: this.options.logger,
    });
    this.applyState(state);
    return state;
  }

  update(options: CheckoutWatcherOptions): CheckoutState {
    this.options = options;
    return this.start();
  }

  stop(): void {
    this.running = false;
    this.stopCountdown();
    this.stopPolling();
  }

  getState(): CheckoutState | undefined {
    return this.state;
  }

  async reloadState(): Promise<CheckoutState> {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    const refreshStatus = this.options.refreshStatus;
    if (refreshStatus === undefined || current.order_id.length === 0) {
      return current;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return current;
      const nextState = createCheckoutState(next, {
        now: this.now(),
        logger: this.options.logger,
      });
      if (this.running) {
        this.applyState(nextState);
      } else {
        this.state = nextState;
      }
      return nextState;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }

  private applyState(state: CheckoutState): void {
    if (!this.running) return;
    this.state = state;
    this.options.onState(state);
    this.syncWatchers();
  }

  private syncWatchers(): void {
    const state = this.state;
    if (state === undefined || !this.running) return;

    if (state.terminal) {
      this.stop();
      return;
    }

    if (state.settled || state.expires_at === undefined) {
      this.stopCountdown();
    } else if (this.countdownTimer === undefined) {
      this.countdownTimer = this.setInterval()(() => {
        const current = this.state;
        if (current === undefined) return;
        this.applyState(
          refreshCheckoutState(current, {
            now: this.now(),
            logger: this.options.logger,
          }),
        );
      }, 1000);
    }

    if (state.settled || this.options.refreshStatus === undefined || state.order_id.length === 0) {
      this.stopPolling();
    } else if (this.pollTimer === undefined) {
      this.pollTimer = this.setInterval()(() => {
        void this.poll();
      }, this.options.pollIntervalMs ?? OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async poll(): Promise<void> {
    const refreshStatus = this.options.refreshStatus;
    const current = this.state;
    if (!this.running || refreshStatus === undefined || current === undefined) return;
    if (current.terminal || current.settled) {
      this.stopPolling();
      return;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return;
      if (!this.running || this.state === undefined) return;
      this.applyState(
        createCheckoutState(next, {
          now: this.now(),
          logger: this.options.logger,
        }),
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private stopCountdown(): void {
    if (this.countdownTimer === undefined) return;
    this.clearInterval()(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) return;
    this.clearInterval()(this.pollTimer);
    this.pollTimer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? currentUnixSeconds();
  }

  private setInterval(): typeof globalThis.setInterval {
    return this.options.setInterval ?? globalThis.setInterval;
  }

  private clearInterval(): typeof globalThis.clearInterval {
    return this.options.clearInterval ?? globalThis.clearInterval;
  }
}

export class OpenReceiveBrowserCheckoutController implements CheckoutController {
  private options: CheckoutControllerOptions;
  private watcher: CheckoutWatcher;
  private state: CheckoutState | undefined;

  constructor(options: CheckoutControllerOptions) {
    this.options = options;
    this.watcher = this.createWatcher(options);
  }

  start(): CheckoutState {
    this.state = this.watcher.start();
    return this.state;
  }

  update(options: CheckoutControllerOptions): CheckoutState {
    this.options = options;
    this.watcher.stop();
    this.watcher = this.createWatcher(options);
    return this.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  getState(): CheckoutState | undefined {
    return this.state ?? this.watcher.getState();
  }

  async copyInvoice(): Promise<void> {
    const state = this.currentState();
    await copyInvoice({
      invoice: state.invoice,
      clipboard: this.options.clipboard,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  openWallet(): string {
    const state = this.currentState();
    return openWallet({
      invoice: state.invoice,
      open: this.options.open,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  async reloadState(): Promise<CheckoutState> {
    return this.watcher.reloadState();
  }

  async retry(): Promise<CheckoutState> {
    return this.reloadState();
  }

  cancel(): CheckoutState {
    this.stop();
    this.state = this.currentState();
    emitBrowserLog(
      this.options.logger,
      "info",
      "checkout.cancelled",
      "Stopped checkout watcher after cancel action.",
      checkoutLogFields(this.state),
    );
    return this.state;
  }

  private createWatcher(options: CheckoutControllerOptions): CheckoutWatcher {
    const refreshStatus =
      options.refreshStatus ??
      (options.statusUrl === undefined
        ? undefined
        : createOpenReceiveStatusFetcher({
            statusUrl: options.statusUrl,
            fetch: options.fetch,
            headers: options.statusHeaders,
          }));

    return new CheckoutWatcher({
      ...options,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      onState: (state) => {
        this.state = state;
        options.onState?.(state);
      },
    });
  }

  private currentState(): CheckoutState {
    return (
      this.getState() ??
      createCheckoutState(this.options.snapshot, {
        now: this.options.now?.(),
        logger: this.options.logger,
      })
    );
  }
}

export function createCheckoutController(options: CheckoutControllerOptions): CheckoutController {
  return new OpenReceiveBrowserCheckoutController(options);
}

export async function createQrSvg(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);
  const svg = await encoder.toString(createLightningUri(invoice), {
    type: "svg",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(svg);
}

export async function createQrPngDataUrl(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);

  if (encoder.toDataURL === undefined) {
    throw new Error("QR encoder does not support PNG data URL output.");
  }

  const png = await encoder.toDataURL(createLightningUri(invoice), {
    type: "image/png",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(png);
}

// Spec-named alias for the canonical QR helper trio
// (createQrSvg / createQrPng / createLightningUri). createQrPng returns a
// PNG data URL using the same safe quiet-zone, contrast, and payload defaults.
export const createQrPng = createQrPngDataUrl;

export async function copyInvoice(options: CopyInvoiceOptions): Promise<void> {
  assertInvoice(options.invoice);
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  if (clipboard === undefined) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(options.invoice);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.invoice.copied",
    "Copied Lightning invoice to clipboard.",
    options.logContext,
  );
}

export function openWallet(options: OpenWalletOptions): string {
  const uri = createLightningUri(options.invoice);

  if (options.open !== undefined) {
    options.open(uri);
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.wallet.opened",
      "Opened Lightning invoice URI.",
      options.logContext,
    );
    return uri;
  }

  const location = globalThis.window?.location;
  if (location === undefined) {
    throw new Error("window.location is unavailable.");
  }

  location.assign(uri);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.wallet.opened",
    "Opened Lightning invoice URI.",
    options.logContext,
  );
  return uri;
}

async function getQrEncoder(
  encoder: OpenReceiveQrEncoder | undefined,
): Promise<OpenReceiveQrEncoder> {
  if (encoder !== undefined) return encoder;

  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const imported = asRecord(await dynamicImport("qrcode"));
  const candidate = (imported.default ?? imported) as unknown;

  if (isQrEncoder(candidate)) return candidate;

  throw new Error("qrcode package did not expose a compatible encoder.");
}

function isQrEncoder(value: unknown): value is OpenReceiveQrEncoder {
  const record = asRecord(value);
  return typeof record.toString === "function";
}

function assertInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

function assertOpenReceiveBrowserPayloadSafe(value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("nostr+walletconnect://")) {
      throw new TypeError("OpenReceive browser payload must not include an NWC connection string");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) assertOpenReceiveBrowserPayloadSafe(item);
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertOpenReceiveBrowserPayloadSafe(item);
    }
  }
}

function normalizeCheckoutState(
  state: Omit<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds"> &
    Partial<Pick<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds">>,
  now?: number,
): CheckoutState {
  const {
    phase: _phase,
    settled: _settled,
    terminal: _terminal,
    expires_in_seconds: _expiresInSeconds,
    ...base
  } = state;
  const phase = getCheckoutPhase(state.transaction_state, state.workflow_state);

  return {
    ...base,
    phase,
    settled: base.paid || base.transaction_state === "settled",
    terminal: isTerminalPhase(phase),
    ...(base.expires_at === undefined || now === undefined
      ? {}
      : { expires_in_seconds: Math.max(0, base.expires_at - now) }),
  };
}

function getCheckoutPhase(transactionState: string, workflowState: string): CheckoutPhase {
  if (workflowState === "cancelled") return "cancelled";
  if (transactionState === "settled") return "settled";
  if (transactionState === "expired" || workflowState === "expired_closed") {
    return "expired";
  }
  if (transactionState === "failed" || workflowState === "failed_closed") {
    return "failed";
  }
  if (workflowState === "verifying" || workflowState === "expiry_pending_verification") {
    return "verifying";
  }
  return "invoice_created";
}

function isTerminalPhase(phase: CheckoutPhase): boolean {
  return phase === "expired" || phase === "failed" || phase === "cancelled";
}

function snapshotFromCheckoutState(state: CheckoutState): CheckoutSnapshot {
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: state.invoice_id,
    invoice: state.invoice,
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.fiat_quote === undefined ? {} : { fiat_quote: state.fiat_quote }),
    transaction_state: state.transaction_state,
    workflow_state: state.workflow_state,
    ...(state.expires_at === undefined ? {} : { expires_at: state.expires_at }),
    ...(state.settled_at === undefined ? {} : { settled_at: state.settled_at }),
  };
  return {
    checkout_id: state.checkout_id,
    order_id: state.order_id,
    status: state.paid ? "paid" : state.terminal ? "expired" : "open",
    ...(state.settled_at === undefined ? {} : { paid_at: state.settled_at }),
    amount_msats: state.amount_msats ?? 0,
    active: state.paid ? undefined : invoice,
    invoices: [invoice],
  };
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getRailForPaymentMethod(method: OpenReceivePaymentMethod | null): FiatRailId | null {
  if (method === "bank") return "bank";
  if (method === "card") return "card";
  return null;
}

function isKnownCountryCode(countryCode: string): boolean {
  return getCountries().some((country) => country.code === countryCode);
}

function readStorageValue(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageValue(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Browser storage is convenience only; checkout must keep working without it.
  }
}

function getBrowserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function checkoutLogFields(state: {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly phase?: string;
  readonly expires_in_seconds?: number;
}): Record<string, unknown> {
  return {
    ...(state.checkout_id === undefined ? {} : { checkout_id: state.checkout_id }),
    ...(state.order_id === undefined ? {} : { order_id: state.order_id }),
    ...(state.invoice_id === undefined ? {} : { invoice_id: state.invoice_id }),
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.transaction_state === undefined
      ? {}
      : { transaction_state: state.transaction_state }),
    ...(state.workflow_state === undefined ? {} : { workflow_state: state.workflow_state }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
    ...(state.expires_in_seconds === undefined
      ? {}
      : { expires_in_seconds: state.expires_in_seconds }),
  };
}

function emitBrowserLog(
  logger: OpenReceiveBrowserLogger | undefined,
  level: OpenReceiveBrowserLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (logger === undefined) return;

  try {
    logger(
      sanitizeBrowserLogEntry({
        level,
        event,
        message,
        ...fields,
      }),
    );
  } catch {
    // Checkout logs are diagnostic only and must not affect user actions.
  }
}

function sanitizeBrowserLogEntry(entry: OpenReceiveBrowserLogEntry): OpenReceiveBrowserLogEntry {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(value);
    }
  }
  return clean as OpenReceiveBrowserLogEntry;
}

function sanitizeBrowserLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactBrowserSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeBrowserLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(nested);
    }
  }
  return clean;
}

function redactBrowserSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, fieldName: string): string {
  const text = optionalString(value);
  if (text === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return text;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" ? value : undefined;
}

function requiredSafeInteger(value: unknown, fieldName: string): number {
  const integer = optionalSafeInteger(value);
  if (integer === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return integer;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requiredCheckoutStatus(value: unknown): CheckoutSnapshot["status"] {
  if (value === "open" || value === "superseded" || value === "paid" || value === "expired") {
    return value;
  }
  throw new TypeError("OpenReceive checkout response requires status.");
}

function normalizeFiat(value: unknown): CheckoutSnapshot["fiat"] | undefined {
  const record = asRecord(value);
  const currency = optionalString(record.currency);
  const fiatValue = optionalString(record.value);
  if (currency === undefined || fiatValue === undefined) return undefined;
  return {
    currency,
    value: fiatValue,
  };
}
