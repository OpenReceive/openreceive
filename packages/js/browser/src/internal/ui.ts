import {
  type AssetIndexEntry,
  type Country,
  type FiatRailId,
  type PaymentWizardRoute,
  type Provider,
  type ResolvedProviderRef,
} from "@openreceive/provider-data";
import { type Status } from "../status.ts";
export { status, type Status, type StatusInvoiceLike } from "../status.ts";

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

const bankIcon = new URL("../assets/icons/bank.svg", import.meta.url).href;
const bnbIcon = new URL("../assets/icons/bnb.svg", import.meta.url).href;
const btcIcon = new URL("../assets/icons/btc.svg", import.meta.url).href;
const cardIcon = new URL("../assets/icons/card.svg", import.meta.url).href;
const cryptoIcon = new URL("../assets/icons/crypto.svg", import.meta.url).href;
const dogeIcon = new URL("../assets/icons/doge.svg", import.meta.url).href;
const ethIcon = new URL("../assets/icons/eth.svg", import.meta.url).href;
const lightningIcon = new URL("../assets/icons/lightning.svg", import.meta.url).href;
const ltcIcon = new URL("../assets/icons/ltc.svg", import.meta.url).href;
const solIcon = new URL("../assets/icons/sol.svg", import.meta.url).href;
const trxIcon = new URL("../assets/icons/trx.svg", import.meta.url).href;
const usdcIcon = new URL("../assets/icons/usdc.svg", import.meta.url).href;
const usdtIcon = new URL("../assets/icons/usdt.svg", import.meta.url).href;
const xmrIcon = new URL("../assets/icons/xmr.svg", import.meta.url).href;
const xrpIcon = new URL("../assets/icons/xrp.svg", import.meta.url).href;

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

export type CheckoutStatusRefresh = (orderId: string) => Promise<CheckoutSnapshot | null>;

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

export type RequestCheckoutOptions = RequestCheckoutBaseOptions &
  (
    | {
        readonly amount: RequestCheckoutAmount;
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

export interface RequestCheckoutBaseOptions {
  readonly checkoutUrl: string | ((orderId: string) => string);
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly expiresInSeconds?: number;
  readonly metadata?: Record<string, unknown>;
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

  [part="sats-detail"] {
    color: var(--or-muted);
    font-size: 13px;
    justify-self: center;
    margin-top: -6px;
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
