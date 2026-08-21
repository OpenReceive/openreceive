import {
  buildOpenReceiveMethodGridEntries,
  type CheckoutInvoiceSnapshot,
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceivePaymentWizardModel,
  createOpenReceiveSwapDisplayModel,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  escapeOpenReceiveHtml as escapeHtml,
  findOpenReceiveSwapGridGroup,
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
  getOpenReceiveNetworkIcon,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveWizardEmptyMessage,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  type OpenReceivePaymentMethod,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveSwapDisplayModel,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardRouteDisplay,
  openReceiveAssetButtonClasses,
  openReceiveCheckoutLabels,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
  openReceivePaymentAccentId,
  openReceivePaymentMethods,
  openReceiveSwapAssetMatchesRoute,
  openReceiveSwapGroupLimitOption,
  openReceiveSwapOptionLimitMessage,
  openReceiveSwapPickerKey,
  orClasses,
} from "@openreceive/browser/internal";

import { renderElementSwapCopyDetailHtml } from "./dom-helpers.ts";

import { renderTransactionDetailsHtml } from "./transaction-details.ts";

import type { OpenReceiveElementsSwapOption, OpenReceiveElementsWizardView } from "./views.ts";

function wizardStartingAsset(view: OpenReceiveElementsWizardView): string | undefined {
  const asset = view.startingSwapAsset;
  return asset !== undefined && asset !== null && asset.length > 0 ? asset : undefined;
}

function swapGroupIsStarting(
  group: { readonly options: readonly Pick<OpenReceiveElementsSwapOption, "pay_in_asset">[] },
  startingAsset: string | undefined,
): boolean {
  return (
    startingAsset !== undefined &&
    group.options.some((option) => option.pay_in_asset === startingAsset)
  );
}

