import * as React from "react";
import {
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
  createCheckoutProviderCopyEvent,
  createOpenReceivePaymentWizardController,
  createOpenReceivePaymentWizardModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  copyInvoice as copyInvoiceHelper,
  getOpenReceiveAssetIcon,
  getOpenReceiveDefaultCountryCode,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveWizardEmptyMessage,
  normalizeSwapStartInvoice,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
  openReceiveSwapAssetMatchesRoute,
  postOpenReceiveJson,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardController,
  type OpenReceivePaymentWizardModel,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
} from "@openreceive/browser/internal";
import { useOpenReceiveTickingUnixSeconds } from "./hooks.ts";
import {
  renderSwapActions,
  renderSwapDepositPanel,
  renderSwapPreparing,
  renderSwapUnavailable,
  swapOptionLimitMessage,
} from "./swap.ts";
import { joinClassNames, reactRecord } from "./utils.ts";
import type {
  OpenReceiveSwapOptionDisplay,
  OpenReceiveSwapOptionsResult,
  PaymentWizardProps,
} from "./types.ts";

export function PaymentWizard(props: PaymentWizardProps): React.ReactElement {
  const countryStorageKey = props.countryStorageKey ?? OPENRECEIVE_COUNTRY_STORAGE_KEY;
  const [selection, setSelection] = React.useState<OpenReceivePaymentWizardSelection>(() =>
    createOpenReceivePaymentWizardController({
      storageKey: countryStorageKey,
      defaultCountryCode: getOpenReceiveDefaultCountryCode(),
    }).getSelection(),
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
  const [swapQuotes, setSwapQuotes] = React.useState<Record<string, OpenReceiveSwapOptionDisplay>>(
    {},
  );
  // When a swap provider is configured, each pay-in coin is promoted to a top-level
  // choice. Selecting one jumps straight to its deposit address, bypassing the
  // country/route/provider steps. Null means the standard method grid is shown.
  const [selectedSwapAsset, setSelectedSwapAsset] = React.useState<string | null>(null);
  const autoSwapAttemptedRef = React.useRef<Set<string>>(new Set());
  // Tell the host (default Checkout) whether the payer is in the focused swap flow, so it
  // can hide the Lightning payment section while the swap deposit panel stands in for it.
  const onSwapFocusChange = props.onSwapFocusChange;
  React.useEffect(() => {
    onSwapFocusChange?.(selectedSwapAsset !== null);
    return () => onSwapFocusChange?.(false);
  }, [selectedSwapAsset, onSwapFocusChange]);
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
    [checkout, startedSwapInvoice, dismissedSwapInvoiceId],
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
          pay_in_asset: payInAsset,
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
    [props.orderUrl, orderId, fetcher, props.onError],
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
          pay_in_asset: payInAsset,
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
    [props.orderUrl, orderId, fetcher, props.onError],
  );
  const refundSwap = React.useCallback(
    async (attemptId: string, refundAddress: string, refundNonce: string, confirm: boolean) => {
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
          confirm,
        });
        const invoice = normalizeSwapStartInvoice(body);
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError],
  );
  const updateWizardSelection = React.useCallback(
    (
      apply: (controller: OpenReceivePaymentWizardController) => OpenReceivePaymentWizardSelection,
    ) => {
      setSelection((current) =>
        apply(
          createOpenReceivePaymentWizardController({
            selection: current,
            storageKey: countryStorageKey,
          }),
        ),
      );
    },
    [countryStorageKey],
  );
  const model = createOpenReceivePaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute,
  });
  const routeDisplays = createOpenReceiveWizardRouteDisplays(wizard.routes);
  const showRoutePicker =
    routeAssetDisplays.length > 0 && (model.selectedRoute === null || routeDisplays.length === 0);
  const activeTutorialProvider =
    activeTutorial === null
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
  const selectedSwapQuote = selectedSwapAsset === null ? undefined : swapQuotes[selectedSwapAsset];
  const selectedSwapLabel = selectedSwapOption?.label ?? "this coin";

  if (selectedSwapAsset !== null) {
    return React.createElement(
      "div",
      {
        className: joinClassNames("or-wizard", props.className),
      },
      renderWizardBackBreadcrumb(
        selectedSwapOption === undefined
          ? selectedSwapLabel
          : `${selectedSwapOption.label} · ${selectedSwapOption.network_label}`,
        () => setSelectedSwapAsset(null),
      ),
      React.createElement(
        "div",
        {
          className: "or-wizard-results",
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
              },
            })
          : selectedSwapQuote !== undefined && !selectedSwapQuote.available
            ? renderSwapUnavailable(selectedSwapQuote, checkout)
            : renderSwapPreparing(selectedSwapLabel),
      ),
    );
  }

  return React.createElement(
    "div",
    {
      className: joinClassNames("or-wizard", props.className),
    },
    selection.selectedMethod === null
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "div",
            {
              className: "or-wizard-header",
            },
            React.createElement(
              "div",
              null,
              React.createElement("h2", null, openReceiveCheckoutLabels.wizardTitle),
              React.createElement("p", null, openReceiveCheckoutLabels.wizardSubtitle),
            ),
          ),
          React.createElement(
            "div",
            {
              className: "or-method-grid",
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
                    updateWizardSelection((controller) => controller.selectMethod(method.id));
                  },
                  type: "button",
                },
                React.createElement("img", {
                  alt: "",
                  src: getOpenReceivePaymentMethodIcon(method.id),
                }),
                React.createElement("span", null, method.title),
                React.createElement("small", null, method.detail),
              ),
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
                  type: "button",
                },
                React.createElement("img", {
                  alt: "",
                  src: getOpenReceiveAssetIcon(option.label.toLowerCase()),
                }),
                React.createElement("span", null, option.label),
                React.createElement(
                  "small",
                  null,
                  disabled && limitMessage !== undefined ? limitMessage : option.network_label,
                ),
              );
            }),
          ),
        )
      : null,
    selection.selectedMethod === null
      ? null
      : renderWizardBreadcrumbs({
          method: selection.selectedMethod,
          selectedRoute: model.selectedRoute,
          routeAssets: routeAssetDisplays,
          onChangeMethod: () => {
            updateWizardSelection((controller) => controller.changeMethod());
          },
          onChangeRoute: () => {
            updateWizardSelection((controller) => controller.update({ type: "change_route" }));
          },
        }),
    showRoutePicker && selection.selectedMethod === "bitcoin"
      ? renderRoutePicker({
          assets: routeAssetDisplays,
          method: "bitcoin",
          onSelectRoute: (route) => {
            updateWizardSelection((controller) => controller.selectRoute(route));
          },
        })
      : null,
    showRoutePicker && selection.selectedMethod === "crypto"
      ? renderRoutePicker({
          assets: routeAssetDisplays,
          method: "crypto",
          onSelectRoute: (route) => {
            updateWizardSelection((controller) => controller.selectRoute(route));
          },
        })
      : null,
    selection.selectedMethod === null
      ? null
      : React.createElement(
          "div",
          {
            className: "or-wizard-results",
          },
          routeDisplays.length === 0
            ? React.createElement(
                "p",
                {
                  className: "or-wizard-empty",
                },
                getOpenReceiveWizardEmptyMessage(selection.selectedMethod),
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
                    key: route.key,
                  },
                  React.createElement(
                    "div",
                    {
                      className: "or-wizard-route-heading",
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
                                  controller.selectCountry(countryCode),
                                );
                              },
                            }),
                      ),
                    ),
                  ),
                  activeSwapForRoute === undefined
                    ? renderSwapActions({
                        options: routeSwapOptions,
                        enabled: swapOptions.enabled,
                        startingAsset: swapStartingAsset,
                        onStart: startSwap,
                        checkout,
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
                        },
                      }),
                  activeSwapForRoute === undefined
                    ? React.createElement(
                        "div",
                        {
                          className: "or-provider-grid",
                        },
                        route.providers.map((provider) =>
                          React.createElement(
                            "article",
                            {
                              className: provider.recommended
                                ? "or-provider-card recommended"
                                : "or-provider-card",
                              key: provider.id,
                            },
                            React.createElement(
                              "div",
                              {
                                className: "or-provider-heading",
                              },
                              React.createElement("img", {
                                alt: "",
                                src: provider.icon,
                              }),
                              React.createElement("h4", null, provider.name),
                              provider.recommendedLabel === null
                                ? null
                                : React.createElement("span", null, provider.recommendedLabel),
                            ),
                            React.createElement(
                              "p",
                              {
                                className: "or-provider-kind",
                              },
                              provider.kind,
                            ),
                            React.createElement(
                              "div",
                              {
                                className: "or-provider-actions",
                              },
                              renderProviderOpenAction(provider, () =>
                                setActiveTutorial({
                                  providerId: provider.id,
                                  index: 0,
                                  copied: false,
                                }),
                              ),
                            ),
                          ),
                        ),
                      )
                    : null,
                );
              }),
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
                logContext: props.logContext,
              });
              globalThis.dispatchEvent?.(
                createCheckoutProviderCopyEvent(activeTutorialProvider.id),
              );
              setActiveTutorial({
                providerId: activeTutorialProvider.id,
                index: 0,
                copied: true,
              });
            } catch (error) {
              props.onError?.(error);
            }
          },
          onStep: (index) =>
            setActiveTutorial({
              providerId: activeTutorialProvider.id,
              index,
              copied: activeTutorial.copied,
            }),
        }),
  );
}

