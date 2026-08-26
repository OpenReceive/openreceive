// The payment wizard's own markup: the method grid, the network selector, the
// route/asset pickers, and the breadcrumb trail. The deposit panel and the
// provider tutorial modal are rendered by the two sibling modules.

import type { CheckoutPaymentMethod, SwapLimitContext } from "@openreceive/browser/headless";
import {
  assetButtonClasses,
  buildMethodGridEntries,
  checkoutLabels,
  createMethodGridDisplay,
  createPaymentWizardModel,
  createSwapUnavailableModel,
  createWizardRouteAssetDisplays,
  createWizardRouteDisplays,
  escapeHtml,
  formatNetworkSummary,
  getNetworkIcon,
  getPaymentMethodIcon,
  getSwapOptionIcon,
  getWizardEmptyMessage,
  networkButtonClasses,
  networkCheckClasses,
  networkMobileRevealClasses,
  networkSummaryIconClasses,
  type MethodGridGroupDisplay,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  orClasses,
  type PaymentMethod,
  type PaymentWizardSelection,
  paymentMethods,
  swapAssetMatchesRoute,
  type WizardRouteAssetDisplay,
} from "@openreceive/browser/headless";
import {
  renderProviderOpenActionHtml,
  renderTutorialModalHtml,
} from "./render-provider-tutorial.ts";
import {
  elementsSwapLimitContext,
  elementsSwapLimitMessage,
  renderElementSwapActionsHtml,
  renderElementSwapPanelHtml,
} from "./render-swap-panel.ts";
import type { ElementsSwapOption, ElementsWizardView } from "./views.ts";

function wizardStartingAsset(view: ElementsWizardView): string | undefined {
  const asset = view.startingSwapAsset;
  return asset !== undefined && asset !== null && asset.length > 0 ? asset : undefined;
}

/**
 * The out-of-range pane. Same model, same copy, same accepted range as React's
 * `renderSwapUnavailable` — the shared `createSwapUnavailableModel` owns all
 * three, so the two renderers can only differ in markup.
 */
function renderElementSwapUnavailableHtml(
  quote: CheckoutPaymentMethod,
  checkout: SwapLimitContext | undefined,
): string {
  const model = createSwapUnavailableModel(quote, checkout);
  return `<section part="swap-panel" class="${orClasses.swapPanel}">
      <div part="swap-heading" class="${orClasses.swapHeading}">
        <strong class="${orClasses.swapHeadingTitle}">${escapeHtml(model.title)}</strong>
      </div>
      <p part="swap-warning" class="${orClasses.swapWarning}">${escapeHtml(model.detail)}</p>
      ${model.range === undefined ? "" : `<p class="${orClasses.swapWarning}">${escapeHtml(model.range)}</p>`}
      <p class="${orClasses.swapProgress}">${escapeHtml(model.hint)}</p>
    </section>`;
}

