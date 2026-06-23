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
  createCheckoutSnapshotFromDisplayData,
  createCheckoutStatusModel,
  createCheckoutStateFromDisplayData,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardController,
  createCheckoutProviderCopyEvent,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  createQrSvg,
  createOpenReceiveThemeModel,
  createOpenReceiveTransientFeedbackController,
  getOpenReceiveDefaultCountryCode,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveWizardEmptyMessage,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
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
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardController,
  type OpenReceivePaymentWizardModel,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveRefreshInvoiceResult,
  type OpenReceiveResolvedTheme,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveTransientFeedbackController,
  type OpenReceiveThemeModel,
  type OpenReceiveThemePreference,
  type Status
} from "@openreceive/browser/internal";

const DEFAULT_LOOKUP_URL = "/openreceive/v1/invoices/lookup";

export interface CheckoutData {
  readonly invoice: CheckoutSnapshot;
}

export interface CheckoutViewModel {
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: CheckoutSnapshot["fiat_quote"];
  readonly expires_at?: number;
  readonly settled_at?: number;
  readonly lightningUri: string;
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
  readonly lookupInvoice?: (state: CheckoutState) => Promise<Partial<CheckoutSnapshot>>;
  readonly lookupUrl?: string;
  readonly refreshInvoice?: (state: CheckoutState) => Promise<CheckoutSnapshot | OpenReceiveRefreshInvoiceResult>;
  readonly refreshUrl?: string | ((state: CheckoutState) => string);
  readonly refreshHeaders?: Readonly<Record<string, string>>;
  readonly refreshIdempotencyKey?: string | ((state: CheckoutState) => string);
  readonly refreshReason?: string | ((state: CheckoutState) => string);
  readonly onState?: (state: CheckoutState) => void;
  readonly onPaid?: () => void;
  readonly pollIntervalMs?: number;
}

export interface UseCheckoutResult extends CheckoutViewModel {
  readonly copied: boolean;
  readonly state?: CheckoutState;
  readonly expiresInSeconds?: number;
  readonly countdownLabel?: string;
  readonly waiting: boolean;
  reloadState(): Promise<CheckoutState | undefined>;
  retry(): Promise<CheckoutState | undefined>;
  refreshExpiredInvoice(): Promise<CheckoutState | undefined>;
  cancel(): CheckoutState | undefined;
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
  readonly lookupInvoice?: (state: CheckoutState) => Promise<Partial<CheckoutSnapshot>>;
  readonly lookupUrl?: string;
  readonly refreshInvoice?: (state: CheckoutState) => Promise<CheckoutSnapshot | OpenReceiveRefreshInvoiceResult>;
  readonly refreshUrl?: string | ((state: CheckoutState) => string);
  readonly refreshHeaders?: Readonly<Record<string, string>>;
  readonly refreshIdempotencyKey?: string | ((state: CheckoutState) => string);
  readonly refreshReason?: string | ((state: CheckoutState) => string);
  readonly onState?: (state: CheckoutState) => void;
  readonly onPaid?: () => void;
  readonly onStartOver?: () => void;
  readonly paymentWizard?: boolean;
  readonly themeSwitcher?: boolean;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly themeStorageKey?: string;
  readonly countryStorageKey?: string;
  readonly components?: CheckoutComponents;
  readonly classNames?: CheckoutClassNames;
  readonly children?: CheckoutChildren;
}

export interface UseOpenReceiveThemeOptions {
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly storageKey?: string;
  readonly storage?: Storage;
}

export interface UseOpenReceiveThemeResult {
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

export interface OpenReceiveThemeToggleProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly theme?: OpenReceiveThemePreference;
  readonly resolvedTheme?: OpenReceiveResolvedTheme;
  readonly onThemeChange?: (theme: OpenReceiveThemePreference) => void;
  readonly ButtonComponent?: ButtonComponent;
}

export type ThemeScopeChildren =
  | React.ReactNode
  | ((theme: UseOpenReceiveThemeResult) => React.ReactNode);

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