function renderWizardBackBreadcrumb(currentLabel: string, onBack: () => void): React.ReactElement {
  return React.createElement(
    "div",
    {
      className: "or-wizard-breadcrumbs",
    },
    React.createElement(
      "button",
      {
        className: "or-wizard-breadcrumb",
        onClick: onBack,
        type: "button",
      },
      openReceiveCheckoutLabels.paymentMethod,
    ),
    React.createElement(
      "span",
      { className: "or-wizard-breadcrumb-separator", "aria-hidden": "true" },
      "/",
    ),
    React.createElement("span", { className: "or-wizard-breadcrumb-current" }, currentLabel),
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
  const routeLabel =
    options.selectedRoute === null || options.routeAssets.length <= 1
      ? null
      : (options.routeAssets.find((asset) => asset.id === options.selectedRoute)?.label ??
        options.selectedRoute);

  return React.createElement(
    "nav",
    {
      "aria-label": "Payment path",
      className: "or-wizard-breadcrumbs",
    },
    React.createElement(
      "button",
      {
        className: "or-wizard-breadcrumb",
        onClick: options.onChangeMethod,
        type: "button",
      },
      openReceiveCheckoutLabels.paymentMethod,
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
              type: "button",
            },
            methodLabel,
          ),
          React.createElement("span", { "aria-hidden": "true" }, "/"),
          React.createElement("span", { className: "or-wizard-breadcrumb-current" }, routeLabel),
        ),
  );
}

