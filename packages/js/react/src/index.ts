import * as React from "react";
import {
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_THEME_STORAGE_KEY,
  type OpenReceiveQrEncoder,
  copyInvoice as copyInvoiceHelper,
  createOpenReceiveCheckoutController,
  createOpenReceiveCheckoutDisplayModel,
  createOpenReceiveCheckoutSnapshotFromDisplayData,
  createOpenReceiveCheckoutStatusModel,
  createOpenReceiveCheckoutStateFromDisplayData,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardController,
  createOpenReceiveProviderCopyEvent,
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
  writeOpenReceiveThemePreference,
  type OpenReceiveBrowserLogContext,
  type OpenReceiveBrowserLogger,
  type OpenReceiveCheckoutController,
  type OpenReceiveCheckoutDisplayData,
  type OpenReceiveCheckoutDisplayModel,
  type OpenReceiveCheckoutPhase,
  type OpenReceiveCheckoutSnapshot,
  type OpenReceiveCheckoutState,
  type OpenReceiveCheckoutStatusModel,
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
  type OpenReceiveThemePreference
} from "@openreceive/browser";

export interface OpenReceiveCheckoutData
  extends OpenReceiveCheckoutDisplayData {}

export interface OpenReceiveCheckoutViewModel
  extends OpenReceiveCheckoutDisplayModel {}

export interface UseOpenReceiveCheckoutOptions extends OpenReceiveCheckoutData {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly lookupInvoice?: (state: OpenReceiveCheckoutState) => Promise<Partial<OpenReceiveCheckoutSnapshot>>;
  readonly lookupUrl?: string;
  readonly onState?: (state: OpenReceiveCheckoutState) => void;
  readonly refreshInvoice?: (state: OpenReceiveCheckoutState) => Promise<OpenReceiveCheckoutSnapshot | OpenReceiveRefreshInvoiceResult>;
  readonly refreshUrl?: string | ((state: OpenReceiveCheckoutState) => string);
  readonly refreshHeaders?: Readonly<Record<string, string>>;
  readonly refreshIdempotencyKey?: string | ((state: OpenReceiveCheckoutState) => string);
  readonly refreshReason?: string | ((state: OpenReceiveCheckoutState) => string);
  readonly pollIntervalMs?: number;
}

export interface UseOpenReceiveCheckoutResult extends OpenReceiveCheckoutViewModel {
  readonly copied: boolean;
  readonly state?: OpenReceiveCheckoutState;
  readonly status: OpenReceiveCheckoutStatusModel;
  readonly expiresInSeconds?: number;
  readonly countdownLabel?: string;
  readonly waiting: boolean;
  reloadState(): Promise<OpenReceiveCheckoutState | undefined>;
  retry(): Promise<OpenReceiveCheckoutState | undefined>;
  refreshExpiredInvoice(): Promise<OpenReceiveCheckoutState | undefined>;
  cancel(): OpenReceiveCheckoutState | undefined;
  copyInvoice(): Promise<void>;
  openWallet(): string;
}

export interface OpenReceiveProviderProps extends UseOpenReceiveCheckoutOptions {
  readonly children?:
    | React.ReactNode
    | ((checkout: UseOpenReceiveCheckoutResult) => React.ReactNode);
}

export interface OpenReceiveQRCodeProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  readonly invoice: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly width?: number;
  readonly onError?: (error: unknown) => void;
}

export type OpenReceiveButtonComponent =
  React.ElementType<React.ButtonHTMLAttributes<HTMLButtonElement>>;

export interface OpenReceiveCopyButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly copyInvoice?: () => Promise<void>;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly copiedLabel?: React.ReactNode;
  readonly ButtonComponent?: OpenReceiveButtonComponent;
}

export interface OpenReceiveOpenWalletButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly openWallet?: () => string;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onOpened?: (uri: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly ButtonComponent?: OpenReceiveButtonComponent;
}

export interface OpenReceivePaymentStateProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  readonly state?: string;
}

export interface OpenReceiveInvoiceSummaryClassNames {
  readonly amount?: string;
  readonly fiat?: string;
  readonly paymentHash?: string;
  readonly paymentState?: string;
}

export interface OpenReceiveInvoiceSummaryProps
  extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly fiatLabel?: string;
  readonly paymentHashLabel?: string;
  readonly transactionStateLabel?: string;
  readonly PaymentStateComponent?: React.ComponentType<OpenReceivePaymentStateProps>;
  readonly classNames?: OpenReceiveInvoiceSummaryClassNames;
}