export function renderOpenReceivePaymentWizardHtml(
  view: OpenReceiveElementsWizardView = {},
): string {
  const selection: OpenReceivePaymentWizardSelection = {
    selectedMethod: view.selectedMethod ?? null,
    selectedBitcoinRoute: view.selectedBitcoinRoute ?? null,
  };
  const model = createOpenReceivePaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute,
  });
  const routeDisplays = createOpenReceiveWizardRouteDisplays(wizard.routes);
  const showRoutePicker =
    routeAssetDisplays.length > 0 && (model.selectedRoute === null || routeDisplays.length === 0);
  const breadcrumbs =
    selection.selectedMethod === null
      ? ""
      : renderWizardBreadcrumbsHtml({
          method: selection.selectedMethod,
          selectedRoute: model.selectedRoute,
          routeAssets: routeAssetDisplays,
        });
  const swapAssetOptions = (view.swapOptions ?? []).filter((option) => option.provider.length > 0);
  const selectedSwapAsset = view.selectedSwapAsset ?? null;
  const selectedSwapOption =
    selectedSwapAsset === null
      ? undefined
      : swapAssetOptions.find((option) => option.pay_in_asset === selectedSwapAsset);
  if (selectedSwapAsset !== null) {
    const label =
      selectedSwapOption === undefined
        ? "this coin"
        : `${selectedSwapOption.label} · ${selectedSwapOption.network_label}`;
    const activeSwap =
      view.swapInvoice !== undefined && view.swapInvoice.swap?.pay_in_asset === selectedSwapAsset
        ? view.swapInvoice
        : undefined;
    return `
      <section part="wizard" class="${orClasses.wizard}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}>
        <div class="${orClasses.wizardBody}">
        <div part="wizard-breadcrumbs" class="${orClasses.breadcrumbs}">
          <button
            part="wizard-breadcrumb"
            class="${orClasses.btnGhost}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="swap-asset"
            type="button"
          >${escapeHtml(openReceiveCheckoutLabels.switchPaymentMethod)}</button>
          <span aria-hidden="true">/</span>
          <span part="wizard-breadcrumb-current" class="${orClasses.breadcrumbCurrent}">${escapeHtml(label)}</span>
        </div>
        <div part="wizard-results" class="${orClasses.wizardResults}">
          ${
            activeSwap !== undefined
              ? renderElementSwapPanelHtml(activeSwap, view)
              : view.swapStartError !== undefined
                ? `<section part="swap-panel" class="${orClasses.swapPanel}">
                    <div part="swap-error" role="alert" class="${orClasses.paymentStatus}">
                      <div class="${orClasses.paymentStatusBody}">
                        <strong class="${orClasses.paymentStatusTitle}">Could not prepare the payment address</strong>
                        <p class="${orClasses.paymentStatusDetail}">${escapeHtml(view.swapStartError)}</p>
                        <button
                          part="swap-retry"
                          class="${orClasses.btn}"
                          type="button"
                          ${selectedSwapAsset === null || selectedSwapAsset === undefined ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(selectedSwapAsset)}"`}
                        >Try again</button>
                      </div>
                    </div>
                  </section>`
                : `<section part="swap-panel" class="${orClasses.swapPanel}">
                    <div part="status" class="${orClasses.paymentStatus}">
                      <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
                      <div class="${orClasses.paymentStatusBody}">
                        <strong class="${orClasses.paymentStatusTitle}">Preparing payment address</strong>
                        <p class="${orClasses.paymentStatusDetail}">Getting your ${escapeHtml(
                          selectedSwapOption?.label ?? "coin",
                        )} payment address…</p>
                      </div>
                    </div>
                  </section>`
          }
        </div>
        </div>
      </section>
    `;
  }
  const methodPicker =
    selection.selectedMethod === null
      ? renderElementCompactPaymentSelectorHtml(swapAssetOptions, view)
      : "";

  return `
    <section part="wizard" class="${orClasses.wizard}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}>
      ${
        view.wizardError === undefined
          ? ""
          : `<p part="wizard-error" role="alert" class="${orClasses.paymentStatusDetail}">${escapeHtml(view.wizardError)}</p>`
      }
      ${methodPicker}
      ${
        selection.selectedMethod === null
          ? ""
          : `
      <div class="${orClasses.wizardBody}">
      ${breadcrumbs}
      ${
        showRoutePicker
          ? `
        <div part="route-picker" class="${orClasses.routePicker}">
          ${routeAssetDisplays
            .map(
              (asset) => `
              <button
                part="route${asset.selected ? " selected" : ""}"
                class="${asset.selected ? orClasses.routeButtonSelected : orClasses.routeButton}"
                ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.route}="${escapeHtml(asset.id)}"
                type="button"
              >
                <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(asset.icon)}">
                <strong class="${orClasses.methodTitle}">${escapeHtml(asset.label)}</strong>
                <small class="${orClasses.methodDetail}">${escapeHtml(asset.subtitle)}</small>
              </button>
            `,
            )
            .join("")}
        </div>
      `
          : ""
      }
      ${`
        <div part="wizard-results" class="${orClasses.wizardResults}">
          ${
            routeDisplays.length === 0
              ? `
            <p part="wizard-empty" class="${orClasses.wizardEmpty}">${escapeHtml(
              getOpenReceiveWizardEmptyMessage(),
            )}</p>
	          `
              : routeDisplays
                  .map((route) => {
                    const activeSwap =
                      view.swapInvoice !== undefined &&
                      openReceiveSwapAssetMatchesRoute(
                        route.key,
                        view.swapInvoice.swap?.pay_in_asset,
                      )
                        ? view.swapInvoice
                        : undefined;
                    return `
	            <section part="wizard-route" class="${orClasses.wizardRoute}">
                <h3 class="${orClasses.wizardRouteHeading}">
                  ${escapeHtml(route.title)}
                </h3>
              ${
                activeSwap === undefined
                  ? renderElementSwapActionsHtml(route.key, view.swapOptions ?? [], view)
                  : renderElementSwapPanelHtml(activeSwap, view)
              }
              ${
                activeSwap === undefined
                  ? `<div part="provider-grid" class="${orClasses.providerGrid}">
                ${route.providers
                  .map(
                    (provider) => `
                  <article part="provider" class="${orClasses.providerCard}">
                    <div part="provider-heading" class="${orClasses.providerHeading}">
                      <img class="${orClasses.providerIcon}" alt="" src="${escapeHtml(provider.icon)}">
                      <h4 class="${orClasses.providerName}">${escapeHtml(provider.name)}</h4>
	                    </div>
                    <p part="provider-kind" class="${orClasses.providerKind}">${escapeHtml(provider.kind)}</p>
	                    <div part="provider-actions" class="${orClasses.providerActions}">
                      ${renderProviderOpenActionHtml(provider)}
                    </div>
                  </article>
                `,
                  )
                  .join("")}
              </div>`
                  : ""
              }
            </section>
          `;
                  })
                  .join("")
          }
        </div>
      `}
      </div>
      `
      }
      ${renderTutorialModalHtml(
        routeDisplays,
        view.activeTutorialProviderId ?? null,
        view.activeTutorialIndex ?? 0,
        view.activeTutorialCopied ?? false,
        view.lightningInvoice,
        view.decodeLinkUrl,
      )}
    </section>
  `;
}

function renderElementSwapActionsHtml(
  routeKey: string,
  options: readonly OpenReceiveElementsSwapOption[],
  view: OpenReceiveElementsWizardView,
): string {
  // Out-of-range assets stay in the list but render as a disabled button with
  // the limit reason, instead of being hidden.
  const shown = options
    .filter((option) => option.provider.length > 0)
    .filter((option) => openReceiveSwapAssetMatchesRoute(routeKey, option.pay_in_asset));
  if (shown.length === 0) return "";

  return `
    <div part="swap-actions" class="${orClasses.swapActions}">
      ${shown
        .map((option) => {
          const disabled = option.available === false;
          const limitMessage = elementsSwapLimitMessage(option, view);
          const info = disabled
            ? limitMessage === undefined
              ? ""
              : `<p part="swap-warning" class="${orClasses.swapWarning}">${escapeHtml(limitMessage)}</p>`
            : option.pay_amount === undefined
              ? ""
              : `<p part="swap-estimate" class="${orClasses.swapEstimate}">Estimated ${escapeHtml(option.pay_amount)} ${escapeHtml(option.label)} to settle this checkout.</p>`;
          return `
        <div class="${orClasses.swapAction}">
        ${info}
        <button
          part="swap-start"
          class="${orClasses.swapStart}"
          ${disabled ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(option.pay_in_asset)}"`}
          ${disabled ? 'disabled aria-disabled="true"' : ""}
          type="button"
        >Create ${escapeHtml(option.label)} (${escapeHtml(option.network_label)}) payment address</button>
        </div>
      `;
        })
        .join("")}
    </div>
  `;
}

