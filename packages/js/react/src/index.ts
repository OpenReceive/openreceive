import * as React from "react";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_THEME_STORAGE_KEY,
  type OpenReceiveQrEncoder,
  copyInvoice as copyInvoiceHelper,
  createCheckoutController,
  createCheckoutDisplayModel,
  createCheckoutStatusModel,
  createCheckoutState,
  createOpenReceiveTickingValueController,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardController,
  createCheckoutProviderCopyEvent,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  createQrSvg,
  createQrPayloadSvg,
  createOpenReceiveThemeModel,
  createOpenReceiveTransientFeedbackController,
  formatOpenReceiveSwapLimit,
  getOpenReceiveDefaultCountryCode,
  getOpenReceiveAssetIcon,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveWizardEmptyMessage,
  createOpenReceiveSwapDisplayModel,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
  openReceiveSwapAssetMatchesRoute,
  normalizeSwapStartInvoice,
  postOpenReceiveJson,
  openWallet as openWalletHelper,
  readOpenReceiveThemePreference,
  status as deriveStatus,
  writeOpenReceiveThemePreference,
  type OpenReceiveBrowserLogContext,
  type OpenReceiveBrowserLogger,
  type CheckoutController,
  type CheckoutDisplayData,
  type CheckoutDisplayModel,
  type CheckoutPhase,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusRefresh,
  type CheckoutStatusModel,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardController,
  type OpenReceivePaymentWizardModel,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveResolvedTheme,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveTransientFeedbackController,
  type OpenReceiveThemeModel,
  type OpenReceiveThemePreference,
  type Status
} from "@openreceive/browser/internal";

export type Checkout = CheckoutSnapshot;

export interface CheckoutData {
  readonly checkout: CheckoutSnapshot;
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

export interface UseCheckoutOptions extends CheckoutData {
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
  readonly children?:
    | React.ReactNode
    | ((checkout: UseCheckoutResult) => React.ReactNode);
}

export interface QRCodeProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  readonly invoice: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly width?: number;
  readonly onError?: (error: unknown) => void;
}

export type ButtonComponent =
  React.ElementType<React.ButtonHTMLAttributes<HTMLButtonElement>>;

export interface CopyInvoiceButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly copyInvoice?: () => Promise<void>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly copiedLabel?: React.ReactNode;
  readonly ButtonComponent?: ButtonComponent;
}

export interface OpenWalletButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly openWallet?: () => string;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onOpened?: (uri: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export interface PaymentStateProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  readonly state?: string;
}

export interface InvoiceSummaryClassNames {
  readonly amount?: string;
  readonly fiat?: string;
  readonly paymentHash?: string;
  readonly paymentState?: string;
}

export interface InvoiceSummaryProps
  extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
  readonly status?: Status;
  readonly PaymentStateComponent?: React.ComponentType<PaymentStateProps>;
  readonly classNames?: InvoiceSummaryClassNames;
}

export interface CheckoutClassNames
  extends InvoiceSummaryClassNames {
  readonly root?: string;
  readonly qr?: string;
  readonly satsDetail?: string;
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

export type CheckoutChildren =
  | React.ReactNode
  | ((model: UseCheckoutResult) => React.ReactNode);

export interface CheckoutProps
  extends CheckoutData,
    Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly refreshStatus?: CheckoutStatusRefresh;
  readonly orderUrl?: string | false;
  readonly onState?: (state: CheckoutState) => void;
  readonly onSettled?: () => void;
  readonly onStartOver?: () => void;
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
  setTheme(theme: OpenReceiveThemePreference): void;
  toggleTheme(): void;
}

export interface ThemeToggleProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly theme?: OpenReceiveThemePreference;
  readonly resolvedTheme?: OpenReceiveResolvedTheme;
  readonly onThemeChange?: (theme: OpenReceiveThemePreference) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export type ThemeScopeChildren =
  | React.ReactNode
  | ((theme: UseThemeResult) => React.ReactNode);

export interface ThemeScopeProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
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
  readonly invoice: string;
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
}

type OpenReceiveSwapOptionDisplay = OpenReceiveCheckoutPaymentMethod;

interface OpenReceiveSwapOptionsResult {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOptionDisplay[];
}

function useOpenReceiveTransientValue<T>(
  resetValue: T,
  delayMs = OPENRECEIVE_COPY_FEEDBACK_MS
): readonly [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(resetValue);
  const controller = React.useRef<OpenReceiveTransientFeedbackController<T> | null>(null);

  React.useEffect(() => {
    controller.current?.clear();
    controller.current = createOpenReceiveTransientFeedbackController({
      resetValue,
      delayMs,
      onValue: setValue
    });
    return () => controller.current?.clear();
  }, [resetValue, delayMs]);

  const showValue = React.useCallback((nextValue: T) => {
    if (controller.current === null) {
      setValue(nextValue);
      return;
    }
    controller.current.show(nextValue);
  }, []);

  return [value, showValue];
}

function useOpenReceiveTickingUnixSeconds(active: boolean): number | undefined {
  const [now, setNow] = React.useState<number | undefined>(undefined);
  React.useEffect(() => {
    if (!active) {
      setNow(undefined);
      return;
    }
    const controller = createOpenReceiveTickingValueController({
      onValue: setNow
    });
    controller.start();
    return () => controller.stop();
  }, [active]);
  return now;
}

function toCheckoutDisplayData(
  snapshot: CheckoutSnapshot
): CheckoutDisplayData {
  const invoice = snapshot.active ?? snapshot.invoices[0];
  if (invoice === undefined) {
    throw new TypeError("OpenReceive checkout requires active or invoices[0].");
  }
  if (typeof invoice.invoice !== "string") {
    throw new TypeError("OpenReceive checkout requires a display Lightning invoice.");
  }
  const fiatQuote = invoice.fiat_quote === null && snapshot.fiat !== undefined
    ? { fiat: snapshot.fiat }
    : invoice.fiat_quote ?? (
      snapshot.fiat === undefined ? undefined : { fiat: snapshot.fiat }
    );
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  return {
    checkout_id: snapshot.checkout_id,
    order_id: snapshot.order_id,
    invoice_id: invoice.invoice_id,
    invoice: invoice.invoice,
    rail: invoice.rail,
    ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
    ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
    ...(fiatQuote === undefined ? {} : { fiat_quote: fiatQuote }),
    ...(invoice.transaction_state === undefined
      ? {}
      : { transaction_state: invoice.transaction_state }),
    ...(invoice.workflow_state === undefined ? {} : { workflow_state: invoice.workflow_state }),
    ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
    ...(settledAt === undefined ? {} : { settled_at: settledAt }),
    ...(invoice.swap === undefined ? {} : { swap: invoice.swap })
  };
}

function deriveCheckoutOrderStatus(snapshot: CheckoutSnapshot): Status {
  if (snapshot.status === "paid") return "settled";
  if (snapshot.status === "expired") return "expired";
  const invoice = snapshot.active ?? snapshot.invoices[0];
  return invoice === undefined ? "pending" : deriveStatus(invoice);
}

function toCheckoutViewModel(
  display: CheckoutDisplayModel,
  currentStatus: Status
): CheckoutViewModel {
  return {
    invoice_id: display.invoice_id,
    invoice: display.invoice,
    ...(display.payment_hash === undefined ? {} : { payment_hash: display.payment_hash }),
    ...(display.amount_msats === undefined ? {} : { amount_msats: display.amount_msats }),
    ...(display.fiat_quote === undefined ? {} : { fiat_quote: display.fiat_quote }),
    ...(display.expires_at === undefined ? {} : { expires_at: display.expires_at }),
    ...(display.settled_at === undefined ? {} : { settled_at: display.settled_at }),
    lightning_uri: display.lightning_uri,
    ...(display.amountLabel === undefined ? {} : { amountLabel: display.amountLabel }),
    ...(display.fiatLabel === undefined ? {} : { fiatLabel: display.fiatLabel }),
    ...(display.paymentHashLabel === undefined ? {} : { paymentHashLabel: display.paymentHashLabel }),
    status: currentStatus
  };
}

export function createCheckoutViewModel(
  data: CheckoutData
): CheckoutViewModel {
  return toCheckoutViewModel(
    createCheckoutDisplayModel(toCheckoutDisplayData(data.checkout)),
    deriveCheckoutOrderStatus(data.checkout)
  );
}

