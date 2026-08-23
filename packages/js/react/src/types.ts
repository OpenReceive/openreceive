import type * as React from "react";
import type {
  CheckoutInvoiceSnapshot,
  CheckoutSnapshot,
  CheckoutState,
  CheckoutStatusRefresh,
  BrowserLogContext,
  BrowserLoggerOption,
  CheckoutComponentProps,
  CheckoutPaymentMethod,
  QrEncoder,
  ResolvedTheme,
  ThemeModel,
  ThemePreference,
  Status,
} from "@openreceive/browser/headless";

export interface CheckoutData {
  readonly checkout: CheckoutSnapshot;
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
 * so create options are deliberately absent here — `useCheckout({ reference })` used to
 * type-check and then always throw.
 */
export interface UseCheckoutOptions
  extends Partial<CheckoutData>,
    Omit<CheckoutEventHandlers, "onProviderCopy" | "onStartOver"> {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
  readonly logger?: BrowserLoggerOption;
  readonly refreshStatus?: CheckoutStatusRefresh;
  /**
   * Base path the shipped router is mounted at; the hook polls
   * `${prefix}/payments/check`. Omitted, the hook renders the snapshot without
   * polling — there is nowhere to poll.
   */
  readonly prefix?: string;
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
  readonly encoder?: QrEncoder;
  readonly width?: number;
  readonly onError?: (error: unknown) => void;
}

export type ButtonComponent = React.ElementType<React.ButtonHTMLAttributes<HTMLButtonElement>>;

export interface CopyInvoiceButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly copyInvoice?: () => Promise<void>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: BrowserLoggerOption;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly copiedLabel?: React.ReactNode;
  readonly ButtonComponent?: ButtonComponent;
}

export interface OpenWalletButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly openWallet?: () => string;
  readonly open?: (uri: string) => void;
  readonly logger?: BrowserLoggerOption;
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
  // The shared checkout prop surface, DERIVED not restated: prop names, types,
  // and per-mode applicability live once in @openreceive/browser
  // (docs/internal/wrapper-parity.md). Everything after it is React doing what
  // the element cannot — component slots, class-name slots, render-prop
  // children.
  extends CheckoutComponentProps,
    CheckoutEventHandlers,
    // Omit the RDFa `prefix` attribute from HTMLAttributes so our create-mode `prefix` wins.
    // The DOM copy/error handlers are replaced by the OpenReceive ones above.
    Omit<React.HTMLAttributes<HTMLElement>, "children" | "prefix" | "onCopy" | "onError"> {
  /**
   * Create mode (`reference`, no `checkout`): the component creates the checkout against
   * `${prefix}/checkouts`, then polls `${prefix}/payments/check`. Later requests carry
   * `reference` and the displayed `payment_hash`; the host remains responsible for
   * authorization, order display, and routing. This fetch makes those create calls.
   */
  readonly createFetch?: typeof globalThis.fetch;
  /** `false` turns status polling off entirely. */
  readonly polling?: boolean;
  readonly pollIntervalMs?: number;
  readonly qrEncoder?: QrEncoder;
  readonly logger?: BrowserLoggerOption;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly components?: CheckoutComponents;
  readonly classNames?: CheckoutClassNames;
  readonly children?: CheckoutChildren;
}

export interface UseThemeOptions {
  readonly defaultTheme?: ThemePreference;
  readonly storageKey?: string;
  readonly storage?: Storage;
}

export interface UseThemeResult {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly model: ThemeModel;
  readonly nextTheme: ThemePreference;
  readonly toggleLabel: string;
  readonly attributes: ThemeModel["attributes"];
  readonly checkoutElementAttributes: ThemeModel["checkoutElementAttributes"];
  /** True when this result comes from an ancestor ThemeScope (inherit, don't re-stamp). */
  readonly fromScope: boolean;
  setTheme(theme: ThemePreference): void;
  toggleTheme(): void;
}

export interface ThemeToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly theme?: ThemePreference;
  readonly resolvedTheme?: ResolvedTheme;
  readonly onThemeChange?: (theme: ThemePreference) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export type ThemeScopeChildren = React.ReactNode | ((theme: UseThemeResult) => React.ReactNode);

export interface ThemeScopeProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly as?: keyof React.JSX.IntrinsicElements;
  readonly defaultTheme?: ThemePreference;
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
  readonly logger?: BrowserLoggerOption;
  readonly logContext?: BrowserLogContext;
  /**
   * Base path the shipped router is mounted at; the swap quote, start and refund
   * routes are derived from it. Omitted, the wizard has no swap backend and
   * shows the method grid only — which is what a standalone wizard wants.
   */
  readonly prefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly qrEncoder?: QrEncoder;
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

export type SwapOptionDisplay = CheckoutPaymentMethod;

export interface SwapOptionsResult {
  readonly enabled: boolean;
  readonly options: readonly SwapOptionDisplay[];
}

export interface SatsDetailProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly fiatCurrency?: string;
}