function renderElementCompactPaymentSelectorHtml(
  swapAssetOptions: readonly OpenReceiveElementsSwapOption[],
  view: OpenReceiveElementsWizardView,
): string {
  const entries = buildOpenReceiveMethodGridEntries(openReceivePaymentMethods, swapAssetOptions);
  const currenciesLoading = view.currenciesLoading === true && swapAssetOptions.length === 0;
  const selectedKey = view.selectedPickerKey ?? null;
  const selectedGroup = findOpenReceiveSwapGridGroup(entries, selectedKey);
  const networkRequired = selectedGroup !== undefined && selectedGroup.options.length > 1;
  const selectedNetworks = view.selectedSwapNetworks ?? {};
  const selectedGroupKey = selectedGroup?.label.trim().toUpperCase();
  const selectedNetworkAsset =
    selectedGroupKey === undefined ? undefined : selectedNetworks[selectedGroupKey];
  const selectedNetworkOption =
    selectedGroup === undefined || selectedNetworkAsset === undefined
      ? undefined
      : selectedGroup.options.find((option) => option.pay_in_asset === selectedNetworkAsset);

  const startingAsset = wizardStartingAsset(view);
  const gridBusy = startingAsset !== undefined;
  let continueDisabled = selectedNetworkOption === undefined || gridBusy;
  let continueAttr = "";
  let continueLabel = escapeHtml(openReceiveCheckoutLabels.continue);
  const continueStarting =
    selectedNetworkOption !== undefined && selectedNetworkOption.pay_in_asset === startingAsset;
  if (selectedNetworkOption !== undefined) {
    const disabled = selectedNetworkOption.available === false;
    const limitMessage = elementsSwapLimitMessage(selectedNetworkOption, view);
    continueDisabled = disabled || gridBusy;
    continueAttr =
      disabled || gridBusy
        ? ""
        : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(selectedNetworkOption.pay_in_asset)}"`;
    if (disabled && limitMessage !== undefined) continueLabel = escapeHtml(limitMessage);
    else if (continueStarting)
      continueLabel = escapeHtml(openReceiveCheckoutLabels.preparingPayment);
  } else if (networkRequired) {
    continueDisabled = true;
  }

  const continueButton = (className: string) =>
    renderElementMethodConfirmHtml({
      className,
      disabled: continueDisabled,
      starting: continueStarting,
      swapStartAsset:
        continueAttr.length === 0 || selectedNetworkOption === undefined
          ? undefined
          : selectedNetworkOption.pay_in_asset,
      label: continueLabel,
    });

  const tiles = entries
    .map((entry) => {
      if (entry.kind === "method") {
        const method = entry.method;
        const accent = openReceivePaymentAccentId(method.id);
        return `
          <button
            part="method"
            type="button"
            class="${openReceiveAssetButtonClasses({ accent, selected: false, disabled: gridBusy })}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="${escapeHtml(method.id)}"
            ${gridBusy ? 'disabled aria-disabled="true"' : ""}
          >
            <span aria-hidden="true" class="${orClasses.methodIconWrap}">
              <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getOpenReceivePaymentMethodIcon(method.id))}">
            </span>
            <span class="${orClasses.methodTitleWrap}">
              <span class="${orClasses.methodTitle}">${escapeHtml(method.title)}</span>
            </span>
          </button>`;
      }
      return renderElementSwapMethodGroupHtml(
        entry.group,
        view,
        selectedKey,
        selectedKey === openReceiveSwapPickerKey(entry.group.label)
          ? continueButton(orClasses.methodConfirmDesktop)
          : undefined,
      );
    })
    .join("");
  const loadingTile = currenciesLoading
    ? `<div part="currencies-loading" role="status" aria-live="polite" class="${orClasses.methodCurrenciesLoading}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <span class="${orClasses.methodTitle}">${escapeHtml(openReceiveCheckoutLabels.loadingCurrencies)}</span>
      </div>`
    : "";

  const desktopReveal =
    networkRequired && selectedGroup !== undefined
      ? `<div class="${orClasses.methodNetworkRevealDesktop}">${renderElementNetworkSelectorHtml(
          selectedGroup,
          view,
          continueButton(orClasses.methodConfirmDesktop),
          false,
        )}</div>`
      : "";

  return `
      <header class="${orClasses.wizardHeader}">
        <h2 id="payment-method-heading" class="${orClasses.wizardHeaderTitle}">${escapeHtml(openReceiveCheckoutLabels.wizardTitle)}</h2>
        <p class="${orClasses.wizardHeaderSubtitle}">${escapeHtml(openReceiveCheckoutLabels.wizardSubtitle)}</p>
      </header>
      <div class="${orClasses.wizardBody}" aria-labelledby="payment-method-heading">
        <div part="method-grid" role="group" aria-label="${escapeHtml(openReceiveCheckoutLabels.paymentMethod)}" class="${orClasses.methodGrid}">
          ${tiles}${loadingTile}
        </div>
        ${desktopReveal}
      </div>
    `;
}

