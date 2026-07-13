import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_DEFAULT_PREFIX,
  createOpenReceiveLightningInvoiceDecodeUrl,
  enterCheckoutResumePath,
  isReusableLightningInvoice,
  openReceiveCheckoutLabels,
  orClasses,
  requestCheckout,
  requestOrderSummary,
  resolveOrderUrlFromPrefix,
  selectCheckoutDisplayInvoice,
  type CheckoutSnapshot,
} from "@openreceive/browser/internal";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  PaymentState,
  QRCode,
  SatsDetail,
  WaitingState,
} from "./components.ts";
import { ThemeToggle, useTheme } from "./theme.ts";
import { useCheckout } from "./use-checkout.ts";
import { getCheckoutLogContext, joinClassNames } from "./utils.ts";
import { PaymentWizard } from "./wizard.ts";
import type { CheckoutProps } from "./types.ts";

export type Checkout = CheckoutSnapshot;

/**
 * Self-contained checkout. Two modes:
 *
 * - Snapshot mode (`checkout` prop): renders that snapshot directly — unchanged, backward
 *   compatible. When `prefix` is passed (and `orderUrl` is not), the order route is derived
 *   from the prefix and the snapshot's order id so status polling works with just a prefix.
 * - Create mode (`orderId` prop, no `checkout`): the component owns the whole lifecycle — on
 *   mount it creates the checkout against `${prefix}/checkouts` (prefix defaults to
 *   `/openreceive`), then hands the resulting snapshot to the same rendering path with
 *   `orderUrl` defaulted to `${prefix}/orders/${orderId}`. The per-order capability token is
 *   captured and attached to every poll/swap automatically.
 * - With `resume`, also fetches `GET {prefix}/orders/{orderId}/summary` (`onSummary`) and
 *   optionally syncs `/checkout/:orderId` via the History API (skipped when `routeOrderId`
 *   is set — e.g. Next.js already owns the route).
 */
export function Checkout(props: CheckoutProps): React.ReactElement {
  const { checkout, orderId } = props;
  if (checkout !== undefined) {
    // Derive the order URL from an explicit prefix only, so existing callers that never pass
    // a prefix keep their current (no auto-polling-URL) behavior.
    const orderUrl =
      props.orderUrl ??
      (props.prefix === undefined
        ? undefined
        : resolveOrderUrlFromPrefix(props.prefix, checkout.order_id));
    return React.createElement(CheckoutView, {
      ...props,
      checkout,
      ...(orderUrl === undefined ? {} : { orderUrl }),
    });
  }
  if (orderId !== undefined) {
    return React.createElement(CheckoutCreate, props);
  }
  throw new Error("<Checkout> requires a checkout snapshot or an orderId.");
}

/**
 * Create-mode wrapper: creates the checkout on mount with `mintLightning: false` so the
 * server locks the amount via a checkout_lock record without calling `makeInvoice`. The
 * Lightning invoice is deferred until the payer selects Bitcoin — at that point the wizard
 * calls `ensureLightning`, which mints (or reuses) the bolt11 and transitions to the full
 * checkout view. Altcoin swaps proceed without ever minting a payer Lightning invoice.
 *
 * When `resume` is set, also loads the guest summary and optionally syncs the URL.
 */