function resolveCheckoutStatusRefreshUrl(options: {
  readonly orderUrl?: string | false;
  readonly polling?: boolean;
}): string | undefined {
  if (options.polling === false || options.orderUrl === false) return undefined;
  return options.orderUrl;
}

export function useCheckout(
  options: UseCheckoutOptions
): UseCheckoutResult {
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);
  const [latestSnapshot, setLatestSnapshot] = React.useState<CheckoutSnapshot>(options.checkout);
  React.useEffect(() => {
    setLatestSnapshot(options.checkout);
  }, [options.checkout]);
  const displayData = React.useMemo(
    () => toCheckoutDisplayData(latestSnapshot),
    [latestSnapshot]
  );
  const model = React.useMemo(
    () => toCheckoutViewModel(
      createCheckoutDisplayModel(displayData),
      deriveCheckoutOrderStatus(latestSnapshot)
    ),
    [
      displayData,
      latestSnapshot
    ]
  );
  // `latestSnapshot` is already memoized above, so no extra useMemo is needed.
  const snapshot: CheckoutSnapshot = latestSnapshot;
  const [state, setState] = React.useState<CheckoutState>(
    () => createCheckoutState(snapshot, {
      logger: options.logger
    })
  );
  const controllerRef = React.useRef<CheckoutController | null>(null);
  const onStateRef = React.useRef(options.onState);
  onStateRef.current = options.onState;
  const onSettledRef = React.useRef(options.onSettled);
  onSettledRef.current = options.onSettled;
  const settledAnnouncementRef = React.useRef<{
    readonly orderId: string;
    readonly fired: boolean;
  }>({
    orderId: snapshot.order_id,
    fired: false
  });
  const logContext = React.useMemo(
    () => getCheckoutLogContext(displayData),
    [
      displayData
    ]
  );
  const refreshStatus =
    options.polling === false ? undefined : options.refreshStatus;
  const orderUrl = resolveCheckoutStatusRefreshUrl({
    orderUrl: options.orderUrl,
    polling: options.polling
  });
  // The controller owns the poll/countdown timers and pushes every poll result
  // back out through onSnapshot -> setLatestSnapshot. Seed it from the current
  // snapshot via a ref (as with onStateRef below) and recreate it only when the
  // checkout it watches changes identity. Keying this effect on the mutable
  // snapshot instead would tear the controller down on each result it produced,
  // recreating it and immediately re-polling in a tight loop.
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;
  const checkoutIdentity = `${snapshot.checkout_id} ${snapshot.order_id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkoutIdentity is an intentional recreate trigger — the effect seeds from snapshotRef, not from checkoutIdentity directly.
  React.useEffect(() => {
    const controller = createCheckoutController({
      snapshot: snapshotRef.current,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      ...(orderUrl === undefined ? {} : { orderUrl }),
      pollIntervalMs: options.pollIntervalMs,
      logger: options.logger,
      onError: options.onError,
      clipboard: options.clipboard,
      open: options.open,
      onState: (nextState) => {
        setState(nextState);
        onStateRef.current?.(nextState);
      },
      onSnapshot: setLatestSnapshot
    });
    controllerRef.current = controller;
    controller.start();
    // Refresh once immediately so the order object (and its payment_methods)
    // is available without waiting for the first poll interval.
    void controller.reloadState().catch(() => undefined);

    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [
    checkoutIdentity,
    refreshStatus,
    orderUrl,
    options.pollIntervalMs,
    options.logger,
    options.onError,
    options.clipboard,
    options.open
  ]);
  const publicStatus = deriveStatus(state);
  const richStatus = createCheckoutStatusModel(state);

  React.useEffect(() => {
    const announced = settledAnnouncementRef.current;
    if (announced.orderId !== snapshot.order_id) {
      settledAnnouncementRef.current = {
        orderId: snapshot.order_id,
        fired: false
      };
    }
  }, [snapshot.order_id]);

  React.useEffect(() => {
    const announced = settledAnnouncementRef.current;
    if (publicStatus !== "settled" || announced.fired) return;
    settledAnnouncementRef.current = {
      orderId: snapshot.order_id,
      fired: true
    };
    // UI hint only; server-side fulfillment must use the backend settlement hook.
    onSettledRef.current?.();
  }, [publicStatus, snapshot.order_id]);

  const copyInvoice = React.useCallback(async () => {
    try {
      const controller = controllerRef.current;
      if (controller === null) {
        await copyInvoiceHelper({
          invoice: displayData.invoice,
          clipboard: options.clipboard,
          logger: options.logger,
          logContext
        });
      } else {
        await controller.copyInvoice();
      }
      showCopied(true);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, displayData.invoice, options.clipboard, options.logger, options.onError, showCopied]);

  const openWallet = React.useCallback(() => {
    try {
      const controller = controllerRef.current;
      return controller === null
        ? openWalletHelper({
          invoice: displayData.invoice,
          open: options.open,
          logger: options.logger,
          logContext
        })
        : controller.openWallet();
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, displayData.invoice, options.open, options.logger, options.onError]);

  const reloadState = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.reloadState();
      if (next !== undefined) setState(next);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const retry = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.retry();
      if (next !== undefined) setState(next);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const cancel = React.useCallback(() => {
    const next = controllerRef.current?.cancel();
    if (next !== undefined) setState(next);
  }, []);

  return {
    ...model,
    checkout: latestSnapshot,
    copied,
    status: publicStatus,
    expires_in_seconds: richStatus.expires_in_seconds,
    countdownLabel: richStatus.countdownLabel,
    countdownPrefix: richStatus.countdownPrefix,
    statusTitle: richStatus.title,
    statusDetail: richStatus.detail,
    waiting: richStatus.waiting,
    reloadState,
    retry,
    cancel,
    copyInvoice,
    openWallet
  };
}

const CheckoutContext =
  React.createContext<UseCheckoutResult | null>(null);

export function useCheckoutContext(): UseCheckoutResult {
  const checkout = React.useContext(CheckoutContext);
  if (checkout === null) {
    throw new Error(
      "useCheckoutContext must be used within CheckoutProvider."
    );
  }
  return checkout;
}

export function CheckoutProvider(
  props: CheckoutProviderProps
): React.ReactElement {
  const { children, ...options } = props;
  const checkout = useCheckout(options);
  const content =
    typeof children === "function" ? children(checkout) : children;

  return React.createElement(
    CheckoutContext.Provider,
    { value: checkout },
    content
  );
}

export function QRCode(props: QRCodeProps): React.ReactElement {
  const {
    invoice,
    encoder,
    width = 256,
    onError,
    ...divProps
  } = props;
  const [svg, setSvg] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    createQrSvg(invoice, { encoder, width })
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((error) => {
        if (!cancelled) onError?.(error);
      });

    return () => {
      cancelled = true;
    };
  }, [invoice, encoder, width, onError]);

  return React.createElement("div", {
    ...divProps,
    [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr]: "",
    dangerouslySetInnerHTML: {
      __html: svg
    }
  });
}

export function CopyInvoiceButton(
  props: CopyInvoiceButtonProps
): React.ReactElement {
  const {
    invoice,
    copyInvoice,
    clipboard,
    logger,
    onCopied,
    onError,
    onClick,
    copiedLabel = openReceiveCheckoutLabels.copied,
    ButtonComponent = "button",
    children,
    type = "button",
    ...buttonProps
  } = props;
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
      type,
      onClick: async (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          if (copyInvoice === undefined) {
            await copyInvoiceHelper({ invoice, clipboard, logger });
          } else {
            await copyInvoice();
          }
          showCopied(true);
          onCopied?.();
        } catch (error) {
          onError?.(error);
        }
      }
    },
    children ?? (copied ? copiedLabel : openReceiveCheckoutLabels.copyInvoice)
  );
}

export function OpenWalletButton(
  props: OpenWalletButtonProps
): React.ReactElement {
  const {
    invoice,
    openWallet,
    open,
    logger,
    onOpened,
    onError,
    onClick,
    ButtonComponent = "button",
    children = openReceiveCheckoutLabels.openWallet,
    type = "button",
    ...buttonProps
  } = props;

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
      type,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          const uri = openWallet === undefined
            ? openWalletHelper({ invoice, open, logger })
            : openWallet();
          onOpened?.(uri);
        } catch (error) {
          onError?.(error);
        }
      }
    },
    children
  );
}

export function PaymentState(
  props: PaymentStateProps
): React.ReactElement {
  const {
    state = "pending",
    ...spanProps
  } = props;

  return React.createElement(
    "span",
    {
      ...spanProps,
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.state]: state
    },
    state
  );
}

export function useTheme(
  options: UseThemeOptions = {}
): UseThemeResult {
  const storageKey = options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY;
  const [theme, setThemeState] = React.useState<OpenReceiveThemePreference>(
    () => readOpenReceiveThemePreference({
      storage: options.storage,
      storageKey,
      defaultTheme: options.defaultTheme
    })
  );
  const [systemDark, setSystemDark] = React.useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
  );

  React.useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (media === undefined) return undefined;
    const update = () => setSystemDark(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const themeModel = createOpenReceiveThemeModel(theme, { systemDark });

  const setTheme = React.useCallback((nextTheme: OpenReceiveThemePreference) => {
    setThemeState(nextTheme);
    writeOpenReceiveThemePreference(nextTheme, {
      storage: options.storage,
      storageKey
    });
  }, [options.storage, storageKey]);

  const toggleTheme = React.useCallback(() => {
    setTheme(themeModel.nextTheme);
  }, [setTheme, themeModel.nextTheme]);

  return {
    theme,
    resolvedTheme: themeModel.resolvedTheme,
    model: themeModel,
    nextTheme: themeModel.nextTheme,
    toggleLabel: themeModel.toggleLabel,
    attributes: themeModel.attributes,
    checkoutElementAttributes: themeModel.checkoutElementAttributes,
    setTheme,
    toggleTheme
  };
}

export function ThemeToggle(
  props: ThemeToggleProps
): React.ReactElement {
  const {
    theme,
    resolvedTheme,
    onThemeChange,
    ButtonComponent = "button",
    children,
    type = "button",
    onClick,
    ...buttonProps
  } = props;
  const fallback = useTheme({
    defaultTheme: theme
  });
  const activeTheme = resolvedTheme ?? fallback.resolvedTheme;
  const themeModel = createOpenReceiveThemeModel(activeTheme);

  const componentProps: React.ButtonHTMLAttributes<HTMLButtonElement> &
    Record<string, unknown> = {
    ...buttonProps,
    "aria-label": themeModel.toggleLabel,
    className: joinClassNames(
      "or-theme-toggle-button",
      `or-theme-toggle-${themeModel.resolvedTheme}`,
      buttonProps.className
    ),
    title: themeModel.toggleLabel,
    type,
    [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle]: "",
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      onThemeChange?.(themeModel.nextTheme);
      if (onThemeChange === undefined) fallback.setTheme(themeModel.nextTheme);
    }
  };

  const defaultChildren = React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "span",
      {
        "aria-hidden": true,
        className: "or-theme-toggle-track"
      },
      React.createElement("span", {
        className: "or-theme-toggle-icon or-theme-toggle-icon-light"
      })
    ),
    React.createElement(
      "span",
      {
        className: "or-theme-toggle-label"
      },
      themeModel.toggleLabel
    )
  );

  return React.createElement(
    ButtonComponent,
    componentProps,
    children ?? defaultChildren
  );
}

export function ThemeScope(
  props: ThemeScopeProps
): React.ReactElement {
  const {
    as: Element = "div",
    defaultTheme,
    themeStorageKey,
    storage,
    themeToggle = false,
    topbarClassName,
    themeToggleClassName,
    ButtonComponent,
    children,
    ...elementProps
  } = props;
  const theme = useTheme({
    defaultTheme,
    storageKey: themeStorageKey,
    storage
  });
  const scopedChildren =
    typeof children === "function" ? children(theme) : children;

  return React.createElement(
    Element,
    {
      ...elementProps,
      ...theme.attributes
    },
    [
      themeToggle
        ? React.createElement(
          "div",
          {
            className: topbarClassName,
            key: "openreceive-theme-scope-toggle"
          },
          React.createElement(ThemeToggle, {
            className: themeToggleClassName,
            theme: theme.theme,
            resolvedTheme: theme.resolvedTheme,
            onThemeChange: theme.setTheme,
            ButtonComponent
          })
        )
        : null,
      scopedChildren
    ]
  );
}

export function WaitingState(props: {
  readonly waiting?: boolean;
  readonly phase?: CheckoutPhase;
  readonly status?: CheckoutStatusModel;
  readonly statusTitle?: string;
  readonly statusDetail?: string;
  readonly className?: string;
}): React.ReactElement {
  const status =
    props.status ??
    createCheckoutStatusModel({
      phase: props.phase,
      waiting: props.waiting ?? false
    });

  return React.createElement(
    "div",
    {
      className: joinClassNames("or-payment-status", props.className)
    },
    status.waiting
      ? React.createElement("span", {
        className: "or-spinner",
        "aria-hidden": "true"
      })
      : null,
    React.createElement(
      "div",
      null,
      React.createElement("strong", null, props.statusTitle ?? status.title),
      React.createElement("span", null, props.statusDetail ?? status.detail)
    )
  );
}

export function PaymentWizard(
  props: PaymentWizardProps
): React.ReactElement {
  const countryStorageKey =
    props.countryStorageKey ?? OPENRECEIVE_COUNTRY_STORAGE_KEY;
  const [selection, setSelection] = React.useState<OpenReceivePaymentWizardSelection>(
    () => createOpenReceivePaymentWizardController({
      storageKey: countryStorageKey,
      defaultCountryCode: getOpenReceiveDefaultCountryCode()
    }).getSelection()
  );
  const [activeTutorial, setActiveTutorial] = React.useState<{
    readonly providerId: string;
    readonly index: number;
    readonly copied: boolean;
  } | null>(null);
  const [swapStartingAsset, setSwapStartingAsset] = React.useState<string | null>(null);
  const [startedSwapInvoice, setStartedSwapInvoice] =
    React.useState<CheckoutInvoiceSnapshot | null>(null);
  const [dismissedSwapInvoiceId, setDismissedSwapInvoiceId] = React.useState<string | null>(null);
  const [swapQuotes, setSwapQuotes] = React.useState<
    Record<string, OpenReceiveSwapOptionDisplay>
  >({});
  // When a swap provider is configured, each pay-in coin is promoted to a top-level
  // choice. Selecting one jumps straight to its deposit address, bypassing the
  // country/route/provider steps. Null means the standard method grid is shown.
  const [selectedSwapAsset, setSelectedSwapAsset] = React.useState<string | null>(null);
  const autoSwapAttemptedRef = React.useRef<Set<string>>(new Set());
  const fetcher = props.fetch ?? globalThis.fetch;
  const checkout = props.checkout;
  const orderId = checkout?.order_id;
  // Payable assets ride on the order object itself (payment_methods), so the
  // wizard lists methods straight from the polled order snapshot — no extra call.
  const swapOptions = React.useMemo<OpenReceiveSwapOptionsResult>(() => {
    const methods = checkout?.payment_methods ?? [];
    return { enabled: methods.length > 0, options: methods };
  }, [checkout]);

  const currentSwapInvoice = React.useMemo(
    () => selectCurrentSwapInvoice(checkout, startedSwapInvoice, dismissedSwapInvoiceId),
    [checkout, startedSwapInvoice, dismissedSwapInvoiceId]
  );
  const now = useOpenReceiveTickingUnixSeconds(currentSwapInvoice !== undefined);
  const startSwap = React.useCallback(
    async (payInAsset: string) => {
      if (
        props.orderUrl === undefined ||
        props.orderUrl === false ||
        orderId === undefined ||
        fetcher === undefined
      ) {
        return;
      }
      setSwapStartingAsset(payInAsset);
      try {
        const body = await postOpenReceiveJson(fetcher, props.orderUrl, {
          order_id: orderId,
          action: "start_swap",
          pay_in_asset: payInAsset
        });
        const invoice = normalizeSwapStartInvoice(body);
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      } finally {
        setSwapStartingAsset(null);
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError]
  );
  const quoteSwap = React.useCallback(
    async (payInAsset: string): Promise<OpenReceiveSwapOptionDisplay | undefined> => {
      if (
        props.orderUrl === undefined ||
        props.orderUrl === false ||
        orderId === undefined ||
        fetcher === undefined
      ) {
        return undefined;
      }
      try {
        const body = await postOpenReceiveJson(fetcher, props.orderUrl, {
          order_id: orderId,
          action: "swap_quote",
          pay_in_asset: payInAsset
        });
        const quote = normalizeSwapQuote(body);
        if (quote !== undefined) {
          setSwapQuotes((current) => ({ ...current, [payInAsset]: quote }));
        }
        return quote;
      } catch (error) {
        props.onError?.(error);
        return undefined;
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError]
  );
  const refundSwap = React.useCallback(
    async (
      attemptId: string,
      refundAddress: string,
      refundNonce: string,
      confirm: boolean
    ) => {
      if (
        props.orderUrl === undefined ||
        props.orderUrl === false ||
        orderId === undefined ||
        fetcher === undefined
      ) {
        return;
      }
      try {
        const body = await postOpenReceiveJson(fetcher, props.orderUrl, {
          order_id: orderId,
          action: "refund_swap",
          attempt_id: attemptId,
          refund_address: refundAddress,
          refund_nonce: refundNonce,
          confirm
        });
        const invoice = normalizeSwapStartInvoice(body);
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError]
  );
  const updateWizardSelection = React.useCallback(
    (
      apply: (
        controller: OpenReceivePaymentWizardController
      ) => OpenReceivePaymentWizardSelection
    ) => {
      setSelection((current) =>
        apply(createOpenReceivePaymentWizardController({
          selection: current,
          storageKey: countryStorageKey
        }))
      );
    },
    [countryStorageKey]
  );
  const model = createOpenReceivePaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute
  });
  const routeDisplays = createOpenReceiveWizardRouteDisplays(wizard.routes);
  const showRoutePicker =
    routeAssetDisplays.length > 0 &&
    (model.selectedRoute === null || routeDisplays.length === 0);
  const activeTutorialProvider = activeTutorial === null
    ? undefined
    : routeDisplays
      .flatMap((route) => route.providers)
      .find((provider) => provider.id === activeTutorial.providerId);
  // Top-level swap coins, one per configured pay-in asset (e.g. ETH on Ethereum,
  // USDT on Tron). Only present once the order status reports swaps are enabled.
  const swapAssetOptions = swapOptions.enabled
    ? swapOptions.options.filter((option) => option.provider.length > 0)
    : [];
  // Diagnostic: logs the per-asset availability + invoice limits the client received,
  // so we can see whether out-of-range assets should be disabled. Keyed on a signature
  // so it only logs when availability actually changes. Remove once confirmed.
  const swapOptionsSignature = swapAssetOptions
    .map(
      (option) =>
        `${option.pay_in_asset}:${option.available}:${option.unavailable_reason ?? ""}:${option.minimum_invoice_amount_msats ?? ""}`,
    )
    .join("|");
  React.useEffect(() => {
    if (props.logger === undefined || swapAssetOptions.length === 0) return;
    props.logger({
      level: "info",
      event: "swap.options.debug",
      message: "Swap pay options and availability.",
      amount_msats: checkout?.amount_msats,
      fiat: checkout?.fiat,
      options: swapAssetOptions.map((option) => ({
        pay_in_asset: option.pay_in_asset,
        available: option.available,
        unavailable_reason: option.unavailable_reason,
        unavailable_message: option.unavailable_message,
        minimum_invoice_amount_msats: option.minimum_invoice_amount_msats,
        maximum_invoice_amount_msats: option.maximum_invoice_amount_msats,
        minimum_pay_amount: option.minimum_pay_amount,
        maximum_pay_amount: option.maximum_pay_amount,
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapOptionsSignature, props.logger]);
  const activeSwapForAsset =
    selectedSwapAsset === null
      ? undefined
      : currentSwapInvoice !== undefined &&
          currentSwapInvoice.swap?.pay_in_asset === selectedSwapAsset
        ? currentSwapInvoice
        : undefined;

  // Selecting a top-level coin quotes it (to confirm the amount is in range) and, when
  // available, starts the swap so the payer lands on the deposit address immediately.
  React.useEffect(() => {
    if (selectedSwapAsset === null) return;
    if (props.orderUrl === undefined || props.orderUrl === false) return;
    if (activeSwapForAsset !== undefined) return;
    if (autoSwapAttemptedRef.current.has(selectedSwapAsset)) return;
    autoSwapAttemptedRef.current.add(selectedSwapAsset);
    const asset = selectedSwapAsset;
    let cancelled = false;
    void (async () => {
      const quote = await quoteSwap(asset);
      if (cancelled || quote === undefined || !quote.available) return;
      await startSwap(asset);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSwapAsset, activeSwapForAsset, props.orderUrl, quoteSwap, startSwap]);

  const selectedSwapOption =
    selectedSwapAsset === null
      ? undefined
      : (swapAssetOptions.find((option) => option.pay_in_asset === selectedSwapAsset) ??
        swapQuotes[selectedSwapAsset]);
  const selectedSwapQuote =
    selectedSwapAsset === null ? undefined : swapQuotes[selectedSwapAsset];
  const selectedSwapLabel = selectedSwapOption?.label ?? "this coin";

  if (selectedSwapAsset !== null) {
    return React.createElement(
      "div",
      {
        className: joinClassNames("or-wizard", props.className)
      },
      renderWizardBackBreadcrumb(
        selectedSwapOption === undefined
          ? selectedSwapLabel
          : `${selectedSwapOption.label} · ${selectedSwapOption.network_label}`,
        () => setSelectedSwapAsset(null)
      ),
      React.createElement(
        "div",
        {
          className: "or-wizard-results"
        },
        activeSwapForAsset !== undefined
          ? renderSwapDepositPanel({
            invoice: activeSwapForAsset,
            now,
            encoder: props.qrEncoder,
            clipboard: props.clipboard,
            logger: props.logger,
            onError: props.onError,
            onRefund: refundSwap,
            onBackToLightning: () => {
              setDismissedSwapInvoiceId(activeSwapForAsset.invoice_id);
              setSelectedSwapAsset(null);
            }
          })
          : selectedSwapQuote !== undefined && !selectedSwapQuote.available
            ? renderSwapUnavailable(selectedSwapQuote, checkout)
            : renderSwapPreparing(selectedSwapLabel)
      )
    );
  }

  return React.createElement(
    "div",
    {
      className: joinClassNames("or-wizard", props.className)
    },
    selection.selectedMethod === null
      ? React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          {
            className: "or-wizard-header"
          },
          React.createElement(
            "div",
            null,
            React.createElement("h2", null, openReceiveCheckoutLabels.wizardTitle),
            React.createElement("p", null, openReceiveCheckoutLabels.wizardSubtitle)
          )
        ),
        React.createElement(
          "div",
          {
            className: "or-method-grid"
          },
          (swapAssetOptions.length > 0
            ? openReceivePaymentMethods.filter((method) => method.id !== "crypto")
            : openReceivePaymentMethods
          ).map((method) =>
            React.createElement(
              "button",
              {
                key: method.id,
                onClick: () => {
                  updateWizardSelection((controller) =>
                    controller.selectMethod(method.id)
                  );
                },
                type: "button"
              },
              React.createElement("img", { alt: "", src: getOpenReceivePaymentMethodIcon(method.id) }),
              React.createElement("span", null, method.title),
              React.createElement("small", null, method.detail)
            )
          ),
          swapAssetOptions.map((option) => {
            // An asset whose provider limits exclude this invoice amount is shown
            // greyed-out and non-clickable, with a short reason (e.g. the minimum
            // payment) in place of its network label.
            const disabled = option.available === false;
            const limitMessage = swapOptionLimitMessage(option, checkout);
            return React.createElement(
              "button",
              {
                key: option.pay_in_asset,
                className: disabled ? "or-method-unavailable" : undefined,
                disabled,
                "aria-disabled": disabled ? "true" : undefined,
                onClick: disabled
                  ? undefined
                  : () => {
                    autoSwapAttemptedRef.current.delete(option.pay_in_asset);
                    setSelectedSwapAsset(option.pay_in_asset);
                  },
                type: "button"
              },
              React.createElement("img", {
                alt: "",
                src: getOpenReceiveAssetIcon(option.label.toLowerCase())
              }),
              React.createElement("span", null, option.label),
              React.createElement(
                "small",
                null,
                disabled && limitMessage !== undefined ? limitMessage : option.network_label
              )
            );
          })
        )
      )
      : null,
    selection.selectedMethod === null
      ? null
      : renderWizardBreadcrumbs({
        method: selection.selectedMethod,
        selectedRoute: model.selectedRoute,
        routeAssets: routeAssetDisplays,
        onChangeMethod: () => {
          updateWizardSelection((controller) =>
            controller.changeMethod()
          );
        },
        onChangeRoute: () => {
          updateWizardSelection((controller) =>
            controller.update({ type: "change_route" })
          );
        }
      }),
    showRoutePicker && selection.selectedMethod === "bitcoin"
      ? renderRoutePicker({
        assets: routeAssetDisplays,
        method: "bitcoin",
        onSelectRoute: (route) => {
          updateWizardSelection((controller) =>
            controller.selectRoute(route)
          );
        }
      })
      : null,
    showRoutePicker && selection.selectedMethod === "crypto"
      ? renderRoutePicker({
        assets: routeAssetDisplays,
        method: "crypto",
        onSelectRoute: (route) => {
          updateWizardSelection((controller) =>
            controller.selectRoute(route)
          );
        }
      })
      : null,
    selection.selectedMethod === null
      ? null
      : React.createElement(
        "div",
        {
          className: "or-wizard-results"
        },
        routeDisplays.length === 0
          ? React.createElement(
            "p",
            {
              className: "or-wizard-empty"
            },
            getOpenReceiveWizardEmptyMessage(selection.selectedMethod)
          )
          : routeDisplays.map((route) => {
            const routeSwapOptions = swapOptionsForRoute(route.key, swapOptions.options);
            const activeSwapForRoute =
              currentSwapInvoice !== undefined &&
              openReceiveSwapAssetMatchesRoute(route.key, currentSwapInvoice.swap?.pay_in_asset)
                ? currentSwapInvoice
                : undefined;
            return React.createElement(
              "section",
              {
                className: "or-wizard-route",
                key: route.key
              },
              React.createElement(
                "div",
                {
                  className: "or-wizard-route-heading"
                },
                React.createElement(
                  "div",
                  null,
                  React.createElement(
                    "h3",
                    null,
                    route.title,
                    wizard.selectedRail === null
                      ? null
                      : renderCountrySelect({
                        countries: model.countryDisplays,
                        selectedCountryCode: selection.selectedCountryCode,
                        onSelectCountry: (countryCode) => {
                          updateWizardSelection((controller) =>
                            controller.selectCountry(countryCode)
                          );
                        }
                      })
                  )
                )
              ),
              activeSwapForRoute === undefined
                ? renderSwapActions({
                  options: routeSwapOptions,
                  enabled: swapOptions.enabled,
                  startingAsset: swapStartingAsset,
                  onStart: startSwap,
                  checkout
                })
                : renderSwapDepositPanel({
                  invoice: activeSwapForRoute,
                  now,
                  encoder: props.qrEncoder,
                  clipboard: props.clipboard,
                  logger: props.logger,
                  onError: props.onError,
                  onRefund: refundSwap,
                  onBackToLightning: () => {
                    setDismissedSwapInvoiceId(activeSwapForRoute.invoice_id);
                  }
                }),
              activeSwapForRoute === undefined
                ? React.createElement(
                  "div",
                  {
                    className: "or-provider-grid"
                  },
                  route.providers.map((provider) =>
                    React.createElement(
                      "article",
                      {
                        className: provider.recommended
                          ? "or-provider-card recommended"
                          : "or-provider-card",
                        key: provider.id
                      },
                      React.createElement(
                        "div",
                        {
                          className: "or-provider-heading"
                        },
                        React.createElement("img", {
                          alt: "",
                          src: provider.icon
                        }),
                        React.createElement("h4", null, provider.name),
                        provider.recommendedLabel === null
                          ? null
                          : React.createElement("span", null, provider.recommendedLabel)
                      ),
                      React.createElement(
                        "p",
                        {
                          className: "or-provider-kind"
                        },
                        provider.kind
                      ),
                      React.createElement(
                        "div",
                        {
                          className: "or-provider-actions"
                        },
                        renderProviderOpenAction(provider, () => setActiveTutorial({
                          providerId: provider.id,
                          index: 0,
                          copied: false
                        }))
                      )
                    )
                  )
                )
                : null
            );
          })
      ),
    activeTutorialProvider === undefined || activeTutorial === null
      ? null
      : renderProviderTutorialModal({
        provider: activeTutorialProvider,
        index: activeTutorial.index,
        copied: activeTutorial.copied,
        onClose: () => setActiveTutorial(null),
        onCopy: async () => {
          try {
            await copyInvoiceHelper({
              invoice: props.invoice,
              logger: props.logger,
              logContext: props.logContext
            });
            globalThis.dispatchEvent?.(
              createCheckoutProviderCopyEvent(activeTutorialProvider.id)
            );
            setActiveTutorial({
              providerId: activeTutorialProvider.id,
              index: 0,
              copied: true
            });
          } catch (error) {
            props.onError?.(error);
          }
        },
        onStep: (index) => setActiveTutorial({
          providerId: activeTutorialProvider.id,
          index,
          copied: activeTutorial.copied
        })
      })
  );
}

function renderWizardBackBreadcrumb(
  currentLabel: string,
  onBack: () => void
): React.ReactElement {
  return React.createElement(
    "div",
    {
      className: "or-wizard-breadcrumbs"
    },
    React.createElement(
      "button",
      {
        className: "or-wizard-breadcrumb",
        onClick: onBack,
        type: "button"
      },
      openReceiveCheckoutLabels.paymentMethod
    ),
    React.createElement("span", { className: "or-wizard-breadcrumb-separator", "aria-hidden": "true" }, "/"),
    React.createElement("span", { className: "or-wizard-breadcrumb-current" }, currentLabel)
  );
}

function renderWizardBreadcrumbs(options: {
  readonly method: OpenReceivePaymentMethod;
  readonly selectedRoute: string | null;
  readonly routeAssets: readonly OpenReceiveWizardRouteAssetDisplay[];
  readonly onChangeMethod: () => void;
  readonly onChangeRoute: () => void;
}): React.ReactElement {
  const method = openReceivePaymentMethods.find((candidate) => candidate.id === options.method);
  const methodLabel = method?.title ?? openReceiveCheckoutLabels.paymentMethod;
  const routeLabel = options.selectedRoute === null || options.routeAssets.length <= 1
    ? null
    : options.routeAssets.find((asset) => asset.id === options.selectedRoute)?.label ?? options.selectedRoute;

  return React.createElement(
    "nav",
    {
      "aria-label": "Payment path",
      className: "or-wizard-breadcrumbs"
    },
    React.createElement(
      "button",
      {
        className: "or-wizard-breadcrumb",
        onClick: options.onChangeMethod,
        type: "button"
      },
      openReceiveCheckoutLabels.paymentMethod
    ),
    React.createElement("span", { "aria-hidden": "true" }, "/"),
    routeLabel === null
      ? React.createElement("span", { className: "or-wizard-breadcrumb-current" }, methodLabel)
      : React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            className: "or-wizard-breadcrumb",
            onClick: options.onChangeRoute,
            type: "button"
          },
          methodLabel
        ),
        React.createElement("span", { "aria-hidden": "true" }, "/"),
        React.createElement("span", { className: "or-wizard-breadcrumb-current" }, routeLabel)
      )
  );
}

// Short reason to show for an out-of-range swap asset. Prefers a fiat figure
// ("Minimum payment $10.00") converted from the invoice-side limit using the
// checkout's own rate, falling back to the provider's generic message.
function swapOptionLimitMessage(
  option: OpenReceiveSwapOptionDisplay,
  checkout: CheckoutSnapshot | undefined,
): string | undefined {
  if (option.available !== false) return undefined;
  // Prefer a fiat figure ("Minimum payment $10.00"); fall back to the pay-in asset's
  // own units ("Minimum 5 USDT") when the provider only reports pay-side limits.
  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.minimum_invoice_amount_msats);
    if (fiat !== undefined) return `Minimum payment ${fiat}`;
    if (option.minimum_pay_amount !== undefined) {
      return `Minimum ${option.minimum_pay_amount} ${option.label}`;
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.maximum_invoice_amount_msats);
    if (fiat !== undefined) return `Maximum payment ${fiat}`;
    if (option.maximum_pay_amount !== undefined) {
      return `Maximum ${option.maximum_pay_amount} ${option.label}`;
    }
  }
  return option.unavailable_message;
}

function renderSwapActions(options: {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOptionDisplay[];
  readonly startingAsset: string | null;
  readonly onStart: (payInAsset: string) => Promise<void>;
  readonly checkout?: CheckoutSnapshot;
}): React.ReactElement | null {
  // Out-of-range assets are kept in the list but rendered as a disabled button
  // with the limit reason, instead of being hidden.
  const shown = options.options.filter((option) => option.provider.length > 0);
  if (!options.enabled || shown.length === 0) return null;

  return React.createElement(
    "div",
    {
      className: "or-swap-actions"
    },
    shown.map((option) => {
      const disabled = option.available === false;
      const limitMessage = swapOptionLimitMessage(option, options.checkout);
      return React.createElement(
        "div",
        {
          className: "or-swap-action",
          key: option.pay_in_asset
        },
        disabled
          ? limitMessage === undefined
            ? null
            : React.createElement("p", { className: "or-swap-warning" }, limitMessage)
          : option.pay_amount === undefined
            ? null
            : React.createElement(
              "p",
              {
                className: "or-swap-estimate"
              },
              `Estimated ${option.pay_amount} ${option.label} to settle this checkout.`
            ),
        React.createElement(
          "button",
          {
            className: "or-swap-start",
            disabled: disabled || options.startingAsset !== null,
            onClick: disabled
              ? undefined
              : () => {
                void options.onStart(option.pay_in_asset);
              },
            type: "button"
          },
          options.startingAsset === option.pay_in_asset
            ? "Preparing..."
            : `Create ${option.label} (${option.network_label}) payment address`
        )
      );
    })
  );
}

function renderSwapPreparing(assetLabel: string): React.ReactElement {
  return React.createElement(
    "section",
    {
      className: "or-swap-panel"
    },
    React.createElement(
      "div",
      {
        className: "or-swap-heading"
      },
      React.createElement("strong", null, "Preparing payment address"),
      React.createElement("span", null, "One moment")
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-progress"
      },
      `Getting your ${assetLabel} payment address…`
    )
  );
}

function renderSwapUnavailable(
  quote: OpenReceiveSwapOptionDisplay,
  checkout: CheckoutSnapshot | undefined,
): React.ReactElement {
  const detail =
    swapOptionLimitMessage(quote, checkout) ??
    quote.unavailable_message ??
    `${quote.label} is not available for this amount.`;
  const range =
    quote.minimum_pay_amount === undefined
      ? undefined
      : quote.maximum_pay_amount === undefined
        ? `Minimum ${quote.minimum_pay_amount} ${quote.label}.`
        : `Accepted range: ${quote.minimum_pay_amount}–${quote.maximum_pay_amount} ${quote.label}.`;
  return React.createElement(
    "section",
    {
      className: "or-swap-panel"
    },
    React.createElement(
      "div",
      {
        className: "or-swap-heading"
      },
      React.createElement("strong", null, `${quote.label} unavailable`)
    ),
    React.createElement("p", { className: "or-swap-warning" }, detail),
    range === undefined
      ? null
      : React.createElement("p", { className: "or-swap-warning" }, range),
    React.createElement(
      "p",
      {
        className: "or-swap-progress"
      },
      "Choose another asset above, or pay the Lightning invoice at the top of this page."
    )
  );
}

function renderSwapDepositPanel(options: {
  readonly invoice: CheckoutInvoiceSnapshot;
  readonly now?: number;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean
  ) => Promise<void>;
  readonly onBackToLightning: () => void;
}): React.ReactElement | null {
  const display = createOpenReceiveSwapDisplayModel(
    options.invoice,
    options.now === undefined ? {} : { now: options.now }
  );
  if (display === undefined) return null;
  const memo = display.depositMemo;
  const backButton = React.createElement(
    "button",
    {
      className: "or-swap-back",
      onClick: options.onBackToLightning,
      type: "button"
    },
    "Pay with Lightning instead"
  );
  const heading = React.createElement(
    "div",
    {
      className: "or-swap-heading"
    },
    React.createElement("strong", null, display.providerStateLabel),
    React.createElement("span", null, display.providerStateDetail)
  );

  if (display.state === "creating") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      React.createElement("p", { className: "or-swap-progress" }, "Preparing payment address."),
      backButton
    );
  }

  if (display.state === "progress") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      renderSwapSupportDetails(display, options)
    );
  }

  if (display.state === "expired") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      React.createElement(
        "p",
        {
          className: "or-swap-warning"
        },
        "This payment address expired without a detected payment. Create a new payment address to try again."
      ),
      renderSwapSupportDetails(display, options),
      backButton
    );
  }

  if (display.state === "refund_required") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      React.createElement(
        "p",
        {
          className: "or-swap-warning"
        },
        `Use a ${display.networkLabel} address you control. Do not paste the deposit address.`
      ),
      React.createElement(SwapRefundForm, {
        attemptId: display.attemptId,
        networkLabel: display.networkLabel,
        submittedRefundAddress: display.refundAddress,
        refundNonce: display.refundNonce,
        onRefund: options.onRefund,
        onError: options.onError
      }),
      renderSwapSupportDetails(display, options)
    );
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      React.createElement(
        "dl",
        {
          className: "or-swap-details"
        },
        display.refundAddress === undefined
          ? null
          : renderSwapCopyRow("Refund address", display.refundAddress, options),
        display.refundTxId === undefined
          ? null
          : renderSwapCopyRow("Refund transaction", display.refundTxId, options)
      ),
      renderSwapSupportDetails(display, options)
    );
  }

  if (display.state === "attention" || display.state === "failed") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel"
      },
      heading,
      React.createElement("p", { className: "or-swap-warning" }, "This payment needs support review."),
      renderSwapSupportDetails(display, options),
      backButton
    );
  }

  return React.createElement(
    "section",
    {
      className: "or-swap-panel"
    },
    heading,
    React.createElement(
      "p",
      {
        className: "or-swap-instruction"
      },
      "Pay ",
      React.createElement("strong", null, `${display.depositAmount} ${display.assetLabel}`),
      " to this address"
    ),
    React.createElement(SwapPayloadQRCode, {
      payload: display.qrPayload,
      encoder: options.encoder,
      onError: options.onError
    }),
    React.createElement(
      "dl",
      {
        className: "or-swap-details"
      },
      renderSwapCopyRow("Address", display.depositAddress, options),
      memo === undefined
        ? null
        : renderSwapCopyRow("Memo", memo, options),
      renderSwapCopyRow("Amount", display.depositAmount, options)
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-warning"
      },
      display.networkWarning
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-countdown"
      },
      "Payment window ",
      React.createElement("strong", null, display.countdownLabel)
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-warning"
      },
      `Pay with one method only. If you already sent ${display.assetLabel}, do not also pay the Lightning invoice.`
    ),
    backButton
  );
}

function renderSwapCopyRow(
  label: string,
  value: string,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  }
): readonly React.ReactElement[] {
  return [
    React.createElement("dt", { key: `${label}-label` }, label),
    React.createElement(
      "dd",
      { key: `${label}-value` },
      React.createElement("code", null, value),
      React.createElement(
        "button",
        {
          onClick: () => {
            void copyOpenReceiveText(value, options.clipboard).catch(options.onError);
          },
          type: "button"
        },
        "Copy"
      )
    )
  ];
}

function renderSwapSupportDetails(
  display: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  }
): React.ReactElement | null {
  const rows = [
    ...(display.depositTxId === undefined
      ? []
      : renderSwapCopyRow("Deposit transaction", display.depositTxId, options)),
    ...(display.payoutTxId === undefined
      ? []
      : renderSwapCopyRow("Lightning payout", display.payoutTxId, options)),
    ...(display.refundTxId === undefined
      ? []
      : renderSwapCopyRow("Refund transaction", display.refundTxId, options)),
    ...(display.providerOrderId === undefined
      ? []
      : renderSwapCopyRow("Provider order", display.providerOrderId, options))
  ];
  if (rows.length === 0) return null;
  return React.createElement(
    "details",
    {
      className: "or-swap-support"
    },
    React.createElement("summary", null, "Payment details"),
    React.createElement("dl", { className: "or-swap-details" }, rows)
  );
}

function SwapRefundForm(props: {
  readonly attemptId: string;
  readonly networkLabel: string;
  readonly submittedRefundAddress?: string;
  readonly refundNonce?: string;
  readonly onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean
  ) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [refundAddress, setRefundAddress] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const address = refundAddress.trim();
  const confirm =
    address.length > 0 &&
    props.submittedRefundAddress !== undefined &&
    props.submittedRefundAddress === address;
  const disabled = submitting || props.refundNonce === undefined;
  return React.createElement(
    "form",
    {
      className: "or-swap-refund",
      onSubmit: (event) => {
        event.preventDefault();
        if (address.length === 0 || props.refundNonce === undefined) return;
        setSubmitting(true);
        void props.onRefund(props.attemptId, address, props.refundNonce, confirm)
          .catch(props.onError)
          .finally(() => setSubmitting(false));
      }
    },
    props.submittedRefundAddress === undefined
      ? null
      : React.createElement(
        "p",
        {
          className: "or-swap-warning"
        },
        `Confirm refund to ${props.submittedRefundAddress}.`
      ),
    React.createElement("input", {
      autoComplete: "off",
      onChange: (event) => setRefundAddress(event.currentTarget.value),
      placeholder: `${props.networkLabel} refund address`,
      required: true,
      type: "text",
      value: refundAddress
    }),
    React.createElement(
      "button",
      {
        disabled,
        type: "submit"
      },
      submitting ? "Submitting..." : confirm ? "Confirm refund" : "Review refund address"
    )
  );
}

function SwapPayloadQRCode(props: {
  readonly payload: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [svg, setSvg] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    createQrPayloadSvg(props.payload, { encoder: props.encoder, width: 220 })
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((error) => {
        if (!cancelled) props.onError?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.payload, props.encoder, props.onError]);

  const imageSource = svg.length === 0
    ? undefined
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return React.createElement("img", {
    alt: "",
    className: "or-swap-qr",
    src: imageSource
  });
}

function swapOptionsForRoute(
  routeKey: string,
  options: readonly OpenReceiveSwapOptionDisplay[]
): readonly OpenReceiveSwapOptionDisplay[] {
  return options.filter((option) => openReceiveSwapAssetMatchesRoute(routeKey, option.pay_in_asset));
}

// The pay-in asset to auto-advance to a deposit address, or undefined when the payer
// should still choose (fiat rails, multi-network stablecoins, no swap configured).
function normalizeSwapQuote(body: unknown): OpenReceiveSwapOptionDisplay | undefined {
  const quote = reactRecord(reactRecord(body).quote ?? body);
  return typeof quote.pay_in_asset === "string"
    ? (quote as unknown as OpenReceiveSwapOptionDisplay)
    : undefined;
}

function selectCurrentSwapInvoice(
  checkout: CheckoutSnapshot | undefined,
  local: CheckoutInvoiceSnapshot | null,
  dismissedInvoiceId: string | null
): CheckoutInvoiceSnapshot | undefined {
  const fromCheckout = checkout?.invoices.find((invoice) =>
    invoice.rail === "swap" && invoice.swap !== undefined && invoice.invoice_id !== dismissedInvoiceId
  );
  if (local === null || local.invoice_id === dismissedInvoiceId) return fromCheckout;
  return checkout?.invoices.find((invoice) => invoice.invoice_id === local.invoice_id) ?? local;
}

async function copyOpenReceiveText(
  text: string,
  clipboard?: Pick<Clipboard, "writeText">
): Promise<void> {
  const target = clipboard ?? globalThis.navigator?.clipboard;
  if (target === undefined) throw new Error("Clipboard API is unavailable.");
  await target.writeText(text);
}

function reactRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renderProviderOpenAction(
  provider: OpenReceiveWizardProviderDisplay,
  onOpenTutorial: () => void
): React.ReactElement {
  if (provider.tutorials.length === 0) {
    return React.createElement(
      "a",
      {
        href: provider.url,
        rel: "noreferrer",
        target: "_blank"
      },
      provider.openLabel
    );
  }

  return React.createElement(
    "button",
    {
      className: "or-provider-open",
      onClick: onOpenTutorial,
      type: "button"
    },
    provider.openLabel
  );
}

function renderProviderTutorialModal(options: {
  readonly provider: OpenReceiveWizardProviderDisplay;
  readonly index: number;
  readonly copied: boolean;
  readonly onClose: () => void;
  readonly onCopy: () => Promise<void>;
  readonly onStep: (index: number) => void;
}): React.ReactElement | null {
  const { provider } = options;
  if (provider.tutorials.length === 0) return null;
  const totalSteps = provider.tutorials.length + 1;
  const stepIndex = Math.max(0, Math.min(provider.tutorials.length, options.index));
  const tutorial = stepIndex === 0 ? undefined : provider.tutorials[stepIndex - 1];
  const previousIndex = Math.max(0, stepIndex - 1);
  const nextIndex = Math.min(provider.tutorials.length, stepIndex + 1);
  const isFinalStep = stepIndex === provider.tutorials.length;

  return React.createElement(
    "div",
    {
      "aria-label": `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`,
      "aria-modal": true,
      className: "or-tutorial-modal",
      onClick: (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) options.onClose();
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") options.onClose();
      },
      role: "dialog",
      tabIndex: -1
    },
    React.createElement(
      "div",
      {
        className: "or-tutorial-dialog"
      },
      React.createElement(
        "div",
        {
          className: "or-tutorial-header"
        },
        React.createElement(
          "div",
          {
            className: "or-tutorial-title"
          },
          React.createElement("img", {
            alt: "",
            className: "or-tutorial-header-logo",
            src: provider.icon
          }),
          React.createElement(
            "h3",
            null,
            `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`
          )
        ),
        React.createElement(
          "button",
          {
            "aria-label": "Close",
            className: "or-tutorial-close",
            onClick: options.onClose,
            type: "button"
          },
          "X"
        )
      ),
      stepIndex === 0
        ? React.createElement(
          "div",
          {
            className: "or-tutorial-intro"
          },
          React.createElement("img", {
            alt: "",
            className: "or-tutorial-provider-logo",
            src: provider.icon
          }),
          React.createElement(
            "p",
            null,
            `${openReceiveCheckoutLabels.tutorialIntroPrefix} ${provider.name}.`
          ),
          React.createElement(
            "p",
            null,
            openReceiveCheckoutLabels.tutorialIntroCopy
          ),
          React.createElement(
            "button",
            {
              className: "or-tutorial-copy",
              onClick: () => void options.onCopy(),
              type: "button"
            },
            openReceiveCheckoutLabels.copyInvoice
          ),
          options.copied
            ? React.createElement(
              "p",
              {
                className: "or-tutorial-copy-message"
              },
              openReceiveCheckoutLabels.tutorialCopiedContinue
            )
            : null
        )
        : React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            {
              className: "or-tutorial-frame"
            },
            React.createElement("img", {
              alt: tutorial?.caption ?? "",
              className: "or-tutorial-image",
              src: tutorial?.image ?? ""
            })
          ),
          React.createElement("p", {
            className: "or-tutorial-caption"
          }, tutorial?.caption ?? "")
        ),
      React.createElement(
        "div",
        {
          "aria-hidden": "true",
          className: "or-tutorial-steps"
        },
        Array.from({ length: totalSteps }, (_, index) =>
          React.createElement("span", {
            className: index === stepIndex
              ? "or-tutorial-step active"
              : "or-tutorial-step",
            key: index
          })
        )
      ),
      React.createElement(
        "p",
        {
          className: "or-tutorial-progress"
        },
        `Step ${stepIndex + 1} of ${totalSteps}`
      ),
      React.createElement(
        "div",
        {
          className: "or-tutorial-controls"
        },
        React.createElement(
          "button",
          {
            disabled: stepIndex === 0,
            onClick: () => options.onStep(previousIndex),
            type: "button"
          },
          "Back"
        ),
        React.createElement(
          "button",
          {
            onClick: () => {
              if (isFinalStep) {
                options.onClose();
                return;
              }
              options.onStep(nextIndex);
            },
            type: "button"
          },
          isFinalStep ? openReceiveCheckoutLabels.tutorialExit : "Next"
        )
      )
    )
  );
}

export function InvoiceSummary(
  props: InvoiceSummaryProps
): React.ReactElement {
	  const {
	    amountLabel,
	    fiatLabel,
	    status,
    PaymentStateComponent = PaymentState,
    classNames,
    className,
    ...divProps
  } = props;

  return React.createElement(
    "div",
    {
      ...divProps,
      className,
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.meta]: ""
    },
    amountLabel === undefined
      ? null
      : React.createElement(
        "span",
        {
          className: classNames?.amount
        },
        amountLabel
      ),
    fiatLabel === undefined
      ? null
      : React.createElement(
        "span",
        {
          className: classNames?.fiat
        },
        fiatLabel
      ),
    status === undefined
      ? null
      : React.createElement(PaymentStateComponent, {
        state: status,
        className: classNames?.paymentState
      })
  );
}

export interface SatsDetailProps
  extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
}

export function SatsDetail(
  props: SatsDetailProps
): React.ReactElement | null {
  const {
    amountLabel,
    className,
    ...divProps
  } = props;

  if (amountLabel === undefined) return null;

  return React.createElement(
    "div",
    {
      ...divProps,
      className: joinClassNames("or-sats-detail", className)
    },
    amountLabel
  );
}

export function Checkout(
  props: CheckoutProps
): React.ReactElement {
  const {
    checkout,
    qrEncoder,
    logger,
    onError,
    refreshStatus,
    orderUrl,
    onState,
    onSettled,
    onStartOver,
    polling,
    paymentWizard = true,
    themeSwitcher = false,
    defaultTheme,
    themeStorageKey,
    countryStorageKey,
    components,
    classNames,
    children,
    className,
    ...sectionProps
  } = props;
  const checkoutModel = useCheckout({
    checkout,
    logger,
    onError,
    refreshStatus,
    orderUrl,
    onState,
    onSettled,
    polling
  });
  const theme = useTheme({
    defaultTheme,
    storageKey: themeStorageKey
  });
  const QRCodeComponent = components?.QRCode ?? QRCode;
  const InvoiceSummaryComponent = components?.InvoiceSummary ?? InvoiceSummary;
  const CopyButton = components?.CopyButton ?? CopyInvoiceButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? PaymentState;
  const customChildren =
    typeof children === "function" ? children(checkoutModel) : children;
  const expired = checkoutModel.status === "expired";
  const summaryAmountLabel =
    checkoutModel.fiatLabel === undefined ? checkoutModel.amountLabel : undefined;
  const startOver = () => {
    onStartOver?.();
  };

  return React.createElement(
    "section",
    {
      ...sectionProps,
      className: joinClassNames(className, classNames?.root),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      ...theme.attributes
    },
    customChildren === undefined
      ? [
        themeSwitcher
          ? React.createElement(ThemeToggle, {
            key: "theme",
            className: classNames?.themeToggle,
            theme: theme.theme,
            resolvedTheme: theme.resolvedTheme,
            onThemeChange: theme.setTheme,
            ButtonComponent
          })
          : null,
        expired
          ? null
          : [
            React.createElement(QRCodeComponent, {
              key: "qr",
              invoice: checkoutModel.invoice,
              encoder: qrEncoder,
              onError,
              className: classNames?.qr,
              style: {
                aspectRatio: "1",
                justifySelf: "center",
                maxWidth: 420,
                width: "min(100%, 420px)"
              }
            }),
            React.createElement(SatsDetail, {
              key: "sats-detail",
              amountLabel: checkoutModel.amountLabel,
              className: classNames?.satsDetail
            })
          ],
        React.createElement(WaitingState, {
          key: "waiting",
          waiting: checkoutModel.waiting,
          statusTitle: checkoutModel.statusTitle,
          statusDetail: checkoutModel.statusDetail,
          className: classNames?.waiting
        }),
        checkoutModel.countdownLabel === undefined
          ? null
          : React.createElement(
            "div",
            {
              key: "countdown",
              className: joinClassNames("or-countdown", classNames?.countdown)
            },
            checkoutModel.countdownPrefix,
            " ",
            React.createElement("strong", null, checkoutModel.countdownLabel)
          ),
        React.createElement(InvoiceSummaryComponent, {
          key: "summary",
          amountLabel: summaryAmountLabel,
          fiatLabel: checkoutModel.fiatLabel,
          status: checkoutModel.status,
          PaymentStateComponent,
          className: classNames?.summary,
          classNames
        }),
        React.createElement(
          "div",
          {
            key: "actions",
            className: classNames?.actions,
            [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: ""
          },
          expired
            ? React.createElement(
              ButtonComponent ?? "button",
              {
                type: "button",
                onClick: startOver
              },
              openReceiveCheckoutLabels.startOver
            )
            : React.createElement(CopyButton, {
              invoice: checkoutModel.invoice,
              copyInvoice: checkoutModel.copyInvoice,
              onError,
              logger,
              ButtonComponent,
              className: classNames?.copyButton
            })
        ),
        paymentWizard && !expired
          ? React.createElement(PaymentWizard, {
            key: "wizard",
            invoice: checkoutModel.invoice,
            checkout: checkoutModel.checkout,
            className: classNames?.wizard,
            logger,
            onError,
            countryStorageKey,
            orderUrl,
            qrEncoder,
            logContext: getCheckoutLogContext({
              invoice_id: checkoutModel.invoice_id,
              payment_hash: checkoutModel.payment_hash,
              amount_msats: checkoutModel.amount_msats
            })
          })
          : null
      ]
      : customChildren
  );
}

function getCheckoutLogContext(
  data: {
    readonly invoice_id?: string;
    readonly payment_hash?: string;
    readonly amount_msats?: number;
    readonly transaction_state?: string;
    readonly workflow_state?: string;
  }
): OpenReceiveBrowserLogContext {
  return {
    ...(data.invoice_id === undefined ? {} : { invoice_id: data.invoice_id }),
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.transaction_state === undefined
      ? {}
      : { transaction_state: data.transaction_state }),
    ...(data.workflow_state === undefined
      ? {}
      : { workflow_state: data.workflow_state })
  };
}

function renderCountrySelect(options: {
  readonly countries: OpenReceivePaymentWizardModel["countryDisplays"];
  readonly selectedCountryCode: string;
  readonly onSelectCountry: (countryCode: string) => void;
}): React.ReactElement {
  return React.createElement(
    "label",
    {
      className: "or-country-select"
    },
    React.createElement(
      "span",
      null,
      openReceiveCheckoutLabels.chooseCountry
    ),
    React.createElement(
      "select",
      {
        value: options.selectedCountryCode,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          options.onSelectCountry(event.currentTarget.value);
        }
      },
      options.countries.map((country) =>
        React.createElement(
          "option",
          {
            key: country.code,
            value: country.code
          },
          country.label
        )
      )
    )
  );
}

function renderRoutePicker(options: {
  readonly assets: readonly OpenReceiveWizardRouteAssetDisplay[];
  readonly method: "bitcoin" | "crypto";
  readonly onSelectRoute: (route: string) => void;
}): React.ReactElement {
  return React.createElement(
    "div",
    {
      className: `or-route-picker or-route-picker-${options.method}`
    },
    options.assets.map((asset) => {
      return React.createElement(
        "button",
        {
          className: asset.selected ? "selected" : "",
          key: asset.id,
          onClick: () => options.onSelectRoute(asset.id),
          type: "button"
        },
        React.createElement("img", {
          alt: "",
          src: asset.icon
        }),
        React.createElement("span", null, asset.label),
        React.createElement(
          "small",
          null,
          asset.subtitle
        )
      );
    })
  );
}

function joinClassNames(
  ...values: readonly (string | undefined)[]
): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}
