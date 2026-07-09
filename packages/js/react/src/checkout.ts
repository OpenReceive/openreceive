import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_DEFAULT_PREFIX,
  openReceiveCheckoutLabels,
  orClasses,
  requestCheckout,
  resolveOrderUrlFromPrefix,
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
 * Create-mode wrapper: creates the checkout on mount, renders a minimal placeholder while
 * pending, an error placeholder with a retry on failure, and the normal checkout UI once the
 * snapshot is ready. Recreates when the order id or prefix changes.
 */
function CheckoutCreate(props: CheckoutProps): React.ReactElement {
  // orderId presence is guaranteed by the Checkout dispatcher's create-mode branch.
  const orderId = props.orderId as string;
  const resolvedPrefix = props.prefix ?? OPENRECEIVE_DEFAULT_PREFIX;
  const { onError, metadata, createFetch, className, classNames } = props;

  const [created, setCreated] = React.useState<{
    readonly status: "pending" | "ready" | "error";
    readonly checkout?: CheckoutSnapshot;
  }>({ status: "pending" });
  const [attempt, setAttempt] = React.useState(0);

  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const metadataRef = React.useRef(metadata);
  metadataRef.current = metadata;
  const createFetchRef = React.useRef(createFetch);
  createFetchRef.current = createFetch;

  // Create on mount and whenever the order id / prefix changes (or a retry is requested).
  // metadata/createFetch/onError are read from refs so passing an inline object/function does
  // not retrigger the create on every render. `attempt` is an intentional retry trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a deliberate retry trigger; metadata/createFetch/onError are read from refs.
  React.useEffect(() => {
    let cancelled = false;
    setCreated({ status: "pending" });
    requestCheckout({
      prefix: resolvedPrefix,
      orderId,
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

  if (created.status === "ready" && created.checkout !== undefined) {
    const orderUrl = props.orderUrl ?? resolveOrderUrlFromPrefix(resolvedPrefix, orderId);
    return React.createElement(CheckoutView, {
      ...props,
      checkout: created.checkout,
      orderUrl,
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

function CheckoutView(props: CheckoutProps & { readonly checkout: CheckoutSnapshot }) {
  const {
    checkout,
    // Create-mode props are consumed by the Checkout dispatcher / CheckoutCreate wrapper; drop
    // them here so they never leak onto the rendered <section>.
    orderId: _orderId,
    prefix: _prefix,
    metadata: _metadata,
    createFetch: _createFetch,
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
  // While the payer is completing a swap, its deposit panel replaces the Lightning
  // section entirely, so hide the Lightning QR, status, countdown, summary, and copy
  // action. Never hide when expired — that path still shows the Lightning "Start over".
  const hideLightning = swapFocused && !expired;
  // Amount/fiat already appear under the QR; pending is covered by WaitingState.
  // Keep the meta row only for terminal states that need a compact badge.
  const showSummaryMeta =
    checkoutModel.status === "settled" || checkoutModel.status === "expired";
  const fiatCurrency = checkoutModel.fiat_quote?.fiat?.currency;
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
      ...theme.attributes,
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
                      ),
                ),
              ),
          paymentWizard && !expired
            ? React.createElement(PaymentWizard, {
                key: "wizard",
                invoice: checkoutModel.invoice,
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
              })
            : null,
        ]
      : customChildren,
  );
}