function renderElementNetworkSelectorHtml(
  group: {
    readonly label: string;
    readonly options: readonly OpenReceiveElementsSwapOption[];
  },
  view: OpenReceiveElementsWizardView,
  continueButtonHtml: string,
  mobile: boolean,
): string {
  const accent = openReceivePaymentAccentId(group.label);
  const groupKey = group.label.trim().toUpperCase();
  const selectedNetworks = view.selectedSwapNetworks ?? {};
  const selectedAsset = selectedNetworks[groupKey];
  const selectedOption =
    selectedAsset === undefined
      ? undefined
      : group.options.find((option) => option.pay_in_asset === selectedAsset);
  const panelId = `network-panel-${groupKey.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
  const headingId = `network-heading-${groupKey.toLowerCase()}`;
  const networkButtons = group.options
    .map((option) => {
      const optionDisabled = option.available === false;
      const optionSelected = option.pay_in_asset === selectedOption?.pay_in_asset;
      const optionLimit = elementsSwapLimitMessage(option, view);
      return `
        <div class="${orClasses.methodTile}">
          <button
            type="button"
            aria-pressed="${optionSelected ? "true" : "false"}"
            class="${openReceiveNetworkButtonClasses({
              accent,
              selected: optionSelected,
              disabled: optionDisabled,
            })}"
            ${optionDisabled ? 'disabled aria-disabled="true"' : ""}
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork}="${escapeHtml(groupKey)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetworkValue}="${escapeHtml(option.pay_in_asset)}"
          >
            <span aria-hidden="true" class="grid size-6 shrink-0 place-items-center">
              <img class="${orClasses.methodNetworkIcon}" alt="" src="${escapeHtml(getOpenReceiveNetworkIcon(option.network_label))}">
            </span>
            <span class="truncate">${escapeHtml(option.network_label)}</span>
            ${
              optionSelected
                ? `<span aria-hidden="true" class="${openReceiveNetworkCheckClasses(accent)}">✓</span>`
                : ""
            }
          </button>
          ${
            optionDisabled && optionLimit !== undefined
              ? `<span class="${orClasses.methodLimitHint}">${escapeHtml(optionLimit)}</span>`
              : ""
          }
        </div>`;
    })
    .join("");

  const summary =
    selectedOption === undefined
      ? ""
      : `<p aria-live="polite" class="${orClasses.methodNetworkSummary}">
          <span aria-hidden="true" class="${openReceiveNetworkSummaryIconClasses(accent)}">✓</span>
          ${escapeHtml(formatOpenReceiveNetworkSummary(group.label, selectedOption.network_label))}
        </p>`;

  return `
    <div
      id="${panelId}"
      role="group"
      aria-labelledby="${headingId}"
      class="${mobile ? openReceiveNetworkMobileRevealClasses(accent) : orClasses.methodNetworkReveal}"
    >
      <div class="${orClasses.methodNetworkLayout}">
        <div>
          <h3 id="${headingId}" class="${orClasses.methodNetworkHeading}">${escapeHtml(
            formatOpenReceiveChooseNetworkHeading(group.label),
          )}</h3>
          <p class="${orClasses.methodNetworkHint}">${escapeHtml(
            openReceiveCheckoutLabels.selectNetworkToContinue,
          )}</p>
        </div>
        <div role="group" aria-labelledby="${headingId}" class="${orClasses.methodNetworkGrid}">
          ${networkButtons}
        </div>
        ${continueButtonHtml}
      </div>
      ${summary}
    </div>`;
}

function renderElementMethodConfirmHtml(options: {
  readonly className: string;
  readonly disabled: boolean;
  readonly starting: boolean;
  readonly swapStartAsset?: string;
  readonly label: string;
}): string {
  const swapStart =
    options.disabled || options.swapStartAsset === undefined
      ? ""
      : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(options.swapStartAsset)}"`;
  return `
    <button
      type="button"
      part="method-confirm"
      class="${options.className}"
      ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerContinue}=""
      ${swapStart}
      ${options.disabled ? 'disabled aria-disabled="true"' : ""}
      ${options.starting ? 'aria-busy="true"' : ""}
    >${
      options.starting
        ? `<span part="spinner" class="${orClasses.continueSpinner}" aria-hidden="true"></span>`
        : ""
    }${options.label}</button>`;
}

