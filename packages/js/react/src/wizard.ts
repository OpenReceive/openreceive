// The React payment wizard: the method grid, the network selector, the
// route/asset pickers, and the breadcrumb trail. The deposit panel lives in
// ./swap.ts and the provider tutorial modal in ./provider-tutorial.ts.
import {
  buildMethodGridEntries,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  copyInvoice as copyInvoiceHelper,
  createCheckoutProviderCopyEvent,
  createPaymentWizardController,
  createPaymentWizardModel,
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  findSwapGridGroup,
  formatChooseNetworkHeading,
  formatNetworkSummary,
  getNetworkIcon,
  getPaymentMethodIcon,
  getSwapOptionIcon,
  getWizardEmptyMessage,
  assetButtonClasses,
  checkoutLabels,
  networkButtonClasses,
  networkCheckClasses,
  networkMobileRevealClasses,
  networkSummaryIconClasses,
  paymentAccentId,
  type PaymentMethod,
  paymentMethods,
  type PaymentWizardController,
  type PaymentWizardSelection,
  swapAssetMatchesRoute,
  swapGroupLimitOption,
  swapOptionLimitMessage,
  swapPickerKey,
  type WizardRouteAssetDisplay,
  orClasses,
  overlaySwapRefundStaging,
  postJson,
  requestSwapRefund,
  updateSelectedSwapNetworks,
} from "@openreceive/browser/headless";
import { recordOrEmpty } from "@openreceive/core";
import * as React from "react";
import { useCheckoutSession } from "./checkout-session.ts";
import { useTickingUnixSeconds } from "./hooks.ts";
import {
  renderSwapActions,
  renderSwapDepositPanel,
  renderSwapPreparing,
  renderSwapStartError,
  renderSwapUnavailable,
} from "./swap.ts";
import type { SwapOptionDisplay, SwapOptionsResult, PaymentWizardProps } from "./types.ts";
import { joinClassNames } from "./utils.ts";
import { ProviderTutorialModal, renderProviderOpenAction } from "./provider-tutorial.ts";