export interface OpenReceivePaymentWizardProps {
  readonly invoice: string;
  readonly className?: string;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly logContext?: OpenReceiveBrowserLogContext;
  readonly countryStorageKey?: string;
  readonly onError?: (error: unknown) => void;
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

function toCheckoutDisplayData(
  invoice: CheckoutSnapshot
): CheckoutDisplayData {
  return {
    invoice_id: invoice.invoice_id,
    invoice: invoice.invoice,
    ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
    ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
    ...(invoice.fiat_quote === undefined ? {} : { fiat_quote: invoice.fiat_quote }),
    ...(invoice.transaction_state === undefined
      ? {}
      : { transaction_state: invoice.transaction_state }),
    ...(invoice.workflow_state === undefined ? {} : { workflow_state: invoice.workflow_state }),
    ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
    ...(invoice.settled_at === undefined ? {} : { settled_at: invoice.settled_at })
  };
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
    lightningUri: display.lightningUri,
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
    createCheckoutDisplayModel(toCheckoutDisplayData(data.invoice)),
    deriveStatus(data.invoice)
  );
}

export function useCheckout(
  options: UseCheckoutOptions
): UseCheckoutResult {
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);
  const displayData = React.useMemo(
    () => toCheckoutDisplayData(options.invoice),
    [options.invoice]
  );
  const model = React.useMemo(
    () => toCheckoutViewModel(
      createCheckoutDisplayModel(displayData),
      deriveStatus(options.invoice)
    ),
    [
      displayData,
      options.invoice
    ]
  );
  const snapshot = React.useMemo<CheckoutSnapshot>(
    () => createCheckoutSnapshotFromDisplayData(displayData),
    [
      displayData
    ]
  );
  const [state, setState] = React.useState<CheckoutState>(
    () => createCheckoutStateFromDisplayData(displayData, {
      logger: options.logger
    })
  );
  const controllerRef = React.useRef<CheckoutController | null>(null);
  const onStateRef = React.useRef(options.onState);
  onStateRef.current = options.onState;
  const onPaidRef = React.useRef(options.onPaid);
  onPaidRef.current = options.onPaid;
  const paidAnnouncementRef = React.useRef<{
    readonly invoiceId: string;
    readonly fired: boolean;
  }>({
    invoiceId: snapshot.invoice_id,
    fired: false
  });
  const logContext = React.useMemo(
    () => getCheckoutLogContext(displayData),
    [
      displayData
    ]
  );
  React.useEffect(() => {
    const controller = createCheckoutController({
      snapshot,
      ...(options.lookupInvoice === undefined ? {} : { lookupInvoice: options.lookupInvoice }),
      lookupUrl: options.lookupUrl ?? DEFAULT_LOOKUP_URL,
      ...(options.refreshInvoice === undefined ? {} : { refreshInvoice: options.refreshInvoice }),
      ...(options.refreshUrl === undefined ? {} : { refreshUrl: options.refreshUrl }),
      ...(options.refreshHeaders === undefined ? {} : { refreshHeaders: options.refreshHeaders }),
      ...(options.refreshIdempotencyKey === undefined
        ? {}
        : { refreshIdempotencyKey: options.refreshIdempotencyKey }),
      ...(options.refreshReason === undefined ? {} : { refreshReason: options.refreshReason }),
      pollIntervalMs: options.pollIntervalMs,
      logger: options.logger,
      onError: options.onError,
      clipboard: options.clipboard,
      open: options.open,
      onState: (nextState) => {
        setState(nextState);
        onStateRef.current?.(nextState);
      }
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [
    snapshot,
    options.lookupInvoice,
    options.lookupUrl,
    options.refreshInvoice,
    options.refreshUrl,
    options.refreshHeaders,
    options.refreshIdempotencyKey,
    options.refreshReason,
    options.pollIntervalMs,
    options.logger,
    options.onError,
    options.clipboard,
    options.open
  ]);
  const publicStatus = deriveStatus(state);
  const richStatus = createCheckoutStatusModel(state);

  React.useEffect(() => {
    const announced = paidAnnouncementRef.current;
    if (announced.invoiceId !== snapshot.invoice_id) {
      paidAnnouncementRef.current = {
        invoiceId: snapshot.invoice_id,
        fired: false
      };
    }
  }, [snapshot.invoice_id]);

  React.useEffect(() => {
    const announced = paidAnnouncementRef.current;
    if (publicStatus !== "paid" || announced.fired) return;
    paidAnnouncementRef.current = {
      invoiceId: snapshot.invoice_id,
      fired: true
    };
    // UI hint only; server-side fulfillment must use the backend onPaid hook.
    onPaidRef.current?.();
  }, [publicStatus, snapshot.invoice_id]);

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
      return next;
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const retry = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.retry();
      if (next !== undefined) setState(next);
      return next;
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const refreshExpiredInvoice = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.refreshExpiredInvoice();
      if (next !== undefined) setState(next);
      return next;
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const cancel = React.useCallback(() => {
    const next = controllerRef.current?.cancel();
    if (next !== undefined) setState(next);
    return next;
  }, []);

  return {
    ...model,
    copied,
    state,
    status: publicStatus,
    expiresInSeconds: richStatus.expiresInSeconds,
    countdownLabel: richStatus.countdownLabel,
    waiting: richStatus.waiting,
    reloadState,
    retry,
    refreshExpiredInvoice,
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

export function useOpenReceiveTheme(
  options: UseOpenReceiveThemeOptions = {}
): UseOpenReceiveThemeResult {
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

export function OpenReceiveThemeToggle(
  props: OpenReceiveThemeToggleProps
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
  const fallback = useOpenReceiveTheme({
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
  const theme = useOpenReceiveTheme({
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
          React.createElement(OpenReceiveThemeToggle, {
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

export function OpenReceiveWaitingState(props: {
  readonly waiting?: boolean;
  readonly phase?: CheckoutPhase;
  readonly status?: CheckoutStatusModel;
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
      React.createElement("strong", null, status.title),
      React.createElement("span", null, status.detail)
    )
  );
}

export function OpenReceivePaymentWizard(
  props: OpenReceivePaymentWizardProps
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
          openReceivePaymentMethods.map((method) =>
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
          )
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
          : routeDisplays.map((route) =>
            React.createElement(
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
              React.createElement(
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
            )
          )
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

export function Checkout(
  props: CheckoutProps
): React.ReactElement {
  const {
    invoice,
    qrEncoder,
    logger,
    onError,
    lookupInvoice,
    lookupUrl,
    refreshInvoice,
    refreshUrl,
    refreshHeaders,
    refreshIdempotencyKey,
    refreshReason,
    onState,
    onPaid,
    onStartOver,
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
    invoice,
    logger,
    onError,
    lookupInvoice,
    lookupUrl,
    refreshInvoice,
    refreshUrl,
    refreshHeaders,
    refreshIdempotencyKey,
    refreshReason,
    onState,
    onPaid
  });
  const richStatus = createCheckoutStatusModel(checkoutModel.state);
  const theme = useOpenReceiveTheme({
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
  const startOver = () => {
    if (onStartOver !== undefined) {
      onStartOver();
      return;
    }
    void checkoutModel.refreshExpiredInvoice().catch((error) => {
      onError?.(error);
    });
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
          ? React.createElement(OpenReceiveThemeToggle, {
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
          : React.createElement(QRCodeComponent, {
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
        React.createElement(OpenReceiveWaitingState, {
          key: "waiting",
          status: richStatus,
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
            richStatus.countdownPrefix,
            " ",
            React.createElement("strong", null, checkoutModel.countdownLabel)
          ),
        React.createElement(InvoiceSummaryComponent, {
	          key: "summary",
	          amountLabel: checkoutModel.amountLabel,
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
          ? React.createElement(OpenReceivePaymentWizard, {
            key: "wizard",
            invoice: checkoutModel.invoice,
            className: classNames?.wizard,
            logger,
            onError,
            countryStorageKey,
            logContext: getCheckoutLogContext({
              invoice_id: checkoutModel.invoice_id,
              payment_hash: checkoutModel.payment_hash,
              amount_msats: checkoutModel.amount_msats,
              transaction_state: checkoutModel.state?.transaction_state,
              workflow_state: checkoutModel.state?.workflow_state
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