function renderElementSwapMethodGroupHtml(
  group: {
    readonly label: string;
    readonly options: readonly OpenReceiveElementsSwapOption[];
  },
  view: OpenReceiveElementsWizardView,
  selectedKey: string | null,
  continueButtonHtml?: string,
): string {
  const selectedNetworks = view.selectedSwapNetworks ?? {};
  const groupKey = group.label.trim().toUpperCase();
  const pickerKey = openReceiveSwapPickerKey(group.label);
  const selected = selectedKey === pickerKey;
  const displayOption =
    group.options.find((option) => option.available !== false) ?? group.options[0];
  if (displayOption === undefined) return "";
  const multiNetwork = group.options.length > 1;
  const selectedAsset = selectedNetworks[groupKey];
  const selectedOption =
    selectedAsset === undefined
      ? undefined
      : group.options.find((option) => option.pay_in_asset === selectedAsset);
  const activeOption = selectedOption ?? displayOption;
  const startingAsset = wizardStartingAsset(view);
  const starting = swapGroupIsStarting(group, startingAsset);
  const gridBusy = startingAsset !== undefined;
  const disabled = group.options.every((option) => option.available === false);
  const accent = openReceivePaymentAccentId(group.label);
  const limitOption = disabled
    ? (openReceiveSwapGroupLimitOption(group.options) ?? activeOption)
    : activeOption;
  const limitMessage = elementsSwapLimitMessage(limitOption, view);
  const panelId = `network-panel-${groupKey.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
  const networkDetail =
    !disabled && multiNetwork
      ? selected && selectedOption !== undefined
        ? `${escapeHtml(selectedOption.network_label)} network`
        : escapeHtml(openReceiveCheckoutLabels.selectNetwork)
      : undefined;
  const mobileReveal = multiNetwork
    ? `
      <div class="${orClasses.methodNetworkRevealAnim} ${
        selected ? orClasses.methodNetworkRevealAnimOpen : orClasses.methodNetworkRevealAnimClosed
      }">
        <div class="${orClasses.methodNetworkRevealInner}">
          ${
            selected
              ? renderElementNetworkSelectorHtml(group, view, continueButtonHtml ?? "", true)
              : ""
          }
        </div>
      </div>`
    : "";

  return `
    <div class="${orClasses.methodTile}">
      <button
        part="method"
        type="button"
        aria-pressed="${starting || (multiNetwork && selected) ? "true" : "false"}"
        ${multiNetwork ? `aria-expanded="${selected ? "true" : "false"}" aria-controls="${panelId}"` : ""}
        class="${openReceiveAssetButtonClasses({
          accent,
          selected: starting || (multiNetwork && selected),
          disabled: disabled || (gridBusy && !starting),
        })}"
        ${disabled || gridBusy ? 'disabled aria-disabled="true"' : ""}
        ${starting ? 'aria-busy="true"' : ""}
        ${
          disabled || gridBusy
            ? ""
            : multiNetwork
              ? `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect}="${escapeHtml(pickerKey)}"`
              : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(displayOption.pay_in_asset)}"`
        }
      >
        <span aria-hidden="true" class="${orClasses.methodIconWrap}">
          ${
            starting
              ? `<span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>`
              : `<img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getOpenReceiveSwapOptionIcon(displayOption))}">`
          }
        </span>
        <span class="${orClasses.methodTitleWrap}">
          <span class="${orClasses.methodTitle}">${escapeHtml(group.label)}</span>
          ${
            networkDetail === undefined
              ? ""
              : `<span class="${orClasses.methodDetailMobile}">${networkDetail}</span>`
          }
        </span>
      </button>
      ${
        disabled && limitMessage !== undefined
          ? `<span class="${orClasses.methodLimitHint}">${escapeHtml(limitMessage)}</span>`
          : ""
      }
      ${mobileReveal}
    </div>`;
}

// Short reason for an out-of-range swap asset in the web-component surface,
// sharing the React wizard's canonical message via the browser helper.
function elementsSwapLimitMessage(
  option: OpenReceiveElementsSwapOption,
  view: OpenReceiveElementsWizardView,
): string | undefined {
  const checkout =
    view.amountMsats === undefined
      ? undefined
      : {
          amount_msats: view.amountMsats,
          ...(view.fiat?.currency === undefined || view.fiat.value === undefined
            ? {}
            : { fiat: { currency: view.fiat.currency, value: view.fiat.value } }),
        };
  return openReceiveSwapOptionLimitMessage(option, checkout);
}

function renderElementSwapPanelHtml(
  invoice: CheckoutInvoiceSnapshot,
  view: OpenReceiveElementsWizardView = {},
): string {
  const display = createOpenReceiveSwapDisplayModel(invoice);
  if (display === undefined) return "";
  const backButton = `
    <button part="swap-back" class="${orClasses.swapBack}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapBack} type="button">Pay with Lightning instead</button>
  `;
  const supportDetails = renderElementSwapSupportDetailsHtml(display);
  const heading = `
    <div part="swap-heading" class="${orClasses.swapHeading}">
      <strong class="${orClasses.swapHeadingTitle}">${escapeHtml(display.providerStateLabel)}</strong>
      <span class="${orClasses.swapHeadingDetail}">${escapeHtml(display.providerStateDetail)}</span>
    </div>
  `;

  if (display.state === "creating") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <div part="status" class="${orClasses.paymentStatus}">
          <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
          <div class="${orClasses.paymentStatusBody}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
          </div>
        </div>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "deposit") {
    const feeBreakdown = renderElementSwapFeeBreakdownHtml(display.feeBreakdown);
    const waitingStatus = `
      <div part="status" class="${orClasses.paymentStatus}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <div class="${orClasses.paymentStatusBody}">
          <div class="${orClasses.swapWaitingTitle}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <strong part="swap-countdown" class="${orClasses.swapCountdown}">${escapeHtml(display.countdownLabel)}</strong>
          </div>
          <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
        </div>
      </div>
    `;
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <p part="swap-instruction" class="${orClasses.swapInstruction}">Pay <strong>${escapeHtml(display.depositAmount)} ${escapeHtml(display.assetLabel)}</strong> to this address</p>
        ${renderElementSwapNetworkWarningHtml(display)}
        <div part="swap-deposit-layout" class="${orClasses.swapDepositLayout}">
          <div part="swap-qr" class="${orClasses.swapQr}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr}="${escapeHtml(display.qrPayload)}"></div>
          <div part="swap-deposit-side" class="${orClasses.swapDepositSide}">
            <dl part="swap-details" class="${orClasses.swapDetails}">
              ${renderElementSwapCopyDetailHtml("Address", display.depositAddress)}
              ${display.depositMemo === undefined ? "" : renderElementSwapCopyDetailHtml("Memo", display.depositMemo)}
              ${renderElementSwapCopyDetailHtml("Amount", display.depositAmount)}
            </dl>
            ${waitingStatus}
            ${feeBreakdown}
          </div>
        </div>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "settled") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId, display.depositTxId, display.payInAsset)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.providerOrderId === undefined ? "" : renderElementSwapCopyDetailHtml("Provider order", display.providerOrderId)}
        </dl>
        ${renderElementTransactionDetailsHtml(invoice, view)}
      </section>
    `;
  }

  if (display.state === "progress") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <div part="status" class="${orClasses.paymentStatus}">
          <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
          <div class="${orClasses.paymentStatusBody}">
            <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(display.providerStateLabel)}</strong>
            <p class="${orClasses.paymentStatusDetail}">${escapeHtml(display.providerStateDetail)}</p>
          </div>
        </div>
        ${supportDetails}
      </section>
    `;
  }

  if (display.state === "expired") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <p part="swap-warning" class="${orClasses.swapWarning}">This payment address expired without a detected payment. Create a new payment address to try again.</p>
        ${supportDetails}
        ${backButton}
      </section>
    `;
  }

  if (display.state === "refund_required") {
    const stagedRefundAddress = display.refundAddress;
    const refundFacts = renderElementSwapRefundFactsHtml(display);
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        ${refundFacts}
        <p part="swap-warning" class="${orClasses.swapWarning}">Use a ${escapeHtml(display.networkLabel)} address you control. Do not paste the deposit address.</p>
        ${
          stagedRefundAddress === undefined
            ? `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            novalidate
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundPayInAsset}="${escapeHtml(display.payInAsset)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNetworkLabel}="${escapeHtml(display.networkLabel)}"
            ${display.refundNonce === undefined ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce}="${escapeHtml(display.refundNonce)}"`}
          >
            <input
              class="${orClasses.swapRefundInput}"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAddress}
              name="refund_address"
              placeholder="${escapeHtml(display.networkLabel)} refund address"
              type="text"
              autocomplete="off"
              required
            >
            <p
              part="swap-refund-error"
              class="${orClasses.swapRefundError}"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundError}
              hidden
              role="alert"
            ></p>
            <p part="swap-refund-hint" class="${orClasses.swapRefundHint}">Make sure you control this ${escapeHtml(display.networkLabel)} address. Refunds sent to the wrong address usually cannot be recovered.</p>
            <button class="${orClasses.btn}" type="submit">Review refund address</button>
          </form>
        `
            : `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundPayInAsset}="${escapeHtml(display.payInAsset)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNetworkLabel}="${escapeHtml(display.networkLabel)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm}="true"
            ${display.refundNonce === undefined ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce}="${escapeHtml(display.refundNonce)}"`}
          >
            <p part="swap-warning" class="${orClasses.swapWarning}">Confirm refund to ${escapeHtml(stagedRefundAddress)}.</p>
            <input
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAddress}
              name="refund_address"
              type="hidden"
              value="${escapeHtml(stagedRefundAddress)}"
            >
            <button class="${orClasses.btn}" type="submit">Confirm refund</button>
          </form>
        `
        }
        ${supportDetails}
        ${renderElementSwapRefundReturnWarningHtml()}
      </section>
    `;
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    const refundFacts = renderElementSwapRefundFactsHtml(display);
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        ${refundFacts}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.refundAddress === undefined ? "" : renderElementSwapCopyDetailHtml("Refund address", display.refundAddress, display.refundAddress, display.payInAsset)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId, display.refundTxId, display.payInAsset)}
        </dl>
        ${supportDetails}
        ${renderElementSwapRefundReturnWarningHtml()}
      </section>
    `;
  }

  return `
    <section part="swap-panel" class="${orClasses.swapPanel}">
      ${heading}
      <p part="swap-warning" class="${orClasses.swapWarning}">This payment needs support review.</p>
      ${supportDetails}
      ${backButton}
    </section>
  `;
}