function CheckoutCreate(props: CheckoutProps): React.ReactElement {
  // orderId presence is guaranteed by the Checkout dispatcher's create-mode branch.
  const orderId = props.orderId as string;
  const resolvedPrefix = props.prefix ?? OPENRECEIVE_DEFAULT_PREFIX;
  const {
    onError,
    onSummary,
    onResumeMiss,
    metadata,
    createFetch,
    className,
    classNames,
    resume = false,
    resumePathPrefix = "/checkout",
    routeOrderId,
  } = props;

  const [created, setCreated] = React.useState<{
    readonly status: "pending" | "ready" | "error";
    readonly checkout?: CheckoutSnapshot;
  }>({ status: "pending" });
  const [lightningRequested, setLightningRequested] = React.useState(false);
  const [mintingLightning, setMintingLightning] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const onSummaryRef = React.useRef(onSummary);
  onSummaryRef.current = onSummary;
  const onResumeMissRef = React.useRef(onResumeMiss);
  onResumeMissRef.current = onResumeMiss;
  const metadataRef = React.useRef(metadata);
  metadataRef.current = metadata;
  const createFetchRef = React.useRef(createFetch);
  createFetchRef.current = createFetch;
  // Ref so ensureLightning always reads the latest checkout without being a dep.
  const createdCheckoutRef = React.useRef(created.checkout);
  createdCheckoutRef.current = created.checkout;

  // Guest resume: fetch summary for host display redraw + optional History API URL sync.
  // Runs alongside create; does not block checkout creation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries create+resume together.
  React.useEffect(() => {
    if (!resume) return;
    let cancelled = false;

    enterCheckoutResumePath(orderId, {
      pathPrefix: resumePathPrefix,
      ...(routeOrderId === undefined ? {} : { routeOrderId }),
    });

    void requestOrderSummary({
      prefix: resolvedPrefix,
      orderId,
      ...(createFetchRef.current === undefined ? {} : { fetch: createFetchRef.current }),
    }).then((result) => {
      if (cancelled) return;
      if (result === undefined || !("summary" in result)) {
        onResumeMissRef.current?.(orderId);
        return;
      }
      onSummaryRef.current?.(result.summary);
    });

    return () => {
      cancelled = true;
    };
  }, [resume, orderId, resolvedPrefix, resumePathPrefix, routeOrderId, attempt]);

  // Create on mount and whenever the order id / prefix changes (or a retry is requested).
  // Uses mintLightning: false to defer the LN mint — the payer sees the method grid first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a deliberate retry trigger; metadata/createFetch/onError are read from refs.
  React.useEffect(() => {
    let cancelled = false;
    setCreated({ status: "pending" });
    setLightningRequested(false);
    requestCheckout({
      prefix: resolvedPrefix,
      orderId,
      mintLightning: false,
      ...(metadataRef.current === undefined ? {} : { metadata: metadataRef.current }),
      ...(createFetchRef.current === undefined ? {} : { fetch: createFetchRef.current }),
    })
      .then((checkout) => {
        if (!cancelled) setCreated({ status: "ready", checkout });
      })
      .catch((error) => {
        if (cancelled) return;
        onErrorRef.current?.(error);
        setCreated({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, resolvedPrefix, attempt]);

  // Called by PaymentWizard when Bitcoin is selected or when returning from a swap.
  // Reuses an existing bolt11 when it has >60 s left; otherwise mints a fresh one.
  const ensureLightning = React.useCallback(async () => {
    const current = createdCheckoutRef.current;
    if (current !== undefined) {
      const displayInvoice = selectCheckoutDisplayInvoice(current);
      if (
        displayInvoice !== undefined &&
        typeof displayInvoice.invoice === "string" &&
        displayInvoice.expires_at !== undefined &&
        isReusableLightningInvoice(displayInvoice.expires_at)
      ) {
        setLightningRequested(true);
        return;
      }
    }
    setMintingLightning(true);
    try {
      const checkout = await requestCheckout({
        prefix: resolvedPrefix,
        orderId,
        mintLightning: true,
        ...(createFetchRef.current === undefined ? {} : { fetch: createFetchRef.current }),
      });
      setCreated({ status: "ready", checkout });
      setLightningRequested(true);
    } catch (error) {
      onErrorRef.current?.(error);
    } finally {
      setMintingLightning(false);
    }
  }, [resolvedPrefix, orderId]);

  if (created.status === "ready" && created.checkout !== undefined) {
    const orderUrl = props.orderUrl ?? resolveOrderUrlFromPrefix(resolvedPrefix, orderId);
    if (lightningRequested) {
      return React.createElement(CheckoutView, {
        ...props,
        checkout: created.checkout,
        orderUrl,
        onRequestLightning: ensureLightning,
      });
    }
    // Deferred: Lightning not yet requested — show wizard-only shell. The PaymentWizard
    // fires onRequestLightning when Bitcoin is selected or when returning from a swap.
    return React.createElement(CheckoutDeferredShell, {
      ...props,
      checkout: created.checkout,
      orderUrl,
      mintingLightning,
      onRequestLightning: ensureLightning,
    });
  }

  if (created.status === "error") {
    return React.createElement(
      "section",
      {
        className: joinClassNames(
          className,
          classNames?.root,
          orClasses.creating,
          "openreceive-checkout-error",
        ),
        [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      },
      React.createElement("p", null, "Could not start checkout."),
      React.createElement(
        "button",
        {
          type: "button",
          className: orClasses.btn,
          onClick: () => setAttempt((count) => count + 1),
        },
        "Try again",
      ),
    );
  }

  return React.createElement(
    "section",
    {
      className: joinClassNames(
        className,
        classNames?.root,
        orClasses.creating,
        "openreceive-checkout-creating",
      ),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
    },
    React.createElement("span", {
      className: orClasses.spinner,
      "aria-hidden": "true",
    }),
    React.createElement("p", null, "Creating checkout…"),
  );
}

/**
 * Wizard-only shell shown during the deferred phase of create-mode — before Bitcoin has been
 * selected and the Lightning invoice has been minted. Renders just the payment method grid
 * (and any swap deposit panel the payer enters) without the LN QR/copy/status pane. When
 * the payer selects Bitcoin (or returns from a swap), the wizard fires `onRequestLightning`
 * which mints the bolt11 and causes the parent to switch to the full `CheckoutView`.
 */
function CheckoutDeferredShell(
  props: CheckoutProps & {
    readonly checkout: CheckoutSnapshot;
    readonly orderUrl: string | false;
    readonly mintingLightning: boolean;
    readonly onRequestLightning: () => Promise<void>;
  },
): React.ReactElement {
  const {
    checkout,
    orderUrl,
    mintingLightning,
    onRequestLightning,
    paymentWizard = true,
    themeSwitcher = false,
    defaultTheme,
    themeStorageKey,
    countryStorageKey,
    className,
    classNames,
    logger,
    onError,
    qrEncoder,
    polling,
    refreshStatus,
  } = props;
  const theme = useTheme({ defaultTheme, storageKey: themeStorageKey });
  // Poll so payment_methods (swap coins) arrive even before Lightning is minted.
  const checkoutModel = useCheckout({
    checkout,
    logger,
    onError,
    refreshStatus,
    orderUrl,
    polling,
  });

  return React.createElement(
    "section",
    {
      className: joinClassNames(className, orClasses.root, classNames?.root),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      ...(theme.fromScope && !themeSwitcher ? {} : theme.attributes),
    },
    mintingLightning
      ? React.createElement(
          "div",
          { className: orClasses.creating },
          React.createElement("span", { className: orClasses.spinner, "aria-hidden": "true" }),
          React.createElement("p", null, openReceiveCheckoutLabels.preparingPayment),
        )
      : null,
    paymentWizard
      ? React.createElement(PaymentWizard, {
          key: "wizard",
          invoice: undefined,
          checkout: checkoutModel.checkout,
          className: classNames?.wizard,
          logger,
          onError,
          countryStorageKey,
          orderUrl,
          qrEncoder,
          onRequestLightning,
        })
      : null,
  );
}

function CheckoutView(
  props: CheckoutProps & {
    readonly checkout: CheckoutSnapshot;
    readonly onRequestLightning?: () => Promise<void>;
  },
) {
  const {
    checkout,
    // Create-mode props are consumed by the Checkout dispatcher / CheckoutCreate wrapper; drop
    // them here so they never leak onto the rendered <section>.
    orderId: _orderId,
    prefix: _prefix,
    metadata: _metadata,
    createFetch: _createFetch,
    resume: _resume,
    resumePathPrefix: _resumePathPrefix,
    routeOrderId: _routeOrderId,
    onSummary: _onSummary,
    onResumeMiss: _onResumeMiss,
    onRequestLightning,
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
    polling,
  });
  const theme = useTheme({
    defaultTheme,
    storageKey: themeStorageKey,
  });
  const [swapFocused, setSwapFocused] = React.useState(false);
  const QRCodeComponent = components?.QRCode ?? QRCode;
  const InvoiceSummaryComponent = components?.InvoiceSummary ?? InvoiceSummary;
  const CopyButton = components?.CopyButton ?? CopyInvoiceButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? PaymentState;
  const customChildren = typeof children === "function" ? children(checkoutModel) : children;
  const expired = checkoutModel.status === "expired";
  // Hide the Lightning pane when: a swap deposit panel is focused, no bolt11 has been
  // minted yet (deferred create-mode or checkout_lock snapshot), or the invoice expired.
  // Never hide when expired — the "Start over" button still lives in the LN section.
  const showLightning = !!checkoutModel.invoice && !swapFocused && !expired;
  const hideLightning = !showLightning && !expired;
  // Amount/fiat already appear under the QR; pending is covered by WaitingState.
  // Keep the meta row only for terminal states that need a compact badge.
  const showSummaryMeta =
    checkoutModel.status === "settled" || checkoutModel.status === "expired";
  const fiatCurrency = checkoutModel.fiat_quote?.fiat?.currency;
  const decodeInvoiceHref = createOpenReceiveLightningInvoiceDecodeUrl(checkoutModel.invoice);
  const startOver = () => {
    onStartOver?.();
  };

  const lightningPane =
    hideLightning || expired
      ? null
      : React.createElement(
          "div",
          {
            key: "lightning-pane",
            className: joinClassNames(orClasses.lightningPane, classNames?.lightningPane),
          },
          React.createElement(QRCodeComponent, {
            key: "qr",
            invoice: checkoutModel.invoice,
            encoder: qrEncoder,
            onError,
            className: joinClassNames(orClasses.qr, classNames?.qr),
          }),
          React.createElement(SatsDetail, {
            key: "sats-detail",
            amountLabel: checkoutModel.amountLabel,
            fiatLabel: checkoutModel.fiatLabel,
            fiatCurrency,
            className: classNames?.satsDetail,
          }),
        );

  return React.createElement(
    "section",
    {
      ...sectionProps,
      className: joinClassNames(className, orClasses.root, classNames?.root),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      // Under ThemeScope, inherit data-theme from the page. Standalone Checkout owns it.
      ...(theme.fromScope && !themeSwitcher ? {} : theme.attributes),
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
                ButtonComponent,
              })
            : null,
          hideLightning
            ? null
            : React.createElement(
                "div",
                {
                  key: "payment-layout",
                  className: expired ? orClasses.paymentLayoutExpired : orClasses.paymentLayout,
                },
                lightningPane,
                React.createElement(
                  "div",
                  {
                    key: "payment-info",
                    className: orClasses.paymentInfo,
                  },
                  expired
                    ? null
                    : React.createElement(
                        "p",
                        {
                          key: "invoice-title",
                          className: joinClassNames(
                            orClasses.invoiceTitle,
                            classNames?.invoiceTitle,
                          ),
                        },
                        openReceiveCheckoutLabels.bitcoinLightningInvoice,
                      ),
                  React.createElement(WaitingState, {
                    key: "waiting",
                    waiting: checkoutModel.waiting,
                    statusTitle: checkoutModel.statusTitle,
                    statusDetail: checkoutModel.statusDetail,
                    className: classNames?.waiting,
                  }),
                  checkoutModel.countdownLabel === undefined
                    ? null
                    : React.createElement(
                        "div",
                        {
                          key: "countdown",
                          className: joinClassNames(orClasses.countdown, classNames?.countdown),
                        },
                        checkoutModel.countdownPrefix,
                        " ",
                        React.createElement(
                          "strong",
                          { className: orClasses.countdownStrong },
                          checkoutModel.countdownLabel,
                        ),
                      ),
                  showSummaryMeta
                    ? React.createElement(InvoiceSummaryComponent, {
                        key: "summary",
                        status: checkoutModel.status,
                        PaymentStateComponent,
                        className: classNames?.summary,
                        classNames,
                      })
                    : null,
                  expired
                    ? React.createElement(
                        "div",
                        {
                          key: "expired-actions",
                          className: joinClassNames(orClasses.actions, classNames?.actions),
                          [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: "",
                        },
                        React.createElement(
                          ButtonComponent ?? "button",
                          {
                            type: "button",
                            className: orClasses.btn,
                            onClick: startOver,
                          },
                          openReceiveCheckoutLabels.startOver,
                        ),
                      )
                    : React.createElement(
                        "div",
                        {
                          key: "actions",
                          className: joinClassNames(orClasses.actions, classNames?.actions),
                          [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: "",
                        },
                        React.createElement(CopyButton, {
                          invoice: checkoutModel.invoice,
                          copyInvoice: checkoutModel.copyInvoice,
                          onError,
                          logger,
                          ButtonComponent,
                          className: classNames?.copyButton,
                        }),
                        decodeInvoiceHref === undefined
                          ? null
                          : React.createElement(
                              "a",
                              {
                                key: "decode-invoice",
                                className: orClasses.btn,
                                href: decodeInvoiceHref,
                                rel: "noreferrer",
                                target: "_blank",
                              },
                              openReceiveCheckoutLabels.decodeInvoice,
                            ),
                      ),
                ),
              ),
          paymentWizard && !expired
            ? React.createElement(PaymentWizard, {
                key: "wizard",
                // Only pass invoice when it's a real bolt11 (non-empty, non-deferred).
                invoice: checkoutModel.invoice || undefined,
                checkout: checkoutModel.checkout,
                className: classNames?.wizard,
                logger,
                onError,
                onSwapFocusChange: setSwapFocused,
                countryStorageKey,
                orderUrl,
                qrEncoder,
                logContext: getCheckoutLogContext({
                  invoice_id: checkoutModel.invoice_id,
                  payment_hash: checkoutModel.payment_hash,
                  amount_msats: checkoutModel.amount_msats,
                }),
                onRequestLightning,
              })
            : null,
        ]
      : customChildren,
  );
}
