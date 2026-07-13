import * as React from "react";
import {
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
  createCheckoutProviderCopyEvent,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceivePaymentWizardController,
  createOpenReceivePaymentWizardModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  copyInvoice as copyInvoiceHelper,
  getOpenReceiveDefaultCountryCode,
  getOpenReceiveNetworkIcon,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveWizardEmptyMessage,
  buildOpenReceiveMethodGridEntries,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  openReceiveAssetButtonClasses,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
  openReceivePaymentAccentId,
  openReceiveSwapPickerKey,
  parseOpenReceiveSwapPickerKey,
  resolveOpenReceivePreservedNetworkSelection,
  normalizeSwapStartInvoice,
  openReceiveCheckoutLabels,
  openReceivePaymentMethods,
  openReceiveSwapAssetMatchesRoute,
  orClasses,
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
  // For multi-network coins (USDT), remember which network the payer picked before
  // confirming the method tile.
  const [selectedSwapNetworks, setSelectedSwapNetworks] = React.useState<Record<string, string>>(
    {},
  );
  // Compact selector: which asset tile is currently selected (method:… or swap:…).
  const [selectedPickerKey, setSelectedPickerKey] = React.useState<string | null>(null);
  const autoSwapAttemptedRef = React.useRef<Set<string>>(new Set());
  // Leave the focused swap flow and restore the default method grid (nothing selected).
  const clearSwapFocus = React.useCallback(() => {
    setSelectedSwapAsset(null);
    setSelectedPickerKey(null);
    setSelectedSwapNetworks({});
  }, []);
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
        }, { logger: props.logger });
        const invoice = normalizeSwapStartInvoice(body);
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      } finally {
        setSwapStartingAsset(null);
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError, props.logger],
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
        }, { logger: props.logger });
        const invoice = normalizeSwapStartInvoice(body);
        setStartedSwapInvoice(invoice);
        setDismissedSwapInvoiceId(null);
      } catch (error) {
        props.onError?.(error);
      }
    },
    [props.orderUrl, orderId, fetcher, props.onError, props.logger],
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
  // Diagnostic only: intentionally keyed on swapOptionsSignature so availability
  // changes log once. checkout fields are snapshot context, not effect triggers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature is the intentional dep
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
          activeSwapForAsset !== undefined
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
          selectedSwapNetworks,
          onSelectPicker: (key, previousKey) => {
            setSelectedPickerKey(key);
            const nextSwap = parseOpenReceiveSwapPickerKey(key);
            if (nextSwap === null) return;
            const entries = buildOpenReceiveMethodGridEntries(
              openReceivePaymentMethods,
              swapAssetOptions,
            );
            const nextEntry = entries.find(
              (entry) =>
                entry.kind === "swap" &&
                entry.group.label.trim().toUpperCase() === nextSwap.label,
            );
            if (nextEntry === undefined || nextEntry.kind !== "swap") return;
            if (nextEntry.group.options.length <= 1) return;
            const previousGroup =
              previousKey === null
                ? undefined
                : (() => {
                    const previousSwap = parseOpenReceiveSwapPickerKey(previousKey);
                    if (previousSwap === null) return undefined;
                    const previousEntry = entries.find(
                      (entry) =>
                        entry.kind === "swap" &&
                        entry.group.label.trim().toUpperCase() === previousSwap.label,
                    );
                    return previousEntry?.kind === "swap" ? previousEntry.group : undefined;
                  })();
            const preserved = resolveOpenReceivePreservedNetworkSelection({
              previousGroup,
              nextGroup: nextEntry.group,
              selectedNetworks: selectedSwapNetworks,
            });
            setSelectedSwapNetworks((current) => {
              const groupKey = nextEntry.group.label.trim().toUpperCase();
              if (preserved === undefined) {
                const { [groupKey]: _removed, ...rest } = current;
                return rest;
              }
              return { ...current, [groupKey]: preserved };
            });
          },
          onSelectNetwork: (groupKey, payInAsset) => {
            setSelectedSwapNetworks((current) => ({
              ...current,
              [groupKey]: payInAsset,
            }));
          },
          onContinueMethod: (methodId) => {
            updateWizardSelection((controller) =>
              controller.selectMethod(methodId as OpenReceivePaymentMethod),
            );
          },
          onContinueSwap: (payInAsset) => {
            autoSwapAttemptedRef.current.delete(payInAsset);
            setSelectedSwapAsset(payInAsset);
          },
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
          showRoutePicker && selection.selectedMethod === "crypto"
            ? renderRoutePicker({
                assets: routeAssetDisplays,
                method: "crypto",
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
                  getOpenReceiveWizardEmptyMessage(selection.selectedMethod),
                )
              : routeDisplays.map((route) => {
                  const routeSwapOptions = swapOptionsForRoute(route.key, swapOptions.options);
                  const activeSwapForRoute =
                    currentSwapInvoice !== undefined &&
                    openReceiveSwapAssetMatchesRoute(
                      route.key,
                      currentSwapInvoice.swap?.pay_in_asset,
                    )
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
                          checkout,
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
                            className: orClasses.providerGrid,
                          },
                          route.providers.map((provider) =>
                            React.createElement(
                              "article",
                              {
                                className: provider.recommended
                                  ? orClasses.providerCardRecommended
                                  : orClasses.providerCard,
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
                                provider.recommendedLabel === null
                                  ? null
                                  : React.createElement(
                                      "span",
                                      { className: orClasses.providerBadge },
                                      provider.recommendedLabel,
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
      : renderProviderTutorialModal({
          provider: activeTutorialProvider,
          index: activeTutorial.index,
          copied: activeTutorial.copied,
          invoice: props.invoice,
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

function renderCompactPaymentMethodSelector(options: {
  readonly swapAssetOptions: readonly OpenReceiveSwapOptionDisplay[];
  readonly currenciesLoading?: boolean;
  readonly checkout: CheckoutSnapshot | undefined;
  readonly selectedPickerKey: string | null;
  readonly selectedSwapNetworks: Readonly<Record<string, string>>;
  readonly onSelectPicker: (key: string, previousKey: string | null) => void;
  readonly onSelectNetwork: (groupKey: string, payInAsset: string) => void;
  readonly onContinueMethod: (methodId: string) => void;
  readonly onContinueSwap: (payInAsset: string) => void;
}): React.ReactElement {
  const entries = buildOpenReceiveMethodGridEntries(
    openReceivePaymentMethods,
    options.swapAssetOptions,
  );
  const currenciesLoading =
    options.currenciesLoading === true && options.swapAssetOptions.length === 0;
  const selectedKey = options.selectedPickerKey;
  const selectedSwap = selectedKey === null ? null : parseOpenReceiveSwapPickerKey(selectedKey);
  const selectedSwapEntry =
    selectedSwap === null
      ? undefined
      : entries.find(
          (entry) =>
            entry.kind === "swap" &&
            entry.group.label.trim().toUpperCase() === selectedSwap.label,
        );
  const selectedGroup =
    selectedSwapEntry?.kind === "swap" ? selectedSwapEntry.group : undefined;
  const networkRequired =
    selectedGroup !== undefined && selectedGroup.options.length > 1;
  const selectedGroupKey = selectedGroup?.label.trim().toUpperCase();
  const selectedNetworkAsset =
    selectedGroupKey === undefined
      ? undefined
      : options.selectedSwapNetworks[selectedGroupKey];
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
  const canContinue =
    continueTarget !== null &&
    !continueTarget.disabled &&
    selectedNetworkOption !== undefined;

  const continueButton = (className: string) =>
    React.createElement(
      "button",
      {
        type: "button",
        className,
        disabled: !canContinue,
        "aria-disabled": canContinue ? undefined : "true",
        onClick: !canContinue
          ? undefined
          : () => {
              if (continueTarget === null) return;
              options.onContinueSwap(continueTarget.payInAsset);
            },
      },
      continueTarget !== null &&
        continueTarget.disabled &&
        continueTarget.limitMessage !== undefined
        ? continueTarget.limitMessage
        : openReceiveCheckoutLabels.continue,
    );

  const renderNetworkSelector = (group: (typeof selectedGroup & object), mobile: boolean) => {
    const accent = openReceivePaymentAccentId(group.label);
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
        className: mobile
          ? openReceiveNetworkMobileRevealClasses(accent)
          : orClasses.methodNetworkReveal,
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
            formatOpenReceiveChooseNetworkHeading(group.label),
          ),
          React.createElement(
            "p",
            { className: orClasses.methodNetworkHint },
            openReceiveCheckoutLabels.selectNetworkToContinue,
          ),
        ),
        React.createElement(
          "div",
          {
            role: "radiogroup",
            "aria-labelledby": `network-heading-${groupKey.toLowerCase()}`,
            className: orClasses.methodNetworkGrid,
          },
          group.options.map((option) => {
            const optionDisabled = option.available === false;
            const optionSelected = option.pay_in_asset === selectedOption?.pay_in_asset;
            const optionLimit = swapOptionLimitMessage(option, options.checkout);
            return React.createElement(
              "button",
              {
                key: option.pay_in_asset,
                type: "button",
                role: "radio",
                "aria-checked": optionSelected,
                disabled: optionDisabled,
                className: openReceiveNetworkButtonClasses({
                  accent,
                  selected: optionSelected,
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
                  src: getOpenReceiveNetworkIcon(option.network_label),
                }),
              ),
              React.createElement(
                "span",
                { className: "truncate" },
                optionDisabled && optionLimit !== undefined
                  ? `${option.network_label} · ${optionLimit}`
                  : option.network_label,
              ),
              optionSelected
                ? React.createElement(
                    "span",
                    {
                      "aria-hidden": "true",
                      className: openReceiveNetworkCheckClasses(accent),
                    },
                    "✓",
                  )
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
                className: openReceiveNetworkSummaryIconClasses(accent),
              },
              "✓",
            ),
            formatOpenReceiveNetworkSummary(group.label, selectedOption.network_label),
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
        openReceiveCheckoutLabels.wizardTitle,
      ),
      React.createElement(
        "p",
        { className: orClasses.wizardHeaderSubtitle },
        openReceiveCheckoutLabels.wizardSubtitle,
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
          role: "radiogroup",
          "aria-label": openReceiveCheckoutLabels.paymentMethod,
          className: orClasses.methodGrid,
        },
        ...entries.map((entry) => {
          if (entry.kind === "method") {
            const method = entry.method;
            const accent = openReceivePaymentAccentId(method.id);
            return React.createElement(
              "button",
              {
                key: method.id,
                type: "button",
                role: "radio",
                "aria-checked": false,
                className: openReceiveAssetButtonClasses({ accent, selected: false }),
                onClick: () => options.onContinueMethod(method.id),
              },
              React.createElement(
                "span",
                { "aria-hidden": "true", className: orClasses.methodIconWrap },
                React.createElement("img", {
                  alt: "",
                  className: orClasses.methodIcon,
                  src: getOpenReceivePaymentMethodIcon(method.id),
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
          const pickerKey = openReceiveSwapPickerKey(group.label);
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
          const disabled = !multiNetwork && activeOption.available === false;
          const accent = openReceivePaymentAccentId(group.label);
          const limitMessage = swapOptionLimitMessage(activeOption, options.checkout);
          const panelId = `network-panel-${groupKey.toLowerCase()}`;

          return React.createElement(
            "div",
            { key: pickerKey, className: orClasses.methodTile },
            React.createElement(
              "button",
              {
                type: "button",
                role: "radio",
                "aria-checked": multiNetwork ? selected : false,
                "aria-expanded": multiNetwork ? selected : undefined,
                "aria-controls": multiNetwork ? panelId : undefined,
                disabled,
                "aria-disabled": disabled ? "true" : undefined,
                className: openReceiveAssetButtonClasses({
                  accent,
                  selected: multiNetwork && selected,
                  disabled,
                }),
                onClick: disabled
                  ? undefined
                  : multiNetwork
                    ? () => options.onSelectPicker(pickerKey, selectedKey)
                    : () => options.onContinueSwap(displayOption.pay_in_asset),
              },
              React.createElement(
                "span",
                { "aria-hidden": "true", className: orClasses.methodIconWrap },
                React.createElement("img", {
                  alt: "",
                  className: orClasses.methodIcon,
                  src: getOpenReceiveSwapOptionIcon(displayOption),
                }),
              ),
              React.createElement(
                "span",
                { className: orClasses.methodTitleWrap },
                React.createElement("span", { className: orClasses.methodTitle }, group.label),
                multiNetwork
                  ? React.createElement(
                      "span",
                      { className: orClasses.methodDetailMobile },
                      selected && selectedOption !== undefined
                        ? `${selectedOption.network_label} network`
                        : disabled && limitMessage !== undefined
                          ? limitMessage
                          : openReceiveCheckoutLabels.selectNetwork,
                    )
                  : disabled && limitMessage !== undefined
                    ? React.createElement(
                        "span",
                        { className: orClasses.methodDetailMobile },
                        limitMessage,
                      )
                    : null,
              ),
            ),
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
                openReceiveCheckoutLabels.loadingCurrencies,
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
          openReceiveCheckoutLabels.paymentMethod,
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
          openReceiveCheckoutLabels.paymentMethod,
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
  options: readonly OpenReceiveSwapOptionDisplay[],
): readonly OpenReceiveSwapOptionDisplay[] {
  return options.filter((option) =>
    openReceiveSwapAssetMatchesRoute(routeKey, option.pay_in_asset),
  );
}

// The pay-in asset to auto-advance to a deposit address, or undefined when the payer
// should still choose (multi-network stablecoins, no swap configured).
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
        className: orClasses.providerOpen,
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
      className: orClasses.providerOpen,
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
  readonly invoice: string;
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
  const decodeHref = createOpenReceiveLightningInvoiceDecodeUrl(options.invoice);

  return React.createElement(
    "div",
    {
      "aria-label": `${openReceiveCheckoutLabels.tutorialTitlePrefix} ${provider.name}`,
      "aria-modal": true,
      className: orClasses.tutorialModal,
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
        className: orClasses.tutorialBox,
      },
      React.createElement(
        "div",
        {
          className: orClasses.tutorialHeader,
        },
        React.createElement(
          "div",
          {
            className: orClasses.tutorialTitle,
          },
          React.createElement("img", {
            alt: "",
            className: orClasses.tutorialHeaderLogo,
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
            className: orClasses.tutorialClose,
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
              className: orClasses.tutorialIntro,
            },
            React.createElement("img", {
              alt: "",
              className: orClasses.tutorialProviderLogo,
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
                className: orClasses.tutorialCopy,
                onClick: () => void options.onCopy(),
                type: "button",
              },
              openReceiveCheckoutLabels.copyInvoice,
            ),
            decodeHref === undefined
              ? null
              : React.createElement(
                  "a",
                  {
                    className: orClasses.tutorialCopy,
                    href: decodeHref,
                    rel: "noreferrer",
                    target: "_blank",
                  },
                  openReceiveCheckoutLabels.decodeInvoice,
                ),
            options.copied
              ? React.createElement(
                  "p",
                  {
                    className: orClasses.tutorialCopyMessage,
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
                className: orClasses.tutorialFrame,
              },
              React.createElement("img", {
                alt: tutorial?.caption ?? "",
                className: orClasses.tutorialImage,
                src: tutorial?.image ?? "",
              }),
            ),
            React.createElement(
              "p",
              {
                className: orClasses.tutorialCaption,
              },
              tutorial?.caption ?? "",
            ),
          ),
      React.createElement(
        "div",
        {
          "aria-hidden": "true",
          className: orClasses.tutorialSteps,
        },
        Array.from({ length: totalSteps }, (_, index) =>
          React.createElement("span", {
            className:
              index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep,
            key: index,
          }),
        ),
      ),
      React.createElement(
        "p",
        {
          className: orClasses.tutorialProgress,
        },
        `Step ${stepIndex + 1} of ${totalSteps}`,
      ),
      React.createElement(
        "div",
        {
          className: orClasses.tutorialControls,
        },
        React.createElement(
          "button",
          {
            className: orClasses.btn,
            disabled: stepIndex === 0,
            onClick: () => options.onStep(previousIndex),
            type: "button",
          },
          "Back",
        ),
        React.createElement(
          "button",
          {
            className: orClasses.btn,
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
      className: orClasses.countrySelect,
    },
    React.createElement(
      "span",
      { className: orClasses.countrySelectLabel },
      openReceiveCheckoutLabels.chooseCountry,
    ),
    React.createElement(
      "select",
      {
        className: orClasses.countrySelectControl,
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