function renderElementSwapRefundReturnWarningHtml(): string {
  return `
    <p part="swap-refund-return" class="${orClasses.swapWarning}">${escapeHtml(openReceiveCheckoutLabels.refundReturnWarning)}</p>
  `;
}

function renderElementSwapRefundFactsHtml(display: OpenReceiveSwapDisplayModel): string {
  const rows = [
    display.depositReceivedAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Amount received",
          `${display.depositReceivedAmount} ${display.assetLabel}`,
        ),
    display.depositReceivedAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Amount required",
          `${display.depositAmount} ${display.assetLabel}`,
        ),
    display.refundAmount === undefined
      ? ""
      : renderElementSwapCopyDetailHtml(
          "Estimated refund",
          `${display.refundAmount} ${display.assetLabel}`,
        ),
  ].join("");
  if (rows.length === 0) return "";
  return `<dl part="swap-details" class="${orClasses.swapDetails}">${rows}</dl>`;
}

function renderElementSwapNetworkWarningHtml(
  display: Pick<
    NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>,
    "networkWarningTitle" | "networkWarningEmphasis" | "networkWarning"
  >,
): string {
  const emphasisStart = display.networkWarning.indexOf(display.networkWarningEmphasis);
  const before =
    emphasisStart === -1
      ? escapeHtml(display.networkWarning)
      : escapeHtml(display.networkWarning.slice(0, emphasisStart));
  const after =
    emphasisStart === -1
      ? ""
      : escapeHtml(
          display.networkWarning.slice(emphasisStart + display.networkWarningEmphasis.length),
        );
  const emphasis =
    emphasisStart === -1
      ? ""
      : `<strong class="${orClasses.swapNetworkWarningEmphasis}">${escapeHtml(display.networkWarningEmphasis)}</strong>`;
  return `
    <div part="swap-network-warning" role="alert" class="${orClasses.swapNetworkWarning}">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="${orClasses.swapNetworkWarningIcon}" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
      <div class="${orClasses.swapNetworkWarningContent}">
        <p class="${orClasses.swapNetworkWarningTitle}">${escapeHtml(display.networkWarningTitle)}</p>
        <p class="${orClasses.swapNetworkWarningBody}">${before}${emphasis}${after}</p>
      </div>
    </div>
  `;
}