export function renderPaymentWizardHtml(view: ElementsWizardView = {}): string {
  const selection: PaymentWizardSelection = {
    selectedMethod: view.selectedMethod ?? null,
    selectedBitcoinRoute: view.selectedBitcoinRoute ?? null,
  };
  const model = createPaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute,
    ...(view.resolveAssetUrl === undefined ? {} : { resolveAssetUrl: view.resolveAssetUrl }),
  });
  const routeDisplays = createWizardRouteDisplays(wizard.routes, {
    ...(view.resolveAssetUrl === undefined ? {} : { resolveAssetUrl: view.resolveAssetUrl }),
  });
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
          >${escapeHtml(checkoutLabels.switchPaymentMethod)}</button>
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
                        <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(checkoutLabels.swapStartFailedTitle)}</strong>
                        <p class="${orClasses.paymentStatusDetail}">${escapeHtml(view.swapStartError)}</p>
                        <button
                          part="swap-retry"
                          class="${orClasses.btn}"
                          type="button"
                          ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(selectedSwapAsset)}"
                        >${escapeHtml(checkoutLabels.tryAgain)}</button>
                      </div>
                    </div>
                  </section>`
                : view.unavailableSwapQuote !== undefined
                  ? renderElementSwapUnavailableHtml(
                      view.unavailableSwapQuote,
                      view.swapLimitContext,
                    )
                  : `<section part="swap-panel" class="${orClasses.swapPanel}">
                    <div part="status" class="${orClasses.paymentStatus}">
                      <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
                      <div class="${orClasses.paymentStatusBody}">
                        <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(checkoutLabels.preparingPaymentAddress)}</strong>
                        <p class="${orClasses.paymentStatusDetail}">${escapeHtml(
                          checkoutLabels.preparingPaymentAddressDetail.replace(
                            "{asset}",
                            selectedSwapOption?.label ?? "coin",
                          ),
                        )}</p>
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
              getWizardEmptyMessage(),
            )}</p>
	          `
              : routeDisplays
                  .map((route) => {
                    const activeSwap =
                      view.swapInvoice !== undefined &&
                      swapAssetMatchesRoute(route.key, view.swapInvoice.swap?.pay_in_asset)
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
  swapAssetOptions: readonly ElementsSwapOption[],
  view: ElementsWizardView,
): string {
  // One model, both renderers: which tile is open, which network each coin is
  // set to, which asset is starting, and every derivation that used to be
  // re-done by hand on each side of the pair.
  const limitContext = elementsSwapLimitContext(view);
  const display = createMethodGridDisplay({
    entries: buildMethodGridEntries(paymentMethods, swapAssetOptions),
    selectedPickerKey: view.selectedPickerKey ?? null,
    selectedNetworks: view.selectedSwapNetworks ?? {},
    startingAsset: wizardStartingAsset(view) ?? null,
    ...(limitContext === undefined ? {} : { checkout: limitContext }),
  });
  const currenciesLoading = view.currenciesLoading === true && swapAssetOptions.length === 0;
  const { gridBusy, networkRequired, selectedGroup, continueTarget } = display;

  const continueButton = (className: string) =>
    renderElementMethodConfirmHtml({
      className,
      disabled: continueTarget === undefined || continueTarget.disabled,
      starting: continueTarget?.starting === true,
      swapStartAsset:
        continueTarget === undefined || continueTarget.disabled
          ? undefined
          : continueTarget.payInAsset,
      label: escapeHtml(continueTarget?.label ?? checkoutLabels.continue),
    });

  const tiles = display.entries
    .map((entry) => {
      if (entry.kind === "method") {
        const method = entry.method;
        return `
          <button
            part="method"
            type="button"
            class="${assetButtonClasses({ accent: entry.accent, selected: false, disabled: entry.disabled })}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="${escapeHtml(method.id)}"
            ${entry.disabled ? 'disabled aria-disabled="true"' : ""}
          >
            <span aria-hidden="true" class="${orClasses.methodIconWrap}">
              <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getPaymentMethodIcon(method.id, view.resolveAssetUrl))}">
            </span>
            <span class="${orClasses.methodTitleWrap}">
              <span class="${orClasses.methodTitle}">${escapeHtml(method.title)}</span>
            </span>
          </button>`;
      }
      return renderElementSwapMethodGroupHtml(
        entry.group,
        view,
        gridBusy,
        entry.group.selected ? continueButton(orClasses.methodConfirmDesktop) : undefined,
      );
    })
    .join("");
  const loadingTile = currenciesLoading
    ? `<div part="currencies-loading" role="status" aria-live="polite" class="${orClasses.methodCurrenciesLoading}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <span class="${orClasses.methodTitle}">${escapeHtml(checkoutLabels.loadingCurrencies)}</span>
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
        <h2 id="payment-method-heading" class="${orClasses.wizardHeaderTitle}">${escapeHtml(checkoutLabels.wizardTitle)}</h2>
        <p class="${orClasses.wizardHeaderSubtitle}">${escapeHtml(checkoutLabels.wizardSubtitle)}</p>
      </header>
      <div class="${orClasses.wizardBody}" aria-labelledby="payment-method-heading">
        <div part="method-grid" role="group" aria-label="${escapeHtml(checkoutLabels.paymentMethod)}" class="${orClasses.methodGrid}">
          ${tiles}${loadingTile}
        </div>
        ${desktopReveal}
      </div>
    `;
}

function renderElementNetworkSelectorHtml(
  group: MethodGridGroupDisplay<ElementsSwapOption>,
  view: ElementsWizardView,
  continueButtonHtml: string,
  mobile: boolean,
): string {
  const { accent, groupKey, panelId, headingId, selectedOption } = group;
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
            class="${networkButtonClasses({
              accent,
              selected: optionSelected,
              disabled: optionDisabled,
            })}"
            ${optionDisabled ? 'disabled aria-disabled="true"' : ""}
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork}="${escapeHtml(groupKey)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetworkValue}="${escapeHtml(option.pay_in_asset)}"
          >
            <span aria-hidden="true" class="grid size-6 shrink-0 place-items-center">
              <img class="${orClasses.methodNetworkIcon}" alt="" src="${escapeHtml(getNetworkIcon(option.network_label, view.resolveAssetUrl))}">
            </span>
            <span class="truncate">${escapeHtml(option.network_label)}</span>
            ${
              optionSelected
                ? `<span aria-hidden="true" class="${networkCheckClasses(accent)}">✓</span>`
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
          <span aria-hidden="true" class="${networkSummaryIconClasses(accent)}">✓</span>
          ${escapeHtml(formatNetworkSummary(group.label, selectedOption.network_label))}
        </p>`;

  return `
    <div
      id="${panelId}"
      role="group"
      aria-labelledby="${headingId}"
      class="${mobile ? networkMobileRevealClasses(accent) : orClasses.methodNetworkReveal}"
    >
      <div class="${orClasses.methodNetworkLayout}">
        <div>
          <h3 id="${headingId}" class="${orClasses.methodNetworkHeading}">${escapeHtml(
            group.heading,
          )}</h3>
          <p class="${orClasses.methodNetworkHint}">${escapeHtml(
            checkoutLabels.selectNetworkToContinue,
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
  group: MethodGridGroupDisplay<ElementsSwapOption>,
  view: ElementsWizardView,
  gridBusy: boolean,
  continueButtonHtml?: string,
): string {
  const {
    pickerKey,
    selected,
    displayOption,
    selectedOption,
    multiNetwork,
    starting,
    disabled,
    accent,
    limitMessage,
    panelId,
  } = group;
  const networkDetail =
    !disabled && multiNetwork
      ? selected && selectedOption !== undefined
        ? `${escapeHtml(selectedOption.network_label)} network`
        : escapeHtml(checkoutLabels.selectNetwork)
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
        class="${assetButtonClasses({
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
              : `<img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getSwapOptionIcon(displayOption, view.resolveAssetUrl))}">`
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
  readonly method: PaymentMethod;
  readonly selectedRoute: string | null;
  readonly routeAssets: readonly WizardRouteAssetDisplay[];
}): string {
  const method = paymentMethods.find((candidate) => candidate.id === options.method);
  const methodLabel = method?.title ?? checkoutLabels.paymentMethod;
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
        <span>${escapeHtml(checkoutLabels.switchPaymentMethod)}</span>
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
