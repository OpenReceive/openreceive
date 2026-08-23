import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  createLightningInvoiceDecodeUrl,
  enterCheckoutResumePath,
  mergeAttemptIntoCheckout,
  mergeAttemptIntoSnapshot,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_DEFAULT_PREFIX,
  checkoutLabels,
  orClasses,
  prepareCheckout,
  requestCheckout,
  validateCheckoutProps,
} from "@openreceive/browser/headless";
import * as React from "react";
import { useCheckoutSession } from "./checkout-session.ts";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  PaymentData,
  PaymentState,
  QRCode,
  SatsDetail,
  WaitingState,
} from "./components.ts";
import { ThemeToggle, useTheme } from "./theme.ts";
import type { CheckoutProps } from "./types.ts";
import { useCheckout } from "./use-checkout.ts";
import { getCheckoutLogContext, joinClassNames } from "./utils.ts";
import { PaymentWizard } from "./wizard.ts";

/**
 * Self-contained checkout. Two modes:
 *
 * - Snapshot mode (`checkout` prop): renders that snapshot directly. `prefix` (default
 *   `/openreceive`) is the mount every route is derived from, so status polling works
 *   with just a prefix — or with nothing at all.
 * - Create mode (`reference` prop, no `checkout`): the component owns the whole lifecycle — on
 *   mount it prepares amount + payment methods against `${prefix}/checkouts/prepare` (no
 *   Lightning mint). Bitcoin selection mints via `${prefix}/checkouts`. Poll/swap send
 *   `reference` and are authorized by the host.
 * - Opt into `/checkout/:reference` History API sync with `syncUrl` (skipped when
 *   `routeReference` is set — e.g. Next.js already owns the route). Order resume data
 *   remains owned by the host application.
 */
export function Checkout(props: CheckoutProps): React.ReactElement {
  // The mode boundary, shared with the element wrappers (G6a): one error when
  // neither mode is set, one warning when a create-only prop is passed with a
  // snapshot. React used to carry its own copy of both, and its own copy of the
  // create-only prop list.
  validateCheckoutProps({
    framework: "@openreceive/react",
    checkout: props.checkout,
    reference: props.reference,
    metadata: props.metadata,
    syncUrl: props.syncUrl,
    resumePathPrefix: props.resumePathPrefix,
    routeReference: props.routeReference,
  });
  const { checkout } = props;
  if (checkout !== undefined) {
    // Resolve the prefix once here (default when none is given), matching the
    // element's snapshot-mode polling behavior.
    return React.createElement(CheckoutSnapshotMode, {
      ...props,
      checkout,
      prefix: props.prefix ?? OPENRECEIVE_DEFAULT_PREFIX,
    });
  }
  // No snapshot: the validator above already rejected a missing/empty reference.
  return React.createElement(CheckoutCreate, props);
}

/**
 * Snapshot-mode wrapper. Holds the rendered snapshot in local state so a swap
 * start re-keys polling onto the swap's payment hash — without this, the
 * wizard's onSwapStarted was a no-op in snapshot mode and the poller kept
 * asking about the pre-swap Lightning hash forever (a paid USDT customer would
 * be told "Invoice expired").
 */
function CheckoutSnapshotMode(
  props: CheckoutProps & { readonly checkout: CheckoutSnapshot },
): React.ReactElement {
  const { checkout } = props;
  const identity = `${checkout.checkout_id} ${checkout.reference}`;
  const [current, setCurrent] = React.useState(checkout);
  const lastIdentityRef = React.useRef(identity);
  React.useEffect(() => {
    if (lastIdentityRef.current !== identity) {
      lastIdentityRef.current = identity;
      setCurrent(checkout);
    }
  }, [identity, checkout]);
  const onSwapStarted = React.useCallback((invoice: CheckoutInvoiceSnapshot) => {
    setCurrent((previous) => mergeAttemptIntoSnapshot(invoice, previous));
  }, []);
  return React.createElement(CheckoutView, {
    ...props,
    checkout: current,
    onSwapStarted,
  });
}