function renderElementTransactionDetailsHtml(
  invoice: CheckoutInvoiceSnapshot,
  view: OpenReceiveElementsWizardView,
): string {
  const bolt11 = typeof invoice.invoice === "string" ? invoice.invoice : view.lightningInvoice;
  return renderTransactionDetailsHtml({
    ...(view.orderId === undefined ? {} : { order_id: view.orderId }),
    ...(view.checkoutId === undefined ? {} : { checkout_id: view.checkoutId }),
    invoice_id: invoice.invoice_id,
    ...(bolt11 === undefined ? {} : { invoice: bolt11 }),
    rail: invoice.rail,
    ...(invoice.payment_hash === undefined
      ? view.paymentHash === undefined
        ? {}
        : { payment_hash: view.paymentHash }
      : { payment_hash: invoice.payment_hash }),
    ...(invoice.amount_msats === undefined
      ? view.amountMsats === undefined
        ? {}
        : { amount_msats: view.amountMsats }
      : { amount_msats: invoice.amount_msats }),
    ...(invoice.fiat_quote === undefined
      ? view.fiat?.currency === undefined || view.fiat.value === undefined
        ? {}
        : { fiat_quote: { fiat: { currency: view.fiat.currency, value: view.fiat.value } } }
      : { fiat_quote: invoice.fiat_quote }),
    ...(invoice.transaction_state === undefined
      ? {}
      : { transaction_state: invoice.transaction_state }),
    ...(invoice.workflow_state === undefined ? {} : { workflow_state: invoice.workflow_state }),
    ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
    ...(invoice.settled_at === undefined ? {} : { settled_at: invoice.settled_at }),
    ...(invoice.swap === undefined ? {} : { swap: invoice.swap }),
  });
}

function renderElementSwapFeeBreakdownHtml(
  breakdown: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>["feeBreakdown"],
): string {
  if (breakdown === undefined) return "";
  const feeValue =
    breakdown.feePercent === undefined
      ? breakdown.fee
      : `${breakdown.fee} (${breakdown.feePercent})`;
  return `
    <div part="swap-breakdown" class="${orClasses.swapBreakdown}">
      <p part="swap-breakdown-title" class="${orClasses.swapBreakdownTitle}">Payment breakdown</p>
      <dl part="swap-details" class="${orClasses.swapBreakdownRows}">
        <dt>Cart total</dt>
        <dd>${escapeHtml(breakdown.cartTotal)}</dd>
        <dt>You send</dt>
        <dd>${escapeHtml(breakdown.youSend)}</dd>
        <dt>Swap + network fees</dt>
        <dd>${escapeHtml(feeValue)}</dd>
      </dl>
    </div>
  `;
}

function renderElementSwapSupportDetailsHtml(
  display: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>,
): string {
  if (
    display.depositTxId === undefined &&
    display.payoutTxId === undefined &&
    display.refundTxId === undefined &&
    display.providerOrderId === undefined
  ) {
    return "";
  }
  return `
    <details part="swap-support" class="${orClasses.swapSupport}">
      <summary class="${orClasses.swapSupportTitle}">Payment details</summary>
      <div class="${orClasses.swapSupportContent}">
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId, display.depositTxId, display.payInAsset)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId, display.refundTxId, display.payInAsset)}
          ${display.providerOrderId === undefined ? "" : renderElementSwapCopyDetailHtml("Provider order", display.providerOrderId)}
        </dl>
      </div>
    </details>
  `;
}

function renderWizardBreadcrumbsHtml(options: {
  readonly method: OpenReceivePaymentMethod;
  readonly selectedRoute: string | null;
  readonly routeAssets: readonly OpenReceiveWizardRouteAssetDisplay[];
}): string {
  const method = openReceivePaymentMethods.find((candidate) => candidate.id === options.method);
  const methodLabel = method?.title ?? openReceiveCheckoutLabels.paymentMethod;
  const routeLabel =
    options.selectedRoute === null || options.routeAssets.length <= 1
      ? null
      : (options.routeAssets.find((asset) => asset.id === options.selectedRoute)?.label ??
        options.selectedRoute);

  return `
    <nav part="wizard-breadcrumbs" class="${orClasses.breadcrumbs}" aria-label="Payment path">
      <button
        part="wizard-breadcrumb"
        class="${orClasses.btnGhost}"
        ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="method"
        type="button"
      >
        <span>${escapeHtml(openReceiveCheckoutLabels.switchPaymentMethod)}</span>
      </button>
      <span part="wizard-breadcrumb-separator" aria-hidden="true">/</span>
      ${
        routeLabel === null
          ? `<span part="wizard-breadcrumb-current" class="${orClasses.breadcrumbCurrent}">${escapeHtml(methodLabel)}</span>`
          : `
          <button
            part="wizard-breadcrumb"
            class="${orClasses.btnGhost}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="route"
            type="button"
          >
            <span>${escapeHtml(methodLabel)}</span>
          </button>
          <span part="wizard-breadcrumb-separator" aria-hidden="true">/</span>
          <span part="wizard-breadcrumb-current" class="${orClasses.breadcrumbCurrent}">${escapeHtml(routeLabel)}</span>
        `
      }
    </nav>
  `;
}