export function PaymentWizard(props: PaymentWizardProps): React.ReactElement {
  const [selection, setSelection] = React.useState<PaymentWizardSelection>(() =>
    createPaymentWizardController().getSelection(),
  );
  const [activeTutorial, setActiveTutorial] = React.useState<{
    readonly providerId: string;
    readonly index: number;
    readonly copied: boolean;
  } | null>(null);
  const [startedSwapInvoice, setStartedSwapInvoice] =
    React.useState<CheckoutInvoiceSnapshot | null>(null);
  const [dismissedSwapInvoiceId, setDismissedSwapInvoiceId] = React.useState<string | null>(null);
  const [swapQuotes, setSwapQuotes] = React.useState<Record<string, SwapOptionDisplay>>({});
  // When a swap provider is configured, each pay-in coin is promoted to a top-level
  // choice. Selecting one jumps straight to its deposit address, bypassing the
  // country/route/provider steps. Null means the standard method grid is shown.
  const [selectedSwapAsset, setSelectedSwapAsset] = React.useState<string | null>(null);
  // For multi-network coins (USDT), remember which network the payer picked before
  // confirming the method tile.
  const [selectedSwapNetworks, setSelectedSwapNetworks] = React.useState<Record<string, string>>(
    {},
  );
  // Compact selector: which asset tile is currently selected (method:… or swap:…).
  const [selectedPickerKey, setSelectedPickerKey] = React.useState<string | null>(null);
  const autoSwapAttemptedRef = React.useRef<Set<string>>(new Set());
  const fetcher = props.fetch ?? globalThis.fetch;
  const checkout = props.checkout;
  const reference = checkout?.reference;
  // The swap start, shared with the custom element (G6): one in-flight start per
  // wizard, one error string, and the same "already holding this asset's
  // instructions" answer. The wizard supplies what is genuinely React's — where
  // the started attempt is published (up to whichever component owns the
  // snapshot) and where the failure is surfaced.
  const session = useCheckoutSession({
    snapshot: () => checkout,
    reference: () => reference,
    swapPrefix: () => props.prefix,
    fetch: () => fetcher,
    swapSelection: {
      started: () => startedSwapInvoice ?? undefined,
      setStarted: setStartedSwapInvoice,
      dismissedInvoiceId: () => dismissedSwapInvoiceId,
      setDismissedInvoiceId: setDismissedSwapInvoiceId,
      setSelectedAsset: setSelectedSwapAsset,
    },
    onSwapStarted: (invoice) => props.onSwapStarted?.(invoice),
    ...(props.logger === undefined ? {} : { logger: props.logger }),
    onError: (error) => props.onError?.(error),
  });
  // Read once per render: the session's fields are plain values, and its
  // `onChange` is what turns a change in them into the next render.
  const { startSwap, swapStartError, startingSwapAsset: swapStartingAsset } = session;
  // Leave the focused swap flow and restore the default method grid (nothing selected).
  // The start failure belongs to the asset being left: keeping it would show the previous
  // coin's message on the next one, with retry wired to the new coin.
  const clearSwapFocus = React.useCallback(() => {
    setSelectedSwapAsset(null);
    setSelectedPickerKey(null);
    setSelectedSwapNetworks({});
    session.clearSwapStartError();
  }, [session]);
  // Tell the host (default Checkout) whether the payer is in the focused swap flow, so it
  // can hide the Lightning payment section while the swap deposit panel stands in for it.
  const onSwapFocusChange = props.onSwapFocusChange;
  React.useEffect(() => {
    onSwapFocusChange?.(selectedSwapAsset !== null);
    return () => onSwapFocusChange?.(false);
  }, [selectedSwapAsset, onSwapFocusChange]);
  // Payable assets ride on the order object itself (payment_methods), so the
  // wizard lists methods straight from the polled order snapshot — no extra call.
  const swapOptions = React.useMemo<SwapOptionsResult>(() => {
    const methods = checkout?.payment_methods ?? [];
    return { enabled: methods.length > 0, options: methods };
  }, [checkout]);

  const currentSwapInvoice = React.useMemo(
    () => selectCurrentSwapInvoice(checkout, startedSwapInvoice, dismissedSwapInvoiceId),
    [checkout, startedSwapInvoice, dismissedSwapInvoiceId],
  );
  const now = useTickingUnixSeconds(currentSwapInvoice !== undefined);
  const quoteSwap = React.useCallback(
    async (payInAsset: string): Promise<SwapOptionDisplay | undefined> => {
      const prefix = props.prefix;
      if (prefix === undefined || reference === undefined || fetcher === undefined) {
        return undefined;
      }
      try {
        const body = await postJson({
          fetch: fetcher,
          prefix,
          body: {
            reference: reference,
            action: "swap_quote",
            pay_in_asset: payInAsset,
          },
        });
        const quote = normalizeSwapQuote(body);
        if (quote !== undefined) {
          setSwapQuotes((current) => ({ ...current, [payInAsset]: quote }));
        }
        return quote;
      } catch (error) {
        // A failed quote must not strand the payer on the preparing spinner: it
        // surfaces inline with the retry button, and only that explicit retry —
        // never this effect — may attempt the swap again.
        session.failSwapStart(error);
        return undefined;
      }
    },
    [props.prefix, reference, fetcher, session],
  );
  // Enter the focused flow for a pay-in coin. The effect below quotes it first and only
  // starts the swap when the quote confirms the amount is in range.
  const selectSwapAsset = React.useCallback(
    (payInAsset: string) => {
      if (props.prefix === undefined) return;
      autoSwapAttemptedRef.current.delete(payInAsset);
      session.clearSwapStartError();
      setSelectedSwapAsset(payInAsset);
    },
    [props.prefix, session],
  );
  const refundSwap = React.useCallback(
    async (attemptId: string, refundAddress: string, refundNonce: string, confirm: boolean) => {
      const prefix = props.prefix;
      if (prefix === undefined || reference === undefined || fetcher === undefined) {
        return;
      }
      try {
        const invoice = await requestSwapRefund({
          fetch: fetcher,
          prefix,
          reference,
          invoices: [startedSwapInvoice, ...(checkout?.invoices ?? [])],
          attemptId,
          refundAddress,
          refundNonce,
          confirm,
          ...(props.logger === undefined ? {} : { logger: props.logger }),
        });
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      }
    },
    [
      props.prefix,
      reference,
      fetcher,
      props.onError,
      props.logger,
      startedSwapInvoice,
      checkout?.invoices,
    ],
  );
  const updateWizardSelection = React.useCallback(
    (apply: (controller: PaymentWizardController) => PaymentWizardSelection) => {
      setSelection((current) => apply(createPaymentWizardController({ selection: current })));
    },
    [],
  );
  const model = createPaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute,
  });
  const routeDisplays = createWizardRouteDisplays(wizard.routes);
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
  const stickySwapInvoiceRef = React.useRef<CheckoutInvoiceSnapshot | undefined>(undefined);
  if (
    currentSwapInvoice !== undefined &&
    currentSwapInvoice.invoice_id !== dismissedSwapInvoiceId
  ) {
    stickySwapInvoiceRef.current = currentSwapInvoice;
  } else if (stickySwapInvoiceRef.current?.invoice_id === dismissedSwapInvoiceId) {
    stickySwapInvoiceRef.current = undefined;
  }
  const activeSwapForAsset =
    selectedSwapAsset === null
      ? undefined
      : currentSwapInvoice !== undefined &&
          currentSwapInvoice.swap?.pay_in_asset === selectedSwapAsset
        ? currentSwapInvoice
        : stickySwapInvoiceRef.current?.swap?.pay_in_asset === selectedSwapAsset
          ? stickySwapInvoiceRef.current
          : undefined;

  // Selecting a top-level coin quotes it FIRST (to confirm the amount is in range) and,
  // when available, starts the swap so the payer lands on the deposit address. A start
  // that fails leaves its entry in the attempted set, so this effect never re-POSTs
  // /swaps on its own — recovery is the payer's explicit retry button.
  React.useEffect(() => {
    if (selectedSwapAsset === null) return;
    if (props.prefix === undefined) return;
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
  }, [selectedSwapAsset, activeSwapForAsset, props.prefix, quoteSwap, startSwap]);

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
        className: joinClassNames(orClasses.wizard, props.className),
      },
      React.createElement(
        "div",
        { className: orClasses.wizardBody },
        renderWizardBackBreadcrumb(
          selectedSwapOption === undefined
            ? selectedSwapLabel
            : `${selectedSwapOption.label} · ${selectedSwapOption.network_label}`,
          clearSwapFocus,
        ),
        React.createElement(
          "div",
          {
            className: orClasses.wizardResults,
          },
          swapStartError !== undefined && activeSwapForAsset === undefined
            ? renderSwapStartError(
                swapStartError,
                selectedSwapAsset === null
                  ? undefined
                  : () => {
                      autoSwapAttemptedRef.current.delete(selectedSwapAsset);
                      void startSwap(selectedSwapAsset);
                    },
              )
            : activeSwapForAsset !== undefined
              ? renderSwapDepositPanel({
                  invoice: activeSwapForAsset,
                  checkout,
                  now,
                  encoder: props.qrEncoder,
                  clipboard: props.clipboard,
                  logger: props.logger,
                  onError: props.onError,
                  onRefund: refundSwap,
                  onBackToLightning: () => {
                    setDismissedSwapInvoiceId(activeSwapForAsset.invoice_id);
                    clearSwapFocus();
                    // Ensure the Lightning invoice is ready (reuse or remint).
                    void props.onRequestLightning?.();
                  },
                })
              : selectedSwapQuote !== undefined && !selectedSwapQuote.available
                ? renderSwapUnavailable(selectedSwapQuote, checkout)
                : renderSwapPreparing(selectedSwapLabel),
        ),
      ),
    );
  }

  return React.createElement(
    "div",
    {
      className: joinClassNames(orClasses.wizard, props.className),
    },
    selection.selectedMethod === null
      ? renderCompactPaymentMethodSelector({
          swapAssetOptions,
          // Create-checkout snapshot has no payment_methods yet; order status fills them
          // after the provider catalog (ccies) warms. Show a loader instead of Crypto.
          currenciesLoading: checkout?.payment_methods === undefined,
          checkout: checkout ?? undefined,
          selectedPickerKey,
          startingAsset: swapStartingAsset,
          selectedSwapNetworks,
          onSelectPicker: (key, previousKey) => {
            setSelectedPickerKey(key);
            const entries = buildMethodGridEntries(paymentMethods, swapAssetOptions);
            setSelectedSwapNetworks((current) =>
              updateSelectedSwapNetworks({
                entries,
                nextKey: key,
                previousKey,
                selectedNetworks: current,
              }),
            );
          },
          onSelectNetwork: (groupKey, payInAsset) => {
            setSelectedSwapNetworks((current) => ({
              ...current,
              [groupKey]: payInAsset,
            }));
          },
          onContinueMethod: (methodId) => {
            updateWizardSelection((controller) =>
              controller.selectMethod(methodId as PaymentMethod),
            );
            // Trigger LN mint when Bitcoin is selected. Fire-and-forget: the host
            // (CheckoutCreate) decides whether to reuse an existing invoice or mint a
            // new one. Safe to call even when already minted (idempotent reuse check).
            if (methodId === "bitcoin") {
              void props.onRequestLightning?.();
            }
          },
          onContinueSwap: selectSwapAsset,
        })
      : null,
    selection.selectedMethod === null
      ? null
      : React.createElement(
          "div",
          { className: orClasses.wizardBody },
          renderWizardBreadcrumbs({
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
          React.createElement(
            "div",
            {
              className: orClasses.wizardResults,
            },
            routeDisplays.length === 0
              ? React.createElement(
                  "p",
                  {
                    className: orClasses.wizardEmpty,
                  },
                  getWizardEmptyMessage(),
                )
              : routeDisplays.map((route) => {
                  const routeSwapOptions = swapOptionsForRoute(route.key, swapOptions.options);
                  const activeSwapForRoute =
                    currentSwapInvoice !== undefined &&
                    swapAssetMatchesRoute(route.key, currentSwapInvoice.swap?.pay_in_asset)
                      ? currentSwapInvoice
                      : undefined;
                  return React.createElement(
                    "section",
                    {
                      className: orClasses.wizardRoute,
                      key: route.key,
                    },
                    React.createElement(
                      "div",
                      {
                        className: orClasses.wizardRouteHeading,
                      },
                      React.createElement(
                        "div",
                        null,
                        React.createElement("h3", null, route.title),
                      ),
                    ),
                    activeSwapForRoute === undefined
                      ? renderSwapActions({
                          options: routeSwapOptions,
                          enabled: swapOptions.enabled,
                          startingAsset: swapStartingAsset,
                          onStart: selectSwapAsset,
                          checkout,
                        })
                      : renderSwapDepositPanel({
                          invoice: activeSwapForRoute,
                          checkout,
                          now,
                          encoder: props.qrEncoder,
                          clipboard: props.clipboard,
                          logger: props.logger,
                          onError: props.onError,
                          onRefund: refundSwap,
                          onBackToLightning: () => {
                            setDismissedSwapInvoiceId(activeSwapForRoute.invoice_id);
                            clearSwapFocus();
                            void props.onRequestLightning?.();
                          },
                        }),
                    activeSwapForRoute === undefined
                      ? React.createElement(
                          "div",
                          {
                            className: orClasses.providerGrid,
                          },
                          route.providers.map((provider) =>
                            React.createElement(
                              "article",
                              {
                                className: orClasses.providerCard,
                                key: provider.id,
                              },
                              React.createElement(
                                "div",
                                {
                                  className: orClasses.providerHeading,
                                },
                                React.createElement("img", {
                                  alt: "",
                                  className: orClasses.providerIcon,
                                  src: provider.icon,
                                }),
                                React.createElement(
                                  "h4",
                                  { className: orClasses.providerName },
                                  provider.name,
                                ),
                              ),
                              React.createElement(
                                "p",
                                {
                                  className: orClasses.providerKind,
                                },
                                provider.kind,
                              ),
                              React.createElement(
                                "div",
                                {
                                  className: orClasses.providerActions,
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
        ),
    activeTutorialProvider === undefined || activeTutorial === null
      ? null
      : React.createElement(ProviderTutorialModal, {
          key: "provider-tutorial",
          provider: activeTutorialProvider,
          index: activeTutorial.index,
          copied: activeTutorial.copied,
          invoice: props.invoice ?? "",
          ...(props.decodeLinkUrl === undefined ? {} : { decodeLinkUrl: props.decodeLinkUrl }),
          onClose: () => setActiveTutorial(null),
          onCopy: async () => {
            try {
              if (!props.invoice) return;
              await copyInvoiceHelper({
                invoice: props.invoice,
                logger: props.logger,
                logContext: props.logContext,
              });
              globalThis.dispatchEvent?.(
                createCheckoutProviderCopyEvent(activeTutorialProvider.id),
              );
              props.onProviderCopy?.(activeTutorialProvider.id);
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

function renderCompactPaymentMethodSelector(options: {
  readonly swapAssetOptions: readonly SwapOptionDisplay[];
  readonly currenciesLoading?: boolean;
  readonly checkout: CheckoutSnapshot | undefined;
  readonly selectedPickerKey: string | null;
  readonly startingAsset: string | null;
  readonly selectedSwapNetworks: Readonly<Record<string, string>>;
  readonly onSelectPicker: (key: string, previousKey: string | null) => void;
  readonly onSelectNetwork: (groupKey: string, payInAsset: string) => void;
  readonly onContinueMethod: (methodId: string) => void;
  readonly onContinueSwap: (payInAsset: string) => void;
}): React.ReactElement {
  const entries = buildMethodGridEntries(paymentMethods, options.swapAssetOptions);
  const currenciesLoading =
    options.currenciesLoading === true && options.swapAssetOptions.length === 0;
  const selectedKey = options.selectedPickerKey;
  const selectedGroup = findSwapGridGroup(entries, selectedKey);
  const networkRequired = selectedGroup !== undefined && selectedGroup.options.length > 1;
  const selectedGroupKey = selectedGroup?.label.trim().toUpperCase();
  const selectedNetworkAsset =
    selectedGroupKey === undefined ? undefined : options.selectedSwapNetworks[selectedGroupKey];
  const selectedNetworkOption =
    selectedGroup === undefined || selectedNetworkAsset === undefined
      ? undefined
      : selectedGroup.options.find((option) => option.pay_in_asset === selectedNetworkAsset);
  const continueTarget =
    selectedNetworkOption !== undefined
      ? {
          payInAsset: selectedNetworkOption.pay_in_asset,
          disabled: selectedNetworkOption.available === false,
          limitMessage: swapOptionLimitMessage(selectedNetworkOption, options.checkout),
        }
      : null;
  const startingAsset = options.startingAsset;
  const gridBusy = startingAsset !== null;
  const continueStarting = continueTarget !== null && continueTarget.payInAsset === startingAsset;
  const canContinue =
    continueTarget !== null &&
    !continueTarget.disabled &&
    selectedNetworkOption !== undefined &&
    !gridBusy;

  const continueButton = (className: string) =>
    React.createElement(
      "button",
      {
        type: "button",
        className,
        disabled: !canContinue,
        "aria-disabled": canContinue ? undefined : "true",
        "aria-busy": continueStarting ? "true" : undefined,
        onClick: !canContinue
          ? undefined
          : () => {
              if (continueTarget === null) return;
              options.onContinueSwap(continueTarget.payInAsset);
            },
      },
      continueStarting
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement("span", {
              className: orClasses.continueSpinner,
              "aria-hidden": "true",
            }),
            checkoutLabels.preparingPayment,
          )
        : continueTarget?.disabled && continueTarget.limitMessage !== undefined
          ? continueTarget.limitMessage
          : checkoutLabels.continue,
    );

  const renderNetworkSelector = (group: typeof selectedGroup & object, mobile: boolean) => {
    const accent = paymentAccentId(group.label);
    const groupKey = group.label.trim().toUpperCase();
    const selectedAsset = options.selectedSwapNetworks[groupKey];
    const selectedOption =
      selectedAsset === undefined
        ? undefined
        : group.options.find((option) => option.pay_in_asset === selectedAsset);
    const panelId = `network-panel-${groupKey.toLowerCase()}`;
    return React.createElement(
      "div",
      {
        id: panelId,
        role: "group",
        "aria-labelledby": `network-heading-${groupKey.toLowerCase()}`,
        className: mobile ? networkMobileRevealClasses(accent) : orClasses.methodNetworkReveal,
      },
      React.createElement(
        "div",
        { className: orClasses.methodNetworkLayout },
        React.createElement(
          "div",
          null,
          React.createElement(
            "h3",
            {
              id: `network-heading-${groupKey.toLowerCase()}`,
              className: orClasses.methodNetworkHeading,
            },
            formatChooseNetworkHeading(group.label),
          ),
          React.createElement(
            "p",
            { className: orClasses.methodNetworkHint },
            checkoutLabels.selectNetworkToContinue,
          ),
        ),
        React.createElement(
          "div",
          {
            role: "group",
            "aria-labelledby": `network-heading-${groupKey.toLowerCase()}`,
            className: orClasses.methodNetworkGrid,
          },
          group.options.map((option) => {
            const optionDisabled = option.available === false;
            const optionSelected = option.pay_in_asset === selectedOption?.pay_in_asset;
            const optionLimit = swapOptionLimitMessage(option, options.checkout);
            return React.createElement(
              "div",
              { key: option.pay_in_asset, className: orClasses.methodTile },
              React.createElement(
                "button",
                {
                  type: "button",
                  "aria-pressed": optionSelected,
                  disabled: optionDisabled,
                  "aria-disabled": optionDisabled ? "true" : undefined,
                  className: networkButtonClasses({
                    accent,
                    selected: optionSelected,
                    disabled: optionDisabled,
                  }),
                  onClick: optionDisabled
                    ? undefined
                    : () => options.onSelectNetwork(groupKey, option.pay_in_asset),
                },
                React.createElement(
                  "span",
                  { "aria-hidden": "true", className: "grid size-6 shrink-0 place-items-center" },
                  React.createElement("img", {
                    alt: "",
                    className: orClasses.methodNetworkIcon,
                    src: getNetworkIcon(option.network_label),
                  }),
                ),
                React.createElement("span", { className: "truncate" }, option.network_label),
                optionSelected
                  ? React.createElement(
                      "span",
                      {
                        "aria-hidden": "true",
                        className: networkCheckClasses(accent),
                      },
                      "✓",
                    )
                  : null,
              ),
              optionDisabled && optionLimit !== undefined
                ? React.createElement("span", { className: orClasses.methodLimitHint }, optionLimit)
                : null,
            );
          }),
        ),
        continueButton(orClasses.methodConfirmDesktop),
      ),
      selectedOption !== undefined
        ? React.createElement(
            "p",
            {
              "aria-live": "polite",
              className: orClasses.methodNetworkSummary,
            },
            React.createElement(
              "span",
              {
                "aria-hidden": "true",
                className: networkSummaryIconClasses(accent),
              },
              "✓",
            ),
            formatNetworkSummary(group.label, selectedOption.network_label),
          )
        : null,
    );
  };

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "header",
      {
        className: orClasses.wizardHeader,
      },
      React.createElement(
        "h2",
        {
          id: "payment-method-heading",
          className: orClasses.wizardHeaderTitle,
        },
        checkoutLabels.wizardTitle,
      ),
      React.createElement(
        "p",
        { className: orClasses.wizardHeaderSubtitle },
        checkoutLabels.wizardSubtitle,
      ),
    ),
    React.createElement(
      "div",
      {
        className: orClasses.wizardBody,
        "aria-labelledby": "payment-method-heading",
      },
      React.createElement(
        "div",
        {
          role: "group",
          "aria-label": checkoutLabels.paymentMethod,
          className: orClasses.methodGrid,
        },
        ...entries.map((entry) => {
          if (entry.kind === "method") {
            const method = entry.method;
            const accent = paymentAccentId(method.id);
            return React.createElement(
              "button",
              {
                key: method.id,
                type: "button",
                className: assetButtonClasses({
                  accent,
                  selected: false,
                  disabled: gridBusy,
                }),
                disabled: gridBusy,
                "aria-disabled": gridBusy ? "true" : undefined,
                onClick: gridBusy ? undefined : () => options.onContinueMethod(method.id),
              },
              React.createElement(
                "span",
                { "aria-hidden": "true", className: orClasses.methodIconWrap },
                React.createElement("img", {
                  alt: "",
                  className: orClasses.methodIcon,
                  src: getPaymentMethodIcon(method.id),
                }),
              ),
              React.createElement(
                "span",
                { className: orClasses.methodTitleWrap },
                React.createElement("span", { className: orClasses.methodTitle }, method.title),
              ),
            );
          }

          const group = entry.group;
          const groupKey = group.label.trim().toUpperCase();
          const pickerKey = swapPickerKey(group.label);
          const selected = selectedKey === pickerKey;
          const multiNetwork = group.options.length > 1;
          const displayOption =
            group.options.find((option) => option.available !== false) ?? group.options[0];
          if (displayOption === undefined) return null;
          const selectedAsset = options.selectedSwapNetworks[groupKey];
          const selectedOption =
            selectedAsset === undefined
              ? undefined
              : group.options.find((option) => option.pay_in_asset === selectedAsset);
          const activeOption = selectedOption ?? displayOption;
          const starting = group.options.some((option) => option.pay_in_asset === startingAsset);
          const disabled = group.options.every((option) => option.available === false);
          const accent = paymentAccentId(group.label);
          const limitOption = disabled
            ? (swapGroupLimitOption(group.options) ?? activeOption)
            : activeOption;
          const limitMessage = swapOptionLimitMessage(limitOption, options.checkout);
          const panelId = `network-panel-${groupKey.toLowerCase()}`;

          return React.createElement(
            "div",
            { key: pickerKey, className: orClasses.methodTile },
            React.createElement(
              "button",
              {
                type: "button",
                "aria-pressed": starting || (multiNetwork && selected),
                "aria-expanded": multiNetwork ? selected : undefined,
                "aria-controls": multiNetwork ? panelId : undefined,
                "aria-busy": starting ? "true" : undefined,
                disabled: disabled || gridBusy,
                "aria-disabled": disabled || gridBusy ? "true" : undefined,
                className: assetButtonClasses({
                  accent,
                  selected: starting || (multiNetwork && selected),
                  disabled: disabled || (gridBusy && !starting),
                }),
                onClick:
                  disabled || gridBusy
                    ? undefined
                    : multiNetwork
                      ? () => options.onSelectPicker(pickerKey, selectedKey)
                      : () => options.onContinueSwap(displayOption.pay_in_asset),
              },
              React.createElement(
                "span",
                { "aria-hidden": "true", className: orClasses.methodIconWrap },
                starting
                  ? React.createElement("span", {
                      className: orClasses.spinner,
                      "aria-hidden": "true",
                    })
                  : React.createElement("img", {
                      alt: "",
                      className: orClasses.methodIcon,
                      src: getSwapOptionIcon(displayOption),
                    }),
              ),
              React.createElement(
                "span",
                { className: orClasses.methodTitleWrap },
                React.createElement("span", { className: orClasses.methodTitle }, group.label),
                !disabled && multiNetwork
                  ? React.createElement(
                      "span",
                      { className: orClasses.methodDetailMobile },
                      selected && selectedOption !== undefined
                        ? `${selectedOption.network_label} network`
                        : checkoutLabels.selectNetwork,
                    )
                  : null,
              ),
            ),
            disabled && limitMessage !== undefined
              ? React.createElement("span", { className: orClasses.methodLimitHint }, limitMessage)
              : null,
            multiNetwork
              ? React.createElement(
                  "div",
                  {
                    className: joinClassNames(
                      orClasses.methodNetworkRevealAnim,
                      selected
                        ? orClasses.methodNetworkRevealAnimOpen
                        : orClasses.methodNetworkRevealAnimClosed,
                    ),
                  },
                  React.createElement(
                    "div",
                    { className: orClasses.methodNetworkRevealInner },
                    selected ? renderNetworkSelector(group, true) : null,
                  ),
                )
              : null,
          );
        }),
        currenciesLoading
          ? React.createElement(
              "div",
              {
                key: "currencies-loading",
                role: "status",
                "aria-live": "polite",
                className: orClasses.methodCurrenciesLoading,
              },
              React.createElement("span", {
                className: orClasses.spinner,
                "aria-hidden": "true",
              }),
              React.createElement(
                "span",
                { className: orClasses.methodTitle },
                checkoutLabels.loadingCurrencies,
              ),
            )
          : null,
      ),
      networkRequired && selectedGroup !== undefined
        ? React.createElement(
            "div",
            { className: orClasses.methodNetworkRevealDesktop },
            renderNetworkSelector(selectedGroup, false),
          )
        : null,
    ),
  );
}

function renderWizardBackBreadcrumb(currentLabel: string, onBack: () => void): React.ReactElement {
  return React.createElement(
    "div",
    {
      className: orClasses.breadcrumbs,
    },
    React.createElement(
      "ul",
      null,
      React.createElement(
        "li",
        null,
        React.createElement(
          "button",
          {
            className: "link link-hover",
            onClick: onBack,
            type: "button",
          },
          checkoutLabels.switchPaymentMethod,
        ),
      ),
      React.createElement(
        "li",
        null,
        React.createElement("span", { className: orClasses.breadcrumbCurrent }, currentLabel),
      ),
    ),
  );
}

function renderWizardBreadcrumbs(options: {
  readonly method: PaymentMethod;
  readonly selectedRoute: string | null;
  readonly routeAssets: readonly WizardRouteAssetDisplay[];
  readonly onChangeMethod: () => void;
  readonly onChangeRoute: () => void;
}): React.ReactElement {
  const method = paymentMethods.find((candidate) => candidate.id === options.method);
  const methodLabel = method?.title ?? checkoutLabels.paymentMethod;
  const routeLabel =
    options.selectedRoute === null || options.routeAssets.length <= 1
      ? null
      : (options.routeAssets.find((asset) => asset.id === options.selectedRoute)?.label ??
        options.selectedRoute);

  return React.createElement(
    "nav",
    {
      "aria-label": "Payment path",
      className: orClasses.breadcrumbs,
    },
    React.createElement(
      "ul",
      null,
      React.createElement(
        "li",
        null,
        React.createElement(
          "button",
          {
            className: "link link-hover",
            onClick: options.onChangeMethod,
            type: "button",
          },
          checkoutLabels.switchPaymentMethod,
        ),
      ),
      routeLabel === null
        ? React.createElement(
            "li",
            null,
            React.createElement("span", { className: orClasses.breadcrumbCurrent }, methodLabel),
          )
        : React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "li",
              null,
              React.createElement(
                "button",
                {
                  className: "link link-hover",
                  onClick: options.onChangeRoute,
                  type: "button",
                },
                methodLabel,
              ),
            ),
            React.createElement(
              "li",
              null,
              React.createElement("span", { className: orClasses.breadcrumbCurrent }, routeLabel),
            ),
          ),
    ),
  );
}

function swapOptionsForRoute(
  routeKey: string,
  options: readonly SwapOptionDisplay[],
): readonly SwapOptionDisplay[] {
  return options.filter((option) => swapAssetMatchesRoute(routeKey, option.pay_in_asset));
}

// The pay-in asset to auto-advance to a deposit address, or undefined when the payer
// should still choose (multi-network stablecoins, no swap configured).
function normalizeSwapQuote(body: unknown): SwapOptionDisplay | undefined {
  const quote = recordOrEmpty(recordOrEmpty(body).quote ?? body);
  const payInAsset = quote.pay_in_asset ?? quote.pay_asset;
  return typeof payInAsset === "string"
    ? ({ ...quote, pay_in_asset: payInAsset } as unknown as SwapOptionDisplay)
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
  const matched =
    checkout?.invoices.find((invoice) => invoice.invoice_id === local.invoice_id) ?? local;
  return overlaySwapRefundStaging(matched, local);
}

function renderRoutePicker(options: {
  readonly assets: readonly WizardRouteAssetDisplay[];
  readonly method: "bitcoin";
  readonly onSelectRoute: (route: string) => void;
}): React.ReactElement {
  return React.createElement(
    "div",
    {
      className: orClasses.routePicker,
      "data-method": options.method,
    },
    options.assets.map((asset) => {
      return React.createElement(
        "button",
        {
          className: asset.selected ? orClasses.routeButtonSelected : orClasses.routeButton,
          key: asset.id,
          onClick: () => options.onSelectRoute(asset.id),
          type: "button",
        },
        React.createElement("img", {
          alt: "",
          className: orClasses.methodIcon,
          src: asset.icon,
        }),
        React.createElement("span", { className: orClasses.methodTitle }, asset.label),
        React.createElement("small", { className: orClasses.methodDetail }, asset.subtitle),
      );
    }),
  );
}