/**
 * Create-mode wrapper: prepares amount + payment methods on mount without minting Lightning.
 * Bitcoin selection asks the shared session to mint (or reuse) a bolt11.
 *
 * Syncs the URL only when `syncUrl` is set.
 */
function CheckoutCreate(props: CheckoutProps): React.ReactElement {
  // reference presence is guaranteed by the Checkout dispatcher's create-mode branch.
  const reference = props.reference as string;
  const resolvedPrefix = props.prefix ?? OPENRECEIVE_DEFAULT_PREFIX;
  const {
    onError,
    metadata,
    createFetch,
    className,
    classNames,
    syncUrl = false,
    resumePathPrefix = "/checkout",
    routeReference,
  } = props;

  const [created, setCreated] = React.useState<{
    readonly status: "pending" | "ready" | "error";
    readonly checkout?: CheckoutSnapshot;
    readonly errorMessage?: string;
  }>({ status: "pending" });
  const [attempt, setAttempt] = React.useState(0);

  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const metadataRef = React.useRef(metadata);
  metadataRef.current = metadata;
  const createFetchRef = React.useRef(createFetch);
  createFetchRef.current = createFetch;
  // Ref so the session always reads the latest checkout without being a dep.
  const createdCheckoutRef = React.useRef(created.checkout);
  createdCheckoutRef.current = created.checkout;

  // The deferred Lightning mint, shared with the custom element (G6): reuse a
  // bolt11 with time left on it, otherwise mint one, and never mint twice for
  // one order. React supplies only the two things that are genuinely its own —
  // how the new snapshot is published, and where the failure is surfaced.
  const session = useCheckoutSession({
    snapshot: () => createdCheckoutRef.current,
    reference: () => reference,
    requestCheckout: (id) =>
      requestCheckout({
        prefix: resolvedPrefix,
        reference: id,
        ...(metadataRef.current === undefined ? {} : { metadata: metadataRef.current }),
        ...(createFetchRef.current === undefined ? {} : { fetch: createFetchRef.current }),
      }),
    // One stable CheckoutView across the mint: swapping the rendered shell
    // remounted PaymentWizard and wiped the payer's method selection.
    onSnapshot: (checkout) => setCreated({ status: "ready", checkout }),
    onError: (error) => onErrorRef.current?.(error),
  });

  // The host owns order resume data; OpenReceive only owns optional URL synchronization.
  React.useEffect(() => {
    if (syncUrl) {
      enterCheckoutResumePath(reference, {
        pathPrefix: resumePathPrefix,
        ...(routeReference === undefined ? {} : { routeReference }),
      });
    }
  }, [syncUrl, reference, resumePathPrefix, routeReference]);

  // Prepare on mount (amount lock + methods). Lightning mints only when Bitcoin is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is a deliberate retry trigger; createFetch/onError are read from refs.
  React.useEffect(() => {
    let cancelled = false;
    setCreated({ status: "pending" });
    prepareCheckout({
      prefix: resolvedPrefix,
      reference,
      ...(createFetchRef.current === undefined ? {} : { fetch: createFetchRef.current }),
    })
      .then((checkout) => {
        if (!cancelled) setCreated({ status: "ready", checkout });
      })
      .catch((error) => {
        if (cancelled) return;
        onErrorRef.current?.(error);
        setCreated({
          status: "error",
          ...(error instanceof Error && error.message.length > 0
            ? { errorMessage: error.message }
            : {}),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [reference, resolvedPrefix, attempt]);

  const onSwapStarted = React.useCallback(
    (invoice: CheckoutInvoiceSnapshot) => {
      setCreated((current) => {
        if (current.status !== "ready") return current;
        return {
          status: "ready",
          checkout: mergeAttemptIntoCheckout(invoice, current.checkout, reference),
        };
      });
    },
    [reference],
  );

  if (created.status === "ready" && created.checkout !== undefined) {
    // One stable shell for deferred + minted Lightning. Switching shells remounted
    // PaymentWizard and wiped selectedMethod (providers vanished when the QR appeared).
    return React.createElement(CheckoutView, {
      ...props,
      checkout: created.checkout,
      prefix: resolvedPrefix,
      mintingLightning: session.mintingLightning,
      onRequestLightning: session.ensureLightning,
      onSwapStarted,
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
      React.createElement("p", { role: "alert" }, "Could not start checkout."),
      // The thrown error carries the server's payer-facing text (e.g. the
      // rate-limit message or "Exchange rates are temporarily unavailable").
      created.errorMessage === undefined
        ? null
        : React.createElement("p", null, created.errorMessage),
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

function CheckoutView(
  props: CheckoutProps & {
    readonly checkout: CheckoutSnapshot;
    readonly onRequestLightning?: () => Promise<void>;
    readonly onSwapStarted?: (invoice: CheckoutInvoiceSnapshot) => void;
    /** Create-mode: true while a deferred Lightning mint is in flight. */
    readonly mintingLightning?: boolean;
  },
) {
  const {
    checkout,
    // Create-mode props are consumed by the Checkout dispatcher / CheckoutCreate wrapper; drop
    // them here so they never leak onto the rendered <section>.
    reference: _reference,
    // The dispatcher and CheckoutCreate both resolve this before rendering the
    // view, so the default below only guards a direct CheckoutView call.
    prefix = OPENRECEIVE_DEFAULT_PREFIX,
    metadata: _metadata,
    createFetch: _createFetch,
    syncUrl: _syncUrl,
    resumePathPrefix: _resumePathPrefix,
    routeReference: _routeReference,
    onRequestLightning,
    onSwapStarted,
    mintingLightning = false,
    qrEncoder,
    logger,
    decodeLinkUrl,
    onCopy,
    onOpenWallet,
    onError,
    refreshStatus,
    onState,
    onSettled,
    onProviderCopy,
    onStartOver,
    polling,
    pollIntervalMs,
    paymentWizard = true,
    themeToggle = true,
    defaultTheme,
    storageKey,
    components,
    classNames,
    children,
    className,
    ...sectionProps
  } = props;
  const checkoutModel = useCheckout({
    checkout,
    logger,
    onCopy,
    onOpenWallet,
    onError,
    refreshStatus,
    prefix,
    onState,
    onSettled,
    polling,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });
  const theme = useTheme({
    defaultTheme,
    storageKey,
  });
  // An ancestor ThemeScope already stamps data-theme and renders the page toggle;
  // only a standalone checkout owns them.
  const ownsTheme = themeToggle && !theme.fromScope;
  const [swapFocused, setSwapFocused] = React.useState(false);
  const QRCodeComponent = components?.QRCode ?? QRCode;
  const InvoiceSummaryComponent = components?.InvoiceSummary ?? InvoiceSummary;
  const CopyButton = components?.CopyButton ?? CopyInvoiceButton;
  const OpenWalletButtonComponent = components?.OpenWalletButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? PaymentState;
  const customChildren = typeof children === "function" ? children(checkoutModel) : children;
  const expired = checkoutModel.status === "expired";
  // Settled: paying affordances (QR, copy, decode, wizard) drop out; a green "Payment
  // received" status plus the payment-data panel take their place.
  const settled = checkoutModel.status === "settled";
  // Hide the Lightning pane when: a swap deposit panel is focused, no bolt11 has been
  // minted yet (deferred create-mode or checkout_lock snapshot), or the invoice expired.
  // Never hide when expired — the "Start over" button still lives in the LN section.
  const showLightning = !!checkoutModel.invoice && !swapFocused && !expired;
  // Settled and expired keep the payment layout: after a swap deposit settles,
  // swapFocused is still true and would otherwise blank the whole widget.
  const hideLightning = !showLightning && !expired && !settled;
  // Amount/fiat already appear under the QR; pending is covered by WaitingState.
  // Keep the meta row only for terminal states that need a compact badge.
  const showSummaryMeta = checkoutModel.status === "settled" || checkoutModel.status === "expired";
  const fiatCurrency = checkoutModel.fiat_quote?.fiat?.currency;
  const decodeInvoiceHref = createLightningInvoiceDecodeUrl(checkoutModel.invoice, decodeLinkUrl);
  const startOver = () => {
    onStartOver?.();
  };

  const lightningPane =
    hideLightning || expired || settled
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
      ...(ownsTheme ? theme.attributes : {}),
    },
    customChildren === undefined
      ? [
          ownsTheme
            ? React.createElement(ThemeToggle, {
                key: "theme",
                className: classNames?.themeToggle,
                theme: theme.theme,
                resolvedTheme: theme.resolvedTheme,
                onThemeChange: theme.setTheme,
                ButtonComponent,
              })
            : null,
          mintingLightning
            ? React.createElement(
                "div",
                {
                  key: "minting-lightning",
                  className: orClasses.creating,
                },
                React.createElement("span", {
                  className: orClasses.spinner,
                  "aria-hidden": "true",
                }),
                React.createElement("p", null, checkoutLabels.preparingPayment),
              )
            : null,
          hideLightning
            ? null
            : React.createElement(
                "div",
                {
                  key: "payment-layout",
                  className:
                    expired || settled ? orClasses.paymentLayoutExpired : orClasses.paymentLayout,
                },
                lightningPane,
                React.createElement(
                  "div",
                  {
                    key: "payment-info",
                    className: orClasses.paymentInfo,
                  },
                  expired || settled
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
                        checkoutLabels.bitcoinLightningInvoice,
                      ),
                  React.createElement(WaitingState, {
                    key: "waiting",
                    waiting: checkoutModel.waiting,
                    statusTitle: checkoutModel.statusTitle,
                    statusDetail: checkoutModel.statusDetail,
                    settled,
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
                  settled
                    ? React.createElement(PaymentData, {
                        key: "payment-data",
                        // The model IS the checkout state, so the payment-data
                        // panel reads the same derivation the rest of the screen
                        // does. It used to re-flatten the snapshot separately,
                        // which reported the displayed ATTEMPT's transaction /
                        // workflow state on a checkout the state already knows
                        // is paid.
                        source: checkoutModel,
                        className: classNames?.details,
                      })
                    : expired
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
                            checkoutLabels.startOver,
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
                            key: "copy-invoice",
                            invoice: checkoutModel.invoice,
                            copyInvoice: checkoutModel.copyInvoice,
                            onError,
                            logger,
                            ButtonComponent,
                            className: classNames?.copyButton,
                          }),
                          // Opt-in slot: the default checkout ships no wallet button, so a
                          // desktop payer is never sent to a handler that does not exist.
                          OpenWalletButtonComponent === undefined
                            ? null
                            : React.createElement(OpenWalletButtonComponent, {
                                key: "open-wallet",
                                invoice: checkoutModel.invoice,
                                openWallet: checkoutModel.openWallet,
                                onError,
                                logger,
                                ButtonComponent,
                                className: classNames?.openWalletButton,
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
                                checkoutLabels.decodeInvoice,
                              ),
                        ),
                ),
              ),
          paymentWizard && !settled && (!expired || swapFocused)
            ? React.createElement(PaymentWizard, {
                key: "wizard",
                // Only pass invoice when it's a real bolt11 (non-empty, non-deferred).
                invoice: checkoutModel.invoice || undefined,
                checkout: checkoutModel.checkout,
                className: classNames?.wizard,
                logger,
                onError,
                onSwapFocusChange: setSwapFocused,
                prefix,
                qrEncoder,
                decodeLinkUrl,
                logContext: getCheckoutLogContext({
                  invoice_id: checkoutModel.invoice_id,
                  payment_hash: checkoutModel.payment_hash,
                  amount_msats: checkoutModel.amount_msats,
                }),
                onProviderCopy,
                onRequestLightning,
                onSwapStarted,
              })
            : null,
        ]
      : customChildren,
  );
}
