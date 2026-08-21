// The payment wizard's own markup: the method grid, the network selector, the
// route/asset pickers, and the breadcrumb trail. The deposit panel and the
// provider tutorial modal are rendered by the two sibling modules.
import {
  buildOpenReceiveMethodGridEntries,
  createOpenReceivePaymentWizardModel,
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
  openReceiveAssetButtonClasses,
  openReceiveCheckoutLabels,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
  openReceivePaymentAccentId,
  type OpenReceivePaymentMethod,
  openReceivePaymentMethods,
  type OpenReceivePaymentWizardSelection,
  openReceiveSwapAssetMatchesRoute,
  openReceiveSwapGroupLimitOption,
  openReceiveSwapPickerKey,
  type OpenReceiveWizardRouteAssetDisplay,
  orClasses,
} from "@openreceive/browser/internal";
import type { OpenReceiveElementsSwapOption, OpenReceiveElementsWizardView } from "./views.ts";
import {
  elementsSwapLimitMessage,
  renderElementSwapActionsHtml,
  renderElementSwapPanelHtml,
} from "./render-swap-panel.ts";
import {
  renderProviderOpenActionHtml,
  renderTutorialModalHtml,
} from "./render-provider-tutorial.ts";

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
