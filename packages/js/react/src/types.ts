import type * as React from "react";
import type {
  CheckoutInvoiceSnapshot,
  CheckoutSnapshot,
  CheckoutState,
  CheckoutStatusRefresh,
  OpenReceiveBrowserLogContext,
  OpenReceiveBrowserLoggerOption,
  OpenReceiveCheckoutPaymentMethod,
  OpenReceiveQrEncoder,
  OpenReceiveResolvedTheme,
  OpenReceiveThemeModel,
  OpenReceiveThemePreference,
  Status,
} from "@openreceive/browser/internal";

export interface CheckoutData {
  readonly checkout: CheckoutSnapshot;
}

/**
 * Create-mode inputs. Pass an `orderId` (and optionally a mount `prefix`, defaulting to
 * `/openreceive`) instead of a `checkout` snapshot and the component owns the whole
 * lifecycle: it creates the checkout against `${prefix}/checkouts`, then polls
 * `${prefix}/payments/check`. Later requests carry `order_id` and the displayed
 * `payment_hash`; the host remains
 * responsible for authorization, order display, and routing.
 */
export interface CheckoutCreateOptions {
  readonly orderId?: string;
  readonly prefix?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createFetch?: typeof globalThis.fetch;
  /**
   * Opt into History API URL sync to `{resumePathPrefix}/{orderId}` (default `/checkout/:id`).
   * Off by default — many hosts own routing or other state themselves. Skipped when
   * `routeOrderId` is set.
   */
  readonly syncUrl?: boolean;
  /** History API path prefix when `syncUrl` is set. Default `/checkout`. */
  readonly resumePathPrefix?: string;
  /**
   * Order id from the app router (e.g. Next.js). When set, Checkout does not push/replace
   * the URL via the History API.
   */
  readonly routeOrderId?: string;
}

/**
 * What React renders a checkout from: the shared {@link CheckoutState} plus the
 * coarse public {@link Status} the component's four terminal branches read.
 *
 * It used to restate eleven of CheckoutState's fields — the same flattening
 * rule, written a second time in a second package. It now extends the state, so
 * there is exactly one derivation and one place a display field can come from.
 */
export interface CheckoutViewModel extends CheckoutState {
  readonly status: Status;
}

/**
 * Event handlers every OpenReceive wrapper exposes (docs/internal/wrapper-parity.md).
 * React hands each one its framework-native payload; the element wrappers hand the
 * matching DOM CustomEvent.
 */
export interface CheckoutEventHandlers {
  readonly onCopy?: () => void;
  readonly onOpenWallet?: (uri: string) => void;
  readonly onState?: (state: CheckoutState) => void;
  readonly onSettled?: () => void;
  readonly onProviderCopy?: (providerId: string) => void;
  readonly onStartOver?: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Hook inputs. The hook drives a concrete snapshot; create mode belongs to `<Checkout>`,
 * so create options are deliberately absent here — `useCheckout({ orderId })` used to
 * type-check and then always throw.
 */
export interface UseCheckoutOptions
  extends Partial<CheckoutData>,
    Omit<CheckoutEventHandlers, "onProviderCopy" | "onStartOver"> {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly orderUrl?: string | false;
  readonly polling?: boolean;
  readonly pollIntervalMs?: number;
}

export interface UseCheckoutResult extends CheckoutViewModel {
  readonly checkout: CheckoutSnapshot;
  readonly copied: boolean;
  readonly countdownLabel?: string;
  readonly countdownPrefix?: string;
  readonly statusTitle: string;
  readonly statusDetail: string;
  readonly waiting: boolean;
  reloadState(): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
  copyInvoice(): Promise<void>;
  openWallet(): string;
}

export interface CheckoutProviderProps extends UseCheckoutOptions {
  readonly children?: React.ReactNode | ((checkout: UseCheckoutResult) => React.ReactNode);
}

export interface QRCodeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  readonly invoice: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly width?: number;
  readonly onError?: (error: unknown) => void;
}

export type ButtonComponent = React.ElementType<React.ButtonHTMLAttributes<HTMLButtonElement>>;

export interface CopyInvoiceButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly copyInvoice?: () => Promise<void>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly copiedLabel?: React.ReactNode;
  readonly ButtonComponent?: ButtonComponent;
}

export interface OpenWalletButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly openWallet?: () => string;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly onOpened?: (uri: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export interface PaymentStateProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly state?: string;
}

export interface InvoiceSummaryClassNames {
  readonly amount?: string;
  readonly fiat?: string;
  readonly paymentHash?: string;
  readonly paymentState?: string;
}

export interface InvoiceSummaryProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
  readonly status?: Status;
  readonly PaymentStateComponent?: React.ComponentType<PaymentStateProps>;
  readonly classNames?: InvoiceSummaryClassNames;
}

export interface CheckoutClassNames extends InvoiceSummaryClassNames {
  readonly root?: string;
  readonly qr?: string;
  readonly satsDetail?: string;
  readonly lightningPane?: string;
  readonly invoiceTitle?: string;
  /** Applied to the settled payment-data disclosure. */
  readonly details?: string;
  readonly waiting?: string;
  readonly countdown?: string;
  readonly summary?: string;
  readonly actions?: string;
  readonly copyButton?: string;
  /** Applied to the `components.OpenWalletButton` slot, which renders only when supplied. */
  readonly openWalletButton?: string;
  readonly wizard?: string;
  readonly themeToggle?: string;
}