function renderProviderOpenActionHtml(provider: OpenReceiveWizardProviderDisplay): string {
  if (provider.tutorials.length === 0) {
    return `<a class="${orClasses.providerOpen}" href="${escapeHtml(provider.url)}" rel="noreferrer" target="_blank">${escapeHtml(provider.openLabel)}</a>`;
  }

  return `
    <button
      part="provider-open"
      class="${orClasses.providerOpen}"
      ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${escapeHtml(provider.id)}"
      ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="0"
      type="button"
    >${escapeHtml(provider.openLabel)}</button>
  `;
}

function renderTutorialModalHtml(
  routes: readonly OpenReceiveWizardRouteDisplay[],
  activeProviderId: string | null,
  activeTutorialIndex: number,
  copied: boolean,
  lightningInvoice?: string,
  decodeLinkUrl?: string,
): string {
  if (activeProviderId === null) return "";
  const provider = routes
    .flatMap((route) => route.providers)
    .find((candidate) => candidate.id === activeProviderId);
  if (provider === undefined || provider.tutorials.length === 0) return "";

  const totalSteps = provider.tutorials.length + 1;
  const stepIndex = Math.max(0, Math.min(provider.tutorials.length, activeTutorialIndex));
  const tutorial = stepIndex === 0 ? undefined : provider.tutorials[stepIndex - 1];
  const previousIndex = Math.max(0, stepIndex - 1);
  const nextIndex = Math.min(provider.tutorials.length, stepIndex + 1);
  const isFinalStep = stepIndex === provider.tutorials.length;
  const decodeHref =
    lightningInvoice === undefined || lightningInvoice.trim() === ""
      ? undefined
      : createOpenReceiveLightningInvoiceDecodeUrl(lightningInvoice, decodeLinkUrl);
  const decodeButton =
    decodeHref === undefined
      ? ""
      : `<a part="tutorial-decode" class="${orClasses.tutorialCopy}" href="${escapeHtml(decodeHref)}" rel="noreferrer" target="_blank">${escapeHtml(openReceiveCheckoutLabels.decodeInvoice)}</a>`;
  const body =
    stepIndex === 0
      ? `
        <div part="tutorial-intro" class="${orClasses.tutorialIntro}">
          <img part="tutorial-provider-logo" alt="" src="${escapeHtml(provider.icon)}" class="${orClasses.tutorialProviderLogo}">
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroPrefix)} ${escapeHtml(provider.name)}.</p>
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroCopy)}</p>
          <button part="tutorial-copy" class="${orClasses.tutorialCopy}" type="button">${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>
          ${decodeButton}
          ${
            copied
              ? `<p part="tutorial-copy-message" class="${orClasses.tutorialCopyMessage}">${escapeHtml(openReceiveCheckoutLabels.tutorialCopiedContinue)}</p>`
              : ""
          }
        </div>
      `
      : `
        <div part="tutorial-frame" class="${orClasses.tutorialFrame}">
          <img part="tutorial-image" class="${orClasses.tutorialImage}" alt="${escapeHtml(tutorial?.caption ?? "")}" src="${escapeHtml(tutorial?.image ?? "")}">
        </div>
        <p part="tutorial-caption" class="${orClasses.tutorialCaption}">${escapeHtml(tutorial?.caption ?? "")}</p>
      `;

  return `
    <div part="tutorial" class="${orClasses.tutorialModal}" role="dialog" aria-modal="true" aria-label="${escapeHtml(openReceiveCheckoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}" tabindex="-1">
      <div part="tutorial-dialog" class="${orClasses.tutorialBox}">
        <div part="tutorial-header" class="${orClasses.tutorialHeader}">
          <div part="tutorial-title" class="${orClasses.tutorialTitle}">
            <img part="tutorial-header-logo" alt="" src="${escapeHtml(provider.icon)}" class="${orClasses.tutorialHeaderLogo}">
            <h3>${escapeHtml(openReceiveCheckoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}</h3>
          </div>
          <button
            part="tutorial-close"
            class="${orClasses.tutorialClose}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}=""
            type="button"
            aria-label="Close"
          >X</button>
        </div>
        ${body}
        <div part="tutorial-steps" class="${orClasses.tutorialSteps}" aria-hidden="true">
          ${Array.from(
            { length: totalSteps },
            (_, index) => `
            <span part="${index === stepIndex ? "tutorial-step-active" : "tutorial-step"}" class="${index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep}"></span>
          `,
          ).join("")}
        </div>
        <p part="tutorial-progress" class="${orClasses.tutorialProgress}">Step ${stepIndex + 1} of ${totalSteps}</p>
        <div part="tutorial-controls" class="${orClasses.tutorialControls}">
          <button
            part="tutorial-nav"
            class="${orClasses.btn}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${escapeHtml(provider.id)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="${previousIndex}"
            type="button"
            ${stepIndex === 0 ? "disabled" : ""}
          >Back</button>
          <button
            part="tutorial-nav"
            class="${orClasses.btn}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${isFinalStep ? "" : escapeHtml(provider.id)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="${nextIndex}"
            type="button"
          >${escapeHtml(isFinalStep ? openReceiveCheckoutLabels.tutorialExit : "Next")}</button>
        </div>
      </div>
    </div>
  `;
}