export interface OpenReceiveCheckoutClassNames
  extends OpenReceiveInvoiceSummaryClassNames {
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

export interface OpenReceiveCheckoutComponents {
  readonly Button?: OpenReceiveButtonComponent;
  readonly QRCode?: React.ComponentType<OpenReceiveQRCodeProps>;
  readonly InvoiceSummary?: React.ComponentType<OpenReceiveInvoiceSummaryProps>;
  readonly CopyButton?: React.ComponentType<OpenReceiveCopyButtonProps>;
  readonly OpenWalletButton?: React.ComponentType<OpenReceiveOpenWalletButtonProps>;
  readonly PaymentState?: React.ComponentType<OpenReceivePaymentStateProps>;
}

export type OpenReceiveCheckoutChildren =
  | React.ReactNode
  | ((model: OpenReceiveCheckoutViewModel) => React.ReactNode);

export interface OpenReceiveCheckoutProps
  extends OpenReceiveCheckoutData,
    Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly lookupInvoice?: (state: OpenReceiveCheckoutState) => Promise<Partial<OpenReceiveCheckoutSnapshot>>;
  readonly lookupUrl?: string;
  readonly onState?: (state: OpenReceiveCheckoutState) => void;
  readonly paymentWizard?: boolean;
  readonly themeSwitcher?: boolean;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly themeStorageKey?: string;
  readonly countryStorageKey?: string;
  readonly components?: OpenReceiveCheckoutComponents;
  readonly classNames?: OpenReceiveCheckoutClassNames;
  readonly children?: OpenReceiveCheckoutChildren;
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
  readonly ButtonComponent?: OpenReceiveButtonComponent;
}

export type OpenReceiveThemeScopeChildren =
  | React.ReactNode
  | ((theme: UseOpenReceiveThemeResult) => React.ReactNode);

export interface OpenReceiveThemeScopeProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly as?: keyof React.JSX.IntrinsicElements;
  readonly defaultTheme?: OpenReceiveThemePreference;
  readonly themeStorageKey?: string;
  readonly storage?: Storage;
  readonly themeToggle?: boolean;
  readonly topbarClassName?: string;
  readonly themeToggleClassName?: string;
  readonly ButtonComponent?: OpenReceiveButtonComponent;
  readonly children?: OpenReceiveThemeScopeChildren;
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

export function createOpenReceiveCheckoutViewModel(
  data: OpenReceiveCheckoutData
): OpenReceiveCheckoutViewModel {
  return createOpenReceiveCheckoutDisplayModel(data);
}