export interface CheckoutComponents {
  readonly Button?: ButtonComponent;
  readonly QRCode?: React.ComponentType<QRCodeProps>;
  readonly InvoiceSummary?: React.ComponentType<InvoiceSummaryProps>;
  readonly CopyButton?: React.ComponentType<CopyInvoiceButtonProps>;
  readonly OpenWalletButton?: React.ComponentType<OpenWalletButtonProps>;
  readonly PaymentState?: React.ComponentType<PaymentStateProps>;
}

export type CheckoutChildren = React.ReactNode | ((model: UseCheckoutResult) => React.ReactNode);

export interface CheckoutProps
  extends Partial<CheckoutData>,
    CheckoutCreateOptions,
    CheckoutEventHandlers,
    // Omit the RDFa `prefix` attribute from HTMLAttributes so our create-mode `prefix` wins.
    // The DOM copy/error handlers are replaced by the OpenReceive ones above.
    Omit<React.HTMLAttributes<HTMLElement>, "children" | "prefix" | "onCopy" | "onError"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  /**
   * Base URL of an external bolt11 decoder. Omitted (the default), no "Decode" link is
   * rendered and the invoice is never sent to a third party.
   */
  readonly decodeLinkUrl?: string;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly orderUrl?: string | false;
  readonly polling?: boolean;
  readonly pollIntervalMs?: number;
  readonly paymentWizard?: boolean;
  /** Default true: the checkout owns `data-theme` and renders the package theme toggle. */
  readonly themeToggle?: boolean;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly storageKey?: string;
  readonly components?: CheckoutComponents;
  readonly classNames?: CheckoutClassNames;
  readonly children?: CheckoutChildren;
}

export interface UseThemeOptions {
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly storageKey?: string;
  readonly storage?: Storage;
}

export interface UseThemeResult {
  readonly theme: OpenReceiveThemePreference;
  readonly resolvedTheme: OpenReceiveResolvedTheme;
  readonly model: OpenReceiveThemeModel;
  readonly nextTheme: OpenReceiveThemePreference;
  readonly toggleLabel: string;
  readonly attributes: OpenReceiveThemeModel["attributes"];
  readonly checkoutElementAttributes: OpenReceiveThemeModel["checkoutElementAttributes"];
  /** True when this result comes from an ancestor ThemeScope (inherit, don't re-stamp). */
  readonly fromScope: boolean;
  setTheme(theme: OpenReceiveThemePreference): void;
  toggleTheme(): void;
}

export interface ThemeToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly theme?: OpenReceiveThemePreference;
  readonly resolvedTheme?: OpenReceiveResolvedTheme;
  readonly onThemeChange?: (theme: OpenReceiveThemePreference) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export type ThemeScopeChildren = React.ReactNode | ((theme: UseThemeResult) => React.ReactNode);

export interface ThemeScopeProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly as?: keyof React.JSX.IntrinsicElements;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly storageKey?: string;
  readonly storage?: Storage;
  readonly themeToggle?: boolean;
  readonly topbarClassName?: string;
  readonly themeToggleClassName?: string;
  readonly ButtonComponent?: ButtonComponent;
  readonly children?: ThemeScopeChildren;
}

export interface PaymentWizardProps {
  /**
   * The active Lightning bolt11 invoice. Optional: omit (or pass `undefined`) in
   * create-mode deferred flows where the Lightning invoice has not been minted yet.
   * The wizard will disable invoice-copy actions until a non-empty invoice is provided.
   */
  readonly invoice?: string;
  readonly checkout?: CheckoutSnapshot;
  readonly className?: string;
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly logContext?: OpenReceiveBrowserLogContext;
  readonly orderUrl?: string | false;
  readonly fetch?: typeof globalThis.fetch;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  /** Base URL of an external bolt11 decoder; omitted, no "Decode" link is rendered. */
  readonly decodeLinkUrl?: string;
  readonly onError?: (error: unknown) => void;
  /**
   * Called when the payer enters or leaves the focused swap flow (a pay-in coin is
   * selected). The default `Checkout` uses this to hide its Lightning payment section
   * so the swap deposit panel fully replaces it.
   */
  readonly onSwapFocusChange?: (focused: boolean) => void;
  /**
   * Called when the wizard needs a Lightning invoice to be ready — e.g. when the payer
   * selects Bitcoin from the method grid or navigates back from a swap to the Lightning
   * pane. The host should mint (or reuse) a bolt11 and update the checkout snapshot.
   * Used by the create-mode deferred flow; safe to omit in snapshot mode.
   */
  readonly onRequestLightning?: () => void | Promise<void>;
  /**
   * Called after a swap deposit attempt is created or reused so create-mode can poll
   * the shadow Lightning payment_hash for settlement.
   */
  readonly onSwapStarted?: (invoice: CheckoutInvoiceSnapshot) => void;
  /** Called with the provider id after the payer copies the invoice from a provider tutorial. */
  readonly onProviderCopy?: (providerId: string) => void;
}

export type OpenReceiveSwapOptionDisplay = OpenReceiveCheckoutPaymentMethod;

export interface OpenReceiveSwapOptionsResult {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOptionDisplay[];
}

export interface SatsDetailProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly fiatCurrency?: string;
}
