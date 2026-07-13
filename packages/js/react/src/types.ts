import type * as React from "react";
import type {
  CheckoutInvoiceSnapshot,
  CheckoutSnapshot,
  CheckoutState,
  CheckoutStatusRefresh,
  OpenReceiveBrowserLogContext,
  OpenReceiveBrowserLogger,
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
 * lifecycle: it creates the checkout against `${prefix}/checkouts`, then polls status and
 * drives swaps against `${prefix}/orders/${orderId}`. The per-order capability token is
 * captured and attached automatically.
 *
 * Create mode always fetches `GET {prefix}/orders/{orderId}/summary` for host display
 * redraw (`onSummary`). Opt into `/checkout/:orderId` History API sync with `syncUrl`.
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

export interface CheckoutViewModel {
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutInvoiceSnapshot["fiat_quote"];
  readonly expires_at?: number;
  readonly settled_at?: number;
  readonly lightning_uri: string;
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
  readonly status: Status;
}

export interface UseCheckoutOptions extends Partial<CheckoutData>, CheckoutCreateOptions {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly orderUrl?: string | false;
  readonly onState?: (state: CheckoutState) => void;
  readonly onSettled?: () => void;
  readonly polling?: boolean;
  readonly pollIntervalMs?: number;
}

export interface UseCheckoutResult extends CheckoutViewModel {
  readonly checkout: CheckoutSnapshot;
  readonly copied: boolean;
  readonly expires_in_seconds?: number;
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
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly copiedLabel?: React.ReactNode;
  readonly ButtonComponent?: ButtonComponent;
}

export interface OpenWalletButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly openWallet?: () => string;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
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
  readonly details?: string;
  readonly waiting?: string;
  readonly countdown?: string;
  readonly summary?: string;
  readonly invoice?: string;
  readonly actions?: string;
  readonly copyButton?: string;
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
    // Omit the RDFa `prefix` attribute from HTMLAttributes so our create-mode `prefix` wins.
    Omit<React.HTMLAttributes<HTMLElement>, "children" | "prefix"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly orderUrl?: string | false;
  readonly onState?: (state: CheckoutState) => void;
  readonly onSettled?: () => void;
  readonly onStartOver?: () => void;
  /**
   * Guest resume: opaque `summary` from `GET {prefix}/orders/{orderId}/summary`.
   * Called in create mode when the summary fetch succeeds (always attempted with `orderId`).
   */
  readonly onSummary?: (summary: unknown) => void;
  /** Called in create mode when the summary fetch misses (404 / not OK). */
  readonly onResumeMiss?: (orderId: string) => void;
  readonly polling?: boolean;
  readonly paymentWizard?: boolean;
  readonly themeSwitcher?: boolean;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly themeStorageKey?: string;
  readonly countryStorageKey?: string;
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
  readonly themeStorageKey?: string;
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
  readonly logger?: OpenReceiveBrowserLogger;
  readonly logContext?: OpenReceiveBrowserLogContext;
  readonly countryStorageKey?: string;
  readonly orderUrl?: string | false;
  readonly fetch?: typeof globalThis.fetch;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly qrEncoder?: OpenReceiveQrEncoder;
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
