import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  checkoutLabels,
  createLightningInvoiceDecodeUrl,
  enterCheckoutResumePath,
  mergeAttemptIntoCheckout,
  mergeAttemptIntoSnapshot,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_STYLE_ROOT_ATTRIBUTE,
  OPENRECEIVE_DEFAULT_PREFIX,
  orClasses,
  prepareCheckout,
  requestCheckout,
  resumeSwapAttempt,
  validateCheckoutProps,
} from "@openreceive/browser/headless";
import * as React from "react";
import { useCheckoutSession } from "./checkout-session.ts";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  PaymentState,
  QRCode,
  SatsDetail,
  WaitingState,
} from "./components.ts";
import { ThemeToggle, useTheme } from "./theme.ts";
import { TransactionDetails } from "./transaction-details.ts";
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
    resumePaymentHash: props.resumePaymentHash,
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
    resumePaymentHash,
    theme: lockedTheme,
    defaultTheme,
    storageKey,
  } = props;
  // The creating and error screens are themed like the checkout they precede:
  // the same resolution CheckoutView runs (lock, ancestor ThemeScope, stored
  // choice, system), stamped as `data-theme` on their root. Without it both
  // screens painted the light palette on a dark host — a white flash on every
  // checkout open, and an all-white error screen.
  const theme = useTheme({ defaultTheme, storageKey, theme: lockedTheme });
  const themeAttributes = theme.fromScope
    ? { "data-theme": theme.resolvedTheme }
    : theme.attributes;

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
      // A host that remembered this order's swap attempt gets it back on the
      // screen; prepare returns none, so without this a bookmarked refund opens
      // on the method grid. `resumeSwapAttempt` swallows a stale hash, so the
      // failure mode is the checkout the payer would have had anyway.
      .then((checkout) =>
        resumePaymentHash === undefined
          ? checkout
          : resumeSwapAttempt({
              fetch: createFetchRef.current ?? globalThis.fetch,
              prefix: resolvedPrefix,
              reference,
              paymentHash: resumePaymentHash,
              snapshot: checkout,
            }),
      )
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
  }, [reference, resolvedPrefix, resumePaymentHash, attempt]);

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

  // Both pre-create screens are the same root the checkout will render into
  // (surface, padding, theme), with the notice body inside — the custom
  // element nests them the same way.
  if (created.status === "error") {
    return React.createElement(
      "section",
      {
        className: joinClassNames(
          className,
          orClasses.root,
          classNames?.root,
          "openreceive-checkout-error",
        ),
        [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
        [OPENRECEIVE_STYLE_ROOT_ATTRIBUTE]: "",
        ...themeAttributes,
      },
      React.createElement(
        "div",
        { className: orClasses.creating },
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
      ),
    );
  }

  return React.createElement(
    "section",
    {
      className: joinClassNames(
        className,
        orClasses.root,
        classNames?.root,
        "openreceive-checkout-creating",
      ),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      [OPENRECEIVE_STYLE_ROOT_ATTRIBUTE]: "",
      ...themeAttributes,
    },
    React.createElement(
      "div",
      { className: orClasses.creating },
      React.createElement("span", {
        className: orClasses.spinner,
        "aria-hidden": "true",
      }),
      React.createElement("p", null, "Creating checkout…"),
    ),
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
    // Not `_`-prefixed like its neighbours: the view reads it, to infer
    // `resumable` for the refund screen. Still destructured out so it never
    // reaches the rendered <section>.
    syncUrl,
    resumePathPrefix: _resumePathPrefix,
    routeReference,
    // Consumed by CheckoutCreate before the view exists; destructured out here
    // so it never reaches the rendered <section> as an attribute.
    resumePaymentHash: _resumePaymentHash,
    resumable,
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
    theme: lockedTheme,
    defaultTheme,
    storageKey,
    components,
    classNames,
    children,
    resolveAssetUrl,
    assetBaseUrl,
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
    theme: lockedTheme,
  });
  // An ancestor ThemeScope already stamps data-theme and renders the page
  // toggle; a standalone checkout stamps its own — with or without the toggle,
  // because hiding the control must not unstyle the widget. The toggle itself
  // renders only when there is something to toggle: not under a scope, and not
  // when the host locked the theme.
  const stampsTheme = !theme.fromScope;
  const ownsTheme = themeToggle && !theme.fromScope && lockedTheme === undefined;
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
  // received" status plus the transaction-details panel take their place.
  const settled = checkoutModel.status === "settled";
  // The QR pane needs a minted bolt11, no focused swap deposit panel, and an
  // unexpired invoice. Expiry removes the PANE but keeps the LN section, because
  // that is where the "Start over" button lives — which is what `hideLightning`
  // below (the whole-section switch) spells out.
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
      [OPENRECEIVE_STYLE_ROOT_ATTRIBUTE]: "",
      // A standalone Checkout owns its theme and stamps both attributes. Under
      // ThemeScope the scope is the theme root (`data-openreceive-theme` stays
      // on it), but the resolved `data-theme` is mirrored here too: the scoped
      // stylesheet paints the palette from the checkout's own root, not from
      // an ancestor outside it.
      ...(stampsTheme ? theme.attributes : { "data-theme": theme.resolvedTheme }),
    },
    [
      // Order context from the host, composed ABOVE the shipped payment UI —
      // the same position as the custom element's `order` slot. Children never
      // replace the payment UI; a host that wants its own checkout builds on
      // useCheckout / @openreceive/browser/headless instead.
      customChildren === undefined
        ? null
        : React.createElement(React.Fragment, { key: "order-children" }, customChildren),
      ...[
        // Above the amount and OUTSIDE the Lightning pane, which drops out on
        // the swap deposit panel, on expiry and on the receipt — the payer
        // needs to know what they are buying on all four screens.
        checkoutModel.checkout.description === undefined ||
        checkoutModel.checkout.description === ""
          ? null
          : React.createElement(
              "p",
              {
                key: "order-description",
                className: joinClassNames(orClasses.orderDescription, classNames?.orderDescription),
                [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.orderDescription]: "",
              },
              checkoutModel.checkout.description,
            ),
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
                        className: joinClassNames(orClasses.invoiceTitle, classNames?.invoiceTitle),
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
                  ? React.createElement(TransactionDetails, {
                      key: "transaction-details",
                      // The model IS the checkout state, so the panel reads
                      // the same derivation the rest of the screen does. It
                      // used to re-flatten the snapshot separately, which
                      // reported the displayed ATTEMPT's transaction /
                      // workflow state on a checkout the state already knows
                      // is paid.
                      //
                      // The SAME panel the swap flow renders one screen
                      // earlier. A payer's whole evidence that they paid is a
                      // payment hash and, on a swap, a deposit txid — so the
                      // most keep-worthy screen gets copy buttons and
                      // explorer links, not un-copyable text. No
                      // `decodeLinkUrl` is passed, so the bolt11 never
                      // reaches a third party.
                      state: checkoutModel,
                      className: classNames?.details,
                      onError,
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
              onCopy,
              onRequestLightning,
              onSwapStarted,
              resolveAssetUrl,
              assetBaseUrl,
              // Whether a payer who closes the tab has a URL to come back
              // to. Explicit wins — only the host knows about a per-order
              // route of its own; otherwise infer it from the two props that
              // put the reference in the URL.
              resumable: resumable ?? (syncUrl === true || routeReference !== undefined),
              // The engine's staged refund address rides the controller this
              // model owns, so a poll cannot wipe a review in progress.
              swapRefund: checkoutModel,
            })
          : null,
      ],
    ],
  );
}