export function useOpenReceiveCheckout(
  options: UseOpenReceiveCheckoutOptions
): UseOpenReceiveCheckoutResult {
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);
  const model = React.useMemo(
    () => createOpenReceiveCheckoutViewModel(options),
    [
      options.invoice,
      options.payment_hash,
      options.amount_msats,
      options.fiat_quote,
      options.transaction_state
    ]
  );
  const snapshot = React.useMemo<OpenReceiveCheckoutSnapshot | undefined>(
    () => options.invoice_id === undefined
      ? undefined
      : createOpenReceiveCheckoutSnapshotFromDisplayData(options),
    [
      options.invoice_id,
      options.invoice,
      options.payment_hash,
      options.amount_msats,
      options.fiat_quote,
      options.transaction_state,
      options.workflow_state,
      options.expires_at,
      options.checkout
    ]
  );
  const [state, setState] = React.useState<OpenReceiveCheckoutState | undefined>(
    () => options.invoice_id === undefined
      ? undefined
      : createOpenReceiveCheckoutStateFromDisplayData(options, {
        logger: options.logger
      })
  );
  const controllerRef = React.useRef<OpenReceiveCheckoutController | null>(null);
  const onStateRef = React.useRef(options.onState);
  onStateRef.current = options.onState;
  const logContext = React.useMemo(
    () => getCheckoutLogContext(options),
    [
      options.payment_hash,
      options.amount_msats,
      options.transaction_state
    ]
  );
  React.useEffect(() => {
    if (snapshot === undefined) {
      controllerRef.current?.stop();
      controllerRef.current = null;
      setState(undefined);
      return undefined;
    }

    const controller = createOpenReceiveCheckoutController({
      snapshot,
      ...(options.lookupInvoice === undefined ? {} : { lookupInvoice: options.lookupInvoice }),
      ...(options.lookupUrl === undefined ? {} : { lookupUrl: options.lookupUrl }),
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

  const copyInvoice = React.useCallback(async () => {
    try {
      const controller = controllerRef.current;
      if (controller === null) {
        await copyInvoiceHelper({
          invoice: options.invoice,
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
  }, [logContext, options.invoice, options.clipboard, options.logger, options.onError, showCopied]);

  const openWallet = React.useCallback(() => {
    try {
      const controller = controllerRef.current;
      return controller === null
        ? openWalletHelper({
          invoice: options.invoice,
          open: options.open,
          logger: options.logger,
          logContext
        })
        : controller.openWallet();
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, options.invoice, options.open, options.logger, options.onError]);

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

  const status = createOpenReceiveCheckoutStatusModel(state);

  return {
    ...model,
    copied,
    state,
    status,
    expiresInSeconds: status.expiresInSeconds,
    countdownLabel: status.countdownLabel,
    waiting: status.waiting,
    reloadState,
    retry,
    refreshExpiredInvoice,
    cancel,
    copyInvoice,
    openWallet
  };
}

const OpenReceiveCheckoutContext =
  React.createContext<UseOpenReceiveCheckoutResult | null>(null);

export function useOpenReceiveCheckoutContext(): UseOpenReceiveCheckoutResult {
  const checkout = React.useContext(OpenReceiveCheckoutContext);
  if (checkout === null) {
    throw new Error(
      "useOpenReceiveCheckoutContext must be used within OpenReceiveProvider."
    );
  }
  return checkout;
}

export function OpenReceiveProvider(
  props: OpenReceiveProviderProps
): React.ReactElement {
  const { children, ...options } = props;
  const checkout = useOpenReceiveCheckout(options);
  const content =
    typeof children === "function" ? children(checkout) : children;

  return React.createElement(
    OpenReceiveCheckoutContext.Provider,
    { value: checkout },
    content
  );
}

export function OpenReceiveQRCode(props: OpenReceiveQRCodeProps): React.ReactElement {
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

export function OpenReceiveCopyButton(
  props: OpenReceiveCopyButtonProps
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

export function OpenReceiveOpenWalletButton(
  props: OpenReceiveOpenWalletButtonProps
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

export function OpenReceivePaymentState(
  props: OpenReceivePaymentStateProps
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
      }),
      React.createElement("span", {
        className: "or-theme-toggle-icon or-theme-toggle-icon-dark"
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

export function OpenReceiveThemeScope(
  props: OpenReceiveThemeScopeProps
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
  readonly phase?: OpenReceiveCheckoutPhase;
  readonly status?: OpenReceiveCheckoutStatusModel;
  readonly className?: string;
}): React.ReactElement {
  const status =
    props.status ??
    createOpenReceiveCheckoutStatusModel({
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
  const [copiedProviderId, showCopiedProviderId] =
    useOpenReceiveTransientValue<string | null>(null);
  const [activeTutorial, setActiveTutorial] = React.useState<{
    readonly providerId: string;
    readonly index: number;
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
  const activeTutorialProvider = activeTutorial === null
    ? undefined
    : routeDisplays
      .flatMap((route) => route.providers)
      .find((provider) => provider.id === activeTutorial.providerId);

  const copyForProvider = async (providerId: string) => {
    try {
      await copyInvoiceHelper({
        invoice: props.invoice,
        logger: props.logger,
        logContext: props.logContext
      });
      showCopiedProviderId(providerId);
      globalThis.dispatchEvent?.(createOpenReceiveProviderCopyEvent(providerId));
    } catch (error) {
      props.onError?.(error);
    }
  };

  return React.createElement(
    "div",
    {
      className: joinClassNames("or-wizard", props.className)
    },
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
            className: selection.selectedMethod === method.id ? "selected" : "",
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
    ),
    selection.selectedMethod === "bitcoin"
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
    selection.selectedMethod === "crypto"
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
	                  ),
	                    React.createElement(
                    "p",
                    null,
                    route.subtitle
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
                      "div",
                      {
                        className: "or-provider-actions"
                      },
                      React.createElement(
                        "button",
                        {
                          onClick: () => void copyForProvider(provider.id),
                          type: "button"
                        },
                        copiedProviderId === provider.id
                          ? provider.copiedLabel
                          : provider.copyLabel
                      ),
                      React.createElement(
                        "a",
                        {},
                        ""
                      )
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
        onClose: () => setActiveTutorial(null),
        onStep: (index) => setActiveTutorial({
          providerId: activeTutorialProvider.id,
          index
        })
      })
  );
}

export function OpenReceiveInvoiceSummary(
  props: OpenReceiveInvoiceSummaryProps
): React.ReactElement {
	  const {
	    amountLabel,
	    fiatLabel,
	    transactionStateLabel,
    PaymentStateComponent = OpenReceivePaymentState,
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
    transactionStateLabel === undefined
      ? null
      : React.createElement(PaymentStateComponent, {
        state: transactionStateLabel,
        className: classNames?.paymentState
      })
  );
}

export function OpenReceiveCheckout(
  props: OpenReceiveCheckoutProps
): React.ReactElement {
  const {
    invoice_id,
    invoice,
    payment_hash,
    amount_msats,
    fiat_quote,
    transaction_state,
    workflow_state,
    expires_at,
    checkout,
    qrEncoder,
    logger,
    onError,
    lookupInvoice,
    lookupUrl,
    onState,
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
  const checkoutModel = useOpenReceiveCheckout({
    invoice_id,
    invoice,
    payment_hash,
    amount_msats,
    fiat_quote,
    transaction_state,
    workflow_state,
    expires_at,
    checkout,
    logger,
    onError,
    lookupInvoice,
    lookupUrl,
    onState
  });
  const theme = useOpenReceiveTheme({
    defaultTheme,
    storageKey: themeStorageKey
  });
  const QRCode = components?.QRCode ?? OpenReceiveQRCode;
  const InvoiceSummary = components?.InvoiceSummary ?? OpenReceiveInvoiceSummary;
  const CopyButton = components?.CopyButton ?? OpenReceiveCopyButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? OpenReceivePaymentState;
  const customChildren =
    typeof children === "function" ? children(checkoutModel) : children;

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
        React.createElement(QRCode, {
          key: "qr",
          invoice,
          encoder: qrEncoder,
          onError,
          className: classNames?.qr,
          style: {
            aspectRatio: "1",
            maxWidth: 256
          }
        }),
        React.createElement(OpenReceiveWaitingState, {
          key: "waiting",
          status: checkoutModel.status,
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
            checkoutModel.status.countdownPrefix,
            " ",
            React.createElement("strong", null, checkoutModel.countdownLabel)
          ),
	        React.createElement(InvoiceSummary, {
	          key: "summary",
	          amountLabel: checkoutModel.amountLabel,
	          fiatLabel: checkoutModel.fiatLabel,
	          transactionStateLabel:
	            checkoutModel.state?.transaction_state ??
            checkoutModel.transactionStateLabel,
          PaymentStateComponent,
          className: classNames?.summary,
          classNames
        }),
        React.createElement("textarea", {
          key: "invoice",
          readOnly: true,
          value: invoice,
          "aria-label": "Lightning invoice",
          className: classNames?.invoice
        }),
        React.createElement(
          "div",
          {
            key: "actions",
            className: classNames?.actions,
            [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: ""
          },
          React.createElement(CopyButton, {
            invoice,
            copyInvoice: checkoutModel.copyInvoice,
            onError,
            logger,
            ButtonComponent,
            className: classNames?.copyButton
          })
        ),
        paymentWizard
          ? React.createElement(OpenReceivePaymentWizard, {
            key: "wizard",
            invoice,
            className: classNames?.wizard,
            logger,
            onError,
            countryStorageKey,
            logContext: getCheckoutLogContext({
              invoice_id,
              payment_hash,
              amount_msats,
              transaction_state: checkoutModel.state?.transaction_state ?? transaction_state,
              workflow_state: checkoutModel.state?.workflow_state ?? workflow_state
            })
          })
          : null
      ]
      : customChildren
  );
}

export const InvoiceSummary = OpenReceiveInvoiceSummary;
export const CopyInvoiceButton = OpenReceiveCopyButton;
export const OpenWalletButton = OpenReceiveOpenWalletButton;
export const PaymentState = OpenReceivePaymentState;

function getCheckoutLogContext(
  data: Partial<OpenReceiveCheckoutData>
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