function swapOptionsForRoute(
  routeKey: string,
  options: readonly OpenReceiveSwapOptionDisplay[],
): readonly OpenReceiveSwapOptionDisplay[] {
  return options.filter((option) =>
    openReceiveSwapAssetMatchesRoute(routeKey, option.pay_in_asset),
  );
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
  dismissedInvoiceId: string | null,
): CheckoutInvoiceSnapshot | undefined {
  const fromCheckout = checkout?.invoices.find(
    (invoice) =>
      invoice.rail === "swap" &&
      invoice.swap !== undefined &&
      invoice.invoice_id !== dismissedInvoiceId,
  );
  if (local === null || local.invoice_id === dismissedInvoiceId) return fromCheckout;
  return checkout?.invoices.find((invoice) => invoice.invoice_id === local.invoice_id) ?? local;
}

function renderProviderOpenAction(
  provider: OpenReceiveWizardProviderDisplay,
  onOpenTutorial: () => void,
): React.ReactElement {
  if (provider.tutorials.length === 0) {
    return React.createElement(
      "a",
      {
        href: provider.url,
        rel: "noreferrer",
        target: "_blank",
      },
      provider.openLabel,
    );
  }

  return React.createElement(
    "button",
    {
      className: "or-provider-open",
      onClick: onOpenTutorial,
      type: "button",
    },
    provider.openLabel,
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
      tabIndex: -1,
    },
    React.createElement(
      "div",
      {
        className: "or-tutorial-dialog",
      },
      React.createElement(
        "div",
        {
          className: "or-tutorial-header",
        },
        React.createElement(
          "div",
          {
            className: "or-tutorial-title",
          },
          React.createElement("img", {
            alt: "",
            className: "or-tutorial-header-logo",
            src: provider.icon,
          }),
          React.createElement(
            "h3",
            null,
            `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`,
          ),
        ),
        React.createElement(
          "button",
          {
            "aria-label": "Close",
            className: "or-tutorial-close",
            onClick: options.onClose,
            type: "button",
          },
          "X",
        ),
      ),
      stepIndex === 0
        ? React.createElement(
            "div",
            {
              className: "or-tutorial-intro",
            },
            React.createElement("img", {
              alt: "",
              className: "or-tutorial-provider-logo",
              src: provider.icon,
            }),
            React.createElement(
              "p",
              null,
              `${openReceiveCheckoutLabels.tutorialIntroPrefix} ${provider.name}.`,
            ),
            React.createElement("p", null, openReceiveCheckoutLabels.tutorialIntroCopy),
            React.createElement(
              "button",
              {
                className: "or-tutorial-copy",
                onClick: () => void options.onCopy(),
                type: "button",
              },
              openReceiveCheckoutLabels.copyInvoice,
            ),
            options.copied
              ? React.createElement(
                  "p",
                  {
                    className: "or-tutorial-copy-message",
                  },
                  openReceiveCheckoutLabels.tutorialCopiedContinue,
                )
              : null,
          )
        : React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "div",
              {
                className: "or-tutorial-frame",
              },
              React.createElement("img", {
                alt: tutorial?.caption ?? "",
                className: "or-tutorial-image",
                src: tutorial?.image ?? "",
              }),
            ),
            React.createElement(
              "p",
              {
                className: "or-tutorial-caption",
              },
              tutorial?.caption ?? "",
            ),
          ),
      React.createElement(
        "div",
        {
          "aria-hidden": "true",
          className: "or-tutorial-steps",
        },
        Array.from({ length: totalSteps }, (_, index) =>
          React.createElement("span", {
            className: index === stepIndex ? "or-tutorial-step active" : "or-tutorial-step",
            key: index,
          }),
        ),
      ),
      React.createElement(
        "p",
        {
          className: "or-tutorial-progress",
        },
        `Step ${stepIndex + 1} of ${totalSteps}`,
      ),
      React.createElement(
        "div",
        {
          className: "or-tutorial-controls",
        },
        React.createElement(
          "button",
          {
            disabled: stepIndex === 0,
            onClick: () => options.onStep(previousIndex),
            type: "button",
          },
          "Back",
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
            type: "button",
          },
          isFinalStep ? openReceiveCheckoutLabels.tutorialExit : "Next",
        ),
      ),
    ),
  );
}

function renderCountrySelect(options: {
  readonly countries: OpenReceivePaymentWizardModel["countryDisplays"];
  readonly selectedCountryCode: string;
  readonly onSelectCountry: (countryCode: string) => void;
}): React.ReactElement {
  return React.createElement(
    "label",
    {
      className: "or-country-select",
    },
    React.createElement("span", null, openReceiveCheckoutLabels.chooseCountry),
    React.createElement(
      "select",
      {
        value: options.selectedCountryCode,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          options.onSelectCountry(event.currentTarget.value);
        },
      },
      options.countries.map((country) =>
        React.createElement(
          "option",
          {
            key: country.code,
            value: country.code,
          },
          country.label,
        ),
      ),
    ),
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
      className: `or-route-picker or-route-picker-${options.method}`,
    },
    options.assets.map((asset) => {
      return React.createElement(
        "button",
        {
          className: asset.selected ? "selected" : "",
          key: asset.id,
          onClick: () => options.onSelectRoute(asset.id),
          type: "button",
        },
        React.createElement("img", {
          alt: "",
          src: asset.icon,
        }),
        React.createElement("span", null, asset.label),
        React.createElement("small", null, asset.subtitle),
      );
    }),
  );
}
