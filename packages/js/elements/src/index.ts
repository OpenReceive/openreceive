import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
  OPENRECEIVE_DEFAULT_PREFIX,
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type OpenReceiveBrowserLogger,
  type OpenReceivePaymentMethod,
  type OpenReceiveQrEncoder,
  type OpenReceiveRegionId,
  applyCheckoutElementAttributes,
  copyInvoice,
  createCheckoutActionEvent,
  createCheckoutDisplayModel,
  createCheckoutController,
  createCheckoutElementAttributes,
  createCheckoutErrorEvent,
  createCheckoutStatusModel,
  createCheckoutSnapshotFromDisplayData,
  createCheckoutStateFromDisplayData,
  createCheckoutStateEvent,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createCheckoutProviderCopyEvent,
  createOpenReceiveThemeChangeEvent,
  createOpenReceiveTransientFeedbackController,
  createOpenReceiveSwapDisplayModel,
  createQrPayloadSvg,
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  createQrSvg,
  escapeOpenReceiveHtml,
  formatOpenReceiveMsats,
  formatOpenReceiveAmountCaption,
  getOpenReceiveDefaultCountryCode,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveRegionForCountry,
  getOpenReceiveSwapOptionIcon,
  getOpenReceiveWizardEmptyMessage,
  groupOpenReceiveSwapOptionsByLabel,
  formatOpenReceiveSwapLimit,
  openReceiveCheckoutLabels,
  openReceiveCheckoutElementStyles,
  openWallet,
  openReceivePaymentMethods,
  openReceiveSwapAssetMatchesRoute,
  normalizeSwapStartInvoice,
  orClasses,
  postOpenReceiveJson,
  openReceiveThemeToggleElementStyles,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveRegion,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveThemePreference,
  readOpenReceiveStoredCountryCode,
  requestCheckout,
  resolveOrderUrlFromPrefix,
  status as deriveStatus,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveStoredCountryCode,
  type CheckoutController,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardRouteDisplay,
  type Status
} from "@openreceive/browser/internal";

export interface CheckoutView {
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly rail?: "lightning" | "swap";
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly fiat_quote?: {
    readonly fiat?: {
      readonly currency?: string;
      readonly value?: string;
    };
  } | null;
  readonly status?: Status;
  readonly expires_at?: number;
  readonly theme?: "light" | "dark";
  readonly payment_wizard?: boolean;
  readonly wizard?: OpenReceiveElementsWizardView;
}

export interface OpenReceiveElementsWizardView {
  readonly selectedMethod?: OpenReceivePaymentMethod | null;
  readonly selectedCountryCode?: string;
  readonly selectedBitcoinRoute?: string | null;
  readonly selectedCryptoRoute?: string | null;
  readonly selectedRegion?: OpenReceiveRegionId;
  readonly countryPickerOpen?: boolean;
  readonly swapOptions?: readonly OpenReceiveElementsSwapOption[];
  /** Selected pay-in asset per multi-network coin label (e.g. USDT → USDT_TRON). */
  readonly selectedSwapNetworks?: Readonly<Record<string, string>>;
  /** When set, the wizard shows the focused swap deposit flow for this pay-in asset. */
  readonly selectedSwapAsset?: string | null;
  /** Invoice amount + fiat, used to render fiat limit messages for out-of-range assets. */
  readonly amountMsats?: number;
  readonly fiat?: { readonly currency?: string; readonly value?: string };
  readonly swapInvoice?: CheckoutInvoiceSnapshot;
  readonly activeTutorialProviderId?: string | null;
  readonly activeTutorialIndex?: number;
  readonly activeTutorialCopied?: boolean;
}

export type OpenReceiveElementsSwapOption = OpenReceiveCheckoutPaymentMethod;

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
}

const DEFAULT_TAG_NAME = "openreceive-checkout";
export { OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME } from "@openreceive/browser/internal";

const COPY_INVOICE_ICON = `<svg class="${orClasses.copyIcon}" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 11V3.5A1.5 1.5 0 0 1 5 2h5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export function renderCheckoutHtml(view: CheckoutView): string {
  const display = createCheckoutDisplayModel({
    ...view,
    rail: view.rail ?? "lightning"
  });
  const checkoutState = createElementCheckoutState(view);
  const summaryAmountLabel = display.fiatLabel === undefined ? display.amountLabel : undefined;
  const amountLabel =
    summaryAmountLabel === undefined
      ? ""
      : `<span part="amount" class="${orClasses.metaItem}">${escapeHtml(summaryAmountLabel)}</span>`;
  const amountCaption = formatOpenReceiveAmountCaption({
    amountLabel: display.amountLabel,
    fiatLabel: display.fiatLabel,
    fiatCurrency: display.fiat_quote?.fiat?.currency,
  });
  const satsDetail =
    amountCaption === undefined
      ? ""
      : `<div part="sats-detail" class="${orClasses.satsDetail}">${escapeHtml(amountCaption)}</div>`;
  const fiatLabel =
    display.fiatLabel === undefined
      ? ""
      : `<span part="amount" class="${orClasses.metaItem}">${escapeHtml(display.fiatLabel)}</span>`;
  const statusLabel = view.status ?? (
    checkoutState === undefined
      ? deriveStatus(view)
      : deriveStatus(checkoutState)
  );
  const stateClass =
    statusLabel === "settled" ? orClasses.stateSettled : orClasses.statePending;
  const stateLabel =
    `<span part="state" class="${stateClass}" data-state="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</span>`;
  const status = checkoutState === undefined
    ? ""
    : renderElementPaymentStatusHtml(checkoutState);
  const statusModel = checkoutState === undefined
    ? undefined
    : createCheckoutStatusModel(checkoutState);
  const expired = statusModel?.phase === "expired";
  const hideLightning = (view.wizard?.selectedSwapAsset ?? null) !== null && !expired;
  const wizard =
    expired || view.payment_wizard === false
      ? ""
      : renderOpenReceivePaymentWizardHtml(view.wizard);
  const copyButton = `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.copy}" class="${orClasses.btn}" type="button">${COPY_INVOICE_ICON}${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>`;
  const startOverButton = `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.startOver}" class="${orClasses.btn}" type="button">${escapeHtml(openReceiveCheckoutLabels.startOver)}</button>`;
  const lightningPane =
    hideLightning || expired
      ? ""
      : `<div part="lightning-pane" class="${orClasses.lightningPaneDesktop}">
          <div part="qr" class="${orClasses.qr}" ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr}></div>
          ${satsDetail}
          <div part="actions" class="${orClasses.actions}">${copyButton}</div>
        </div>`;
  const paymentLayoutClass = expired
    ? orClasses.paymentLayoutExpired
    : orClasses.paymentLayout;

  return `
    <style>${openReceiveCheckoutElementStyles}</style>
    <section part="root"${view.theme === undefined ? "" : ` data-theme="${escapeHtml(view.theme)}"`} class="${orClasses.root}">
      ${hideLightning
        ? ""
        : `<div part="payment-layout" class="${paymentLayoutClass}">
            ${lightningPane}
            <div part="payment-info" class="${orClasses.paymentInfo}">
              ${status}
              <div part="meta" class="${orClasses.meta}">${amountLabel}${fiatLabel}${stateLabel}</div>
              ${expired ? `<div part="actions" class="${orClasses.actions}">${startOverButton}</div>` : ""}
            </div>
          </div>`}
      ${wizard}
    </section>
  `;
}

// Minimal "creating checkout" placeholder shown by a create-mode element (`order-id` with no
// `invoice`) while the checkout is being created, before the invoice/order-url attributes are
// populated and the normal checkout UI takes over.
export function renderCheckoutCreatingHtml(theme?: "light" | "dark"): string {
  return `
    <style>${openReceiveCheckoutElementStyles}</style>
    <section part="root"${theme === undefined ? "" : ` data-theme="${escapeHtml(theme)}"`} class="${orClasses.root}" data-openreceive-creating>
      <div part="status" class="${orClasses.creating}">
        <span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>
        <div><strong>Creating checkout…</strong></div>
      </div>
    </section>
  `;
}

export function renderOpenReceiveThemeToggleHtml(
  label: string,
  resolvedTheme: "light" | "dark" = label.toLowerCase().includes("dark") ? "dark" : "light"
): string {
  void resolvedTheme;
  return `
    <style>${openReceiveThemeToggleElementStyles}</style>
    <button
      aria-label="${escapeHtml(label)}"
      class="${orClasses.themeToggle}"
      part="${OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS.button}"
      title="${escapeHtml(label)}"
      type="button"
      ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle}
    >${escapeHtml(label)}</button>
  `;
}

export function renderOpenReceivePaymentWizardHtml(
  view: OpenReceiveElementsWizardView = {}
): string {
  const selectedCountryCode =
    view.selectedCountryCode ?? getOpenReceiveDefaultCountryCode();
  const selection: OpenReceivePaymentWizardSelection = {
    selectedMethod: view.selectedMethod ?? null,
    selectedCountryCode,
    selectedBitcoinRoute: view.selectedBitcoinRoute ?? null,
    selectedCryptoRoute: view.selectedCryptoRoute ?? null,
    selectedRegion: view.selectedRegion ?? getOpenReceiveRegionForCountry(selectedCountryCode),
    countryPickerOpen: view.countryPickerOpen ?? false
  };
  const model = createOpenReceivePaymentWizardModel(selection);
  const { wizard } = model;
  const routeAssetDisplays = createOpenReceiveWizardRouteAssetDisplays(model.routeAssets, {
    selectedRoute: model.selectedRoute
  });
  const routeDisplays = createOpenReceiveWizardRouteDisplays(wizard.routes);
  const showRoutePicker =
    routeAssetDisplays.length > 0 &&
    (model.selectedRoute === null || routeDisplays.length === 0);
  const breadcrumbs =
    selection.selectedMethod === null
      ? ""
      : renderWizardBreadcrumbsHtml({
        method: selection.selectedMethod,
        selectedRoute: model.selectedRoute,
        routeAssets: routeAssetDisplays
      });
  const swapAssetOptions = (view.swapOptions ?? []).filter(
    (option) => option.provider.length > 0,
  );
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
        <div part="wizard-breadcrumbs" class="${orClasses.breadcrumbs}">
          <button
            part="wizard-breadcrumb"
            class="${orClasses.btnGhost}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="swap-asset"
            type="button"
          >${escapeHtml(openReceiveCheckoutLabels.paymentMethod)}</button>
          <span aria-hidden="true">/</span>
          <span part="wizard-breadcrumb-current" class="${orClasses.breadcrumbCurrent}">${escapeHtml(label)}</span>
        </div>
        <div part="wizard-results" class="${orClasses.wizardResults}">
          ${
            activeSwap === undefined
              ? `<section part="swap-panel" class="${orClasses.swapPanel}">
                  <div part="swap-heading" class="${orClasses.swapHeading}">
                    <strong class="${orClasses.swapHeadingTitle}">Preparing payment address</strong>
                    <span class="${orClasses.swapHeadingDetail}">One moment</span>
                  </div>
                  <p part="swap-progress" class="${orClasses.swapProgress}">Getting your ${escapeHtml(
                    selectedSwapOption?.label ?? "coin",
                  )} payment address…</p>
                </section>`
              : renderElementSwapPanelHtml(activeSwap)
          }
        </div>
      </section>
    `;
  }
  const methodPicker = selection.selectedMethod === null
    ? `
      <div class="${orClasses.wizardHeader}">
        <h2 class="${orClasses.wizardHeaderTitle}">${escapeHtml(openReceiveCheckoutLabels.wizardTitle)}</h2>
        <p class="${orClasses.wizardHeaderSubtitle}">${escapeHtml(openReceiveCheckoutLabels.wizardSubtitle)}</p>
      </div>
      <div part="method-grid" class="${orClasses.methodGrid}">
        ${(swapAssetOptions.length > 0
          ? openReceivePaymentMethods.filter((method) => method.id !== "crypto")
          : openReceivePaymentMethods
        ).map((method) => `
          <button
            part="method"
            class="${orClasses.methodCard}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="${escapeHtml(method.id)}"
            type="button"
          >
            <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getOpenReceivePaymentMethodIcon(method.id))}">
            <strong class="${orClasses.methodTitle}">${escapeHtml(method.title)}</strong>
            <small class="${orClasses.methodDetail}">${escapeHtml(method.detail)}</small>
          </button>
        `).join("")}
        ${renderElementSwapMethodCardsHtml(swapAssetOptions, view)}
      </div>
    `
    : "";

  return `
    <section part="wizard" class="${orClasses.wizard}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}>
      ${methodPicker}
      ${breadcrumbs}
      ${showRoutePicker ? `
        <div part="route-picker" class="${orClasses.routePicker}">
          ${routeAssetDisplays.map((asset) => `
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
            `).join("")}
        </div>
      ` : ""}
      ${selection.selectedMethod === null ? "" : `
        <div part="wizard-results" class="${orClasses.wizardResults}">
          ${routeDisplays.length === 0 ? `
            <p part="wizard-empty" class="${orClasses.wizardEmpty}">${
              escapeHtml(getOpenReceiveWizardEmptyMessage(selection.selectedMethod))
            }</p>
	          ` : routeDisplays.map((route) => {
              const activeSwap =
                view.swapInvoice !== undefined &&
                openReceiveSwapAssetMatchesRoute(route.key, view.swapInvoice.swap?.pay_in_asset)
                  ? view.swapInvoice
                  : undefined;
              return `
	            <section part="wizard-route" class="${orClasses.wizardRoute}">
                <h3 class="${orClasses.wizardRouteHeading}">
                  ${escapeHtml(route.title)}
                  ${wizard.selectedRail === null ? "" : renderCountrySelectHtml({
                    countries: model.countryDisplays,
                    selectedCountryCode: selection.selectedCountryCode
                  })}
                </h3>
              ${activeSwap === undefined
                ? renderElementSwapActionsHtml(route.key, view.swapOptions ?? [], view)
                : renderElementSwapPanelHtml(activeSwap)}
              ${activeSwap === undefined ? `<div part="provider-grid" class="${orClasses.providerGrid}">
                ${route.providers.map((provider) => `
                  <article part="provider${provider.recommended ? " selected" : ""}" class="${provider.recommended ? orClasses.providerCardRecommended : orClasses.providerCard}">
                    <div part="provider-heading" class="${orClasses.providerHeading}">
                      <img class="${orClasses.providerIcon}" alt="" src="${escapeHtml(provider.icon)}">
                      <h4 class="${orClasses.providerName}">${escapeHtml(provider.name)}</h4>
                      ${provider.recommendedLabel === null ? "" : `<span part="recommended" class="${orClasses.providerBadge}">${escapeHtml(provider.recommendedLabel)}</span>`}
	                    </div>
                    <p part="provider-kind" class="${orClasses.providerKind}">${escapeHtml(provider.kind)}</p>
	                    <div part="provider-actions" class="${orClasses.providerActions}">
                      ${renderProviderOpenActionHtml(provider)}
                    </div>
                  </article>
                `).join("")}
              </div>` : ""}
            </section>
          `;
            }).join("")}
        </div>
      `}
      ${renderTutorialModalHtml(
        routeDisplays,
        view.activeTutorialProviderId ?? null,
        view.activeTutorialIndex ?? 0,
        view.activeTutorialCopied ?? false
      )}
    </section>
  `;
}

function renderElementSwapActionsHtml(
  routeKey: string,
  options: readonly OpenReceiveElementsSwapOption[],
  view: OpenReceiveElementsWizardView
): string {
  // Out-of-range assets stay in the list but render as a disabled button with
  // the limit reason, instead of being hidden.
  const shown = options
    .filter((option) => option.provider.length > 0)
    .filter((option) => openReceiveSwapAssetMatchesRoute(routeKey, option.pay_in_asset));
  if (shown.length === 0) return "";

  return `
    <div part="swap-actions" class="${orClasses.swapActions}">
      ${shown.map((option) => {
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
          ${disabled ? "disabled aria-disabled=\"true\"" : ""}
          type="button"
        >Create ${escapeHtml(option.label)} (${escapeHtml(option.network_label)}) payment address</button>
        </div>
      `;
      }).join("")}
    </div>
  `;
}

function renderElementSwapMethodCardsHtml(
  options: readonly OpenReceiveElementsSwapOption[],
  view: OpenReceiveElementsWizardView,
): string {
  const selectedNetworks = view.selectedSwapNetworks ?? {};
  return groupOpenReceiveSwapOptionsByLabel(options)
    .map((group) => {
      const groupKey = group.label.trim().toUpperCase();
      const selectedAsset =
        selectedNetworks[groupKey] ??
        group.options.find((option) => option.available !== false)?.pay_in_asset ??
        group.options[0]?.pay_in_asset;
      const selectedOption =
        group.options.find((option) => option.pay_in_asset === selectedAsset) ?? group.options[0];
      if (selectedOption === undefined) return "";
      const multiNetwork = group.options.length > 1;
      const disabled = selectedOption.available === false;
      const limitMessage = elementsSwapLimitMessage(selectedOption, view);
      if (!multiNetwork) {
        return `
          <button
            part="method"
            class="${disabled ? orClasses.methodCardUnavailable : orClasses.methodCardReady}"
            ${disabled ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(selectedOption.pay_in_asset)}"`}
            ${disabled ? "disabled aria-disabled=\"true\"" : ""}
            type="button"
          >
            <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getOpenReceiveSwapOptionIcon(selectedOption))}">
            <strong class="${orClasses.methodTitle}">${escapeHtml(group.label)}</strong>
            <small class="${orClasses.methodDetail}">${escapeHtml(
              disabled && limitMessage !== undefined ? limitMessage : selectedOption.network_label,
            )}</small>
          </button>
        `;
      }
      return `
        <div part="method-card" class="${disabled ? orClasses.methodCardUnavailable : orClasses.methodCardReady}">
          <img class="${orClasses.methodIcon}" alt="" src="${escapeHtml(getOpenReceiveSwapOptionIcon(selectedOption))}">
          <strong class="${orClasses.methodTitle}">${escapeHtml(group.label)}</strong>
          <label part="method-network">
            <span class="${orClasses.methodNetworkLabel}">${escapeHtml(group.label)} network</span>
            <select
              class="${orClasses.methodNetwork}"
              aria-label="${escapeHtml(group.label)} network"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork}="${escapeHtml(groupKey)}"
            >
              ${group.options
                .map((option) => {
                  const optionLimit = elementsSwapLimitMessage(option, view);
                  const label =
                    option.available === false && optionLimit !== undefined
                      ? `${option.network_label} · ${optionLimit}`
                      : option.network_label;
                  return `<option
                    value="${escapeHtml(option.pay_in_asset)}"
                    ${option.pay_in_asset === selectedOption.pay_in_asset ? "selected" : ""}
                    ${option.available === false ? "disabled" : ""}
                  >${escapeHtml(label)}</option>`;
                })
                .join("")}
            </select>
          </label>
          <button
            part="method-confirm"
            class="${orClasses.methodConfirm}"
            ${disabled ? "" : `${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart}="${escapeHtml(selectedOption.pay_in_asset)}"`}
            ${disabled ? "disabled aria-disabled=\"true\"" : ""}
            type="button"
          >${escapeHtml(disabled && limitMessage !== undefined ? limitMessage : "Continue")}</button>
        </div>
      `;
    })
    .join("");
}

// Short reason for an out-of-range swap asset in the web-component surface,
// mirroring the React wizard's fiat message.
function elementsSwapLimitMessage(
  option: OpenReceiveElementsSwapOption,
  view: OpenReceiveElementsWizardView
): string | undefined {
  if (option.available !== false) return undefined;
  const checkout =
    view.amountMsats === undefined
      ? undefined
      : {
          amount_msats: view.amountMsats,
          ...(view.fiat?.currency === undefined || view.fiat.value === undefined
            ? {}
            : { fiat: { currency: view.fiat.currency, value: view.fiat.value } })
        };
  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.minimum_invoice_amount_msats);
    if (fiat !== undefined) return `Minimum payment ${fiat}`;
    if (option.minimum_pay_amount !== undefined) {
      return `Minimum ${option.minimum_pay_amount} ${option.label}`;
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.maximum_invoice_amount_msats);
    if (fiat !== undefined) return `Maximum payment ${fiat}`;
    if (option.maximum_pay_amount !== undefined) {
      return `Maximum ${option.maximum_pay_amount} ${option.label}`;
    }
  }
  return option.unavailable_message;
}

function renderElementSwapPanelHtml(invoice: CheckoutInvoiceSnapshot): string {
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
        ${heading}
        <p part="swap-progress" class="${orClasses.swapProgress}">Preparing payment address.</p>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "deposit") {
    const feeBreakdown = renderElementSwapFeeBreakdownHtml(display.feeBreakdown);
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        <p part="swap-instruction" class="${orClasses.swapInstruction}">Pay <strong>${escapeHtml(display.depositAmount)} ${escapeHtml(display.assetLabel)}</strong> to this address</p>
        <div part="swap-qr" class="${orClasses.swapQr}" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr}="${escapeHtml(display.qrPayload)}"></div>
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${renderElementSwapCopyDetailHtml("Address", display.depositAddress)}
          ${display.depositMemo === undefined ? "" : renderElementSwapCopyDetailHtml("Memo", display.depositMemo)}
          ${renderElementSwapCopyDetailHtml("Amount", display.depositAmount)}
        </dl>
        ${heading}
        ${feeBreakdown}
        <p part="swap-warning" class="${orClasses.swapWarning}">${escapeHtml(display.networkWarning)}</p>
        <p part="swap-countdown" class="${orClasses.swapCountdown}">Payment window <strong>${escapeHtml(display.countdownLabel)}</strong></p>
        <p part="swap-warning" class="${orClasses.swapWarning}">Pay with one method only. If you already sent ${escapeHtml(display.assetLabel)}, do not also pay the Lightning invoice.</p>
        ${backButton}
      </section>
    `;
  }

  if (display.state === "settled") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.providerOrderId === undefined ? "" : renderElementSwapCopyDetailHtml("Provider order", display.providerOrderId)}
        </dl>
      </section>
    `;
  }

  if (display.state === "progress") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
        </dl>
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
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <p part="swap-warning" class="${orClasses.swapWarning}">Use a ${escapeHtml(display.networkLabel)} address you control. Do not paste the deposit address.</p>
        ${stagedRefundAddress === undefined ? `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
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
            <button class="${orClasses.btn}" type="submit">Review refund address</button>
          </form>
        ` : `
          <form
            part="swap-refund"
            class="${orClasses.swapRefund}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm}="${escapeHtml(display.attemptId)}"
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
        `}
        ${supportDetails}
      </section>
    `;
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    return `
      <section part="swap-panel" class="${orClasses.swapPanel}">
        ${heading}
        <dl part="swap-details" class="${orClasses.swapDetails}">
          ${display.refundAddress === undefined ? "" : renderElementSwapCopyDetailHtml("Refund address", display.refundAddress)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId)}
        </dl>
        ${supportDetails}
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

function renderElementSwapCopyDetailHtml(label: string, value: string): string {
  return `
    <dt class="${orClasses.swapDetailsDt}">${escapeHtml(label)}</dt>
    <dd class="${orClasses.swapDetailsDd}">
      <code class="${orClasses.swapDetailsCode}">${escapeHtml(value)}</code>
      <button
        part="swap-copy"
        class="${orClasses.btnSm}"
        ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy}="${escapeHtml(value)}"
        type="button"
      >Copy</button>
    </dd>
  `;
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
      <p part="swap-breakdown-note" class="${orClasses.swapBreakdownNote}">The swap provider's exchange rate and network fees are included in the amount above.</p>
    </div>
  `;
}

function renderElementSwapSupportDetailsHtml(
  display: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>
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
          ${display.depositTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Deposit transaction", display.depositTxId)}
          ${display.payoutTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Lightning payout", display.payoutTxId)}
          ${display.refundTxId === undefined ? "" : renderElementSwapCopyDetailHtml("Refund transaction", display.refundTxId)}
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
  const routeLabel = options.selectedRoute === null || options.routeAssets.length <= 1
    ? null
    : options.routeAssets.find((asset) => asset.id === options.selectedRoute)?.label ?? options.selectedRoute;

  return `
    <nav part="wizard-breadcrumbs" class="${orClasses.breadcrumbs}" aria-label="Payment path">
      <button
        part="wizard-breadcrumb"
        class="${orClasses.btnGhost}"
        ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="method"
        type="button"
      >
        <span>${escapeHtml(openReceiveCheckoutLabels.paymentMethod)}</span>
      </button>
      <span part="wizard-breadcrumb-separator" aria-hidden="true">/</span>
      ${routeLabel === null
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
        `}
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
  copied: boolean
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
  const body = stepIndex === 0
    ? `
        <div part="tutorial-intro" class="${orClasses.tutorialIntro}">
          <img part="tutorial-provider-logo" alt="" src="${escapeHtml(provider.icon)}" class="${orClasses.tutorialProviderLogo}">
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroPrefix)} ${escapeHtml(provider.name)}.</p>
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroCopy)}</p>
          <button part="tutorial-copy" class="${orClasses.tutorialCopy}" type="button">${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>
          ${copied
            ? `<p part="tutorial-copy-message" class="${orClasses.tutorialCopyMessage}">${escapeHtml(openReceiveCheckoutLabels.tutorialCopiedContinue)}</p>`
            : ""}
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
          ${Array.from({ length: totalSteps }, (_, index) => `
            <span part="${index === stepIndex ? "tutorial-step-active" : "tutorial-step"}" class="${index === stepIndex ? orClasses.tutorialStepActive : orClasses.tutorialStep}"></span>
          `).join("")}
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

function renderCountrySelectHtml(options: {
  readonly countries: ReturnType<typeof createOpenReceivePaymentWizardModel>["countryDisplays"];
  readonly selectedCountryCode: string;
}): string {
  return `
    <label part="country-select" class="${orClasses.countrySelect}">
      <span class="${orClasses.countrySelectLabel}">${escapeHtml(openReceiveCheckoutLabels.chooseCountry)}</span>
      <select ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country}="${escapeHtml(options.selectedCountryCode)}" class="${orClasses.countrySelectControl}">
        ${options.countries.map((country) => `
          <option
            value="${escapeHtml(country.code)}"
            ${country.code === options.selectedCountryCode ? "selected" : ""}
          >${escapeHtml(country.label)}</option>
        `).join("")}
      </select>
    </label>
  `;
}

function createElementCheckoutState(
  view: CheckoutView
): CheckoutState | undefined {
  if (view.invoice_id === undefined) return undefined;
  return createCheckoutStateFromDisplayData({
    ...view,
    rail: view.rail ?? "lightning",
    ...(view.status === undefined
      ? {}
      : { transaction_state: transactionStateFromStatus(view.status) })
  });
}

function transactionStateFromStatus(status: Status): string {
  if (status === "settled") return "settled";
  if (status === "expired") return "expired";
  if (status === "failed") return "failed";
  return "pending";
}

function parseElementStatus(value: string | null): Status | undefined {
  if (
    value === "pending" ||
    value === "settled" ||
    value === "expired" ||
    value === "failed"
  ) {
    return value;
  }
  return undefined;
}

function renderElementPaymentStatusHtml(state: CheckoutState): string {
  const status = createCheckoutStatusModel(state);
  const countdown =
    status.countdownLabel === undefined
      ? ""
      : `<small part="countdown" class="${orClasses.countdown}">${escapeHtml(status.countdownPrefix)} <strong class="${orClasses.countdownStrong}">${escapeHtml(status.countdownLabel)}</strong></small>`;

  return `
    <div part="status" class="${orClasses.paymentStatus}">
      ${status.waiting ? `<span part="spinner" class="${orClasses.spinner}" aria-hidden="true"></span>` : ""}
      <div class="${orClasses.paymentStatusBody}">
        <strong class="${orClasses.paymentStatusTitle}">${escapeHtml(status.title)}</strong>
        <p class="${orClasses.paymentStatusDetail}">${escapeHtml(status.detail)}</p>
        ${countdown}
      </div>
    </div>
  `;
}

export function defineOpenReceiveElements(
  options: DefineOpenReceiveElementsOptions = {}
): void {
  const registry = options.registry ?? globalThis.customElements;
  const HTMLElementCtor = globalThis.HTMLElement;
  const tagName = options.tagName ?? DEFAULT_TAG_NAME;
  const themeToggleTagName =
    options.themeToggleTagName ?? OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;

  if (registry === undefined || HTMLElementCtor === undefined) {
    throw new Error("Custom elements are unavailable in this environment.");
  }

  class CheckoutElement extends HTMLElementCtor {
    private selection = createOpenReceivePaymentWizardSelection({
      storedCountryCode: readOpenReceiveStoredCountryCode(),
      defaultCountryCode: getOpenReceiveDefaultCountryCode()
    });
    private activeTutorialProviderId: string | null = null;
    private activeTutorialIndex = 0;
    private activeTutorialCopied = false;
    private swapOptions: readonly OpenReceiveElementsSwapOption[] = [];
    private selectedSwapNetworks: Record<string, string> = {};
    private selectedSwapAsset: string | null = null;
    private startedSwapInvoice: CheckoutInvoiceSnapshot | undefined;
    private latestCheckoutSnapshot: CheckoutSnapshot | undefined;
    private dismissedSwapInvoiceId: string | null = null;
    private controller: CheckoutController | undefined;
    private announcedSettledOrderId: string | undefined;
    // Create-mode bookkeeping: `createdKey` is `${prefix}::${orderId}` so a create runs once
    // per order/prefix and re-runs when either changes; `creating` guards against overlap;
    // `applyingCreatedAttributes` suppresses attributeChangedCallback while the created
    // snapshot's attributes are applied in bulk.
    private creating = false;
    private createdKey: string | undefined;
    private applyingCreatedAttributes = false;

    static get observedAttributes() {
      return [
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard
      ];
    }

    connectedCallback() {
      this.render();
      if (this.isCreateMode()) {
        void this.createCheckout();
        return;
      }
      this.startCheckoutController();
    }

    attributeChangedCallback() {
      if (!this.isConnected || this.applyingCreatedAttributes) return;
      if (this.isCreateMode()) {
        this.render();
        void this.createCheckout();
        return;
      }
      this.render();
      this.startCheckoutController();
    }

    disconnectedCallback() {
      this.stopCheckoutController();
    }

    // Create mode: an `order-id` is set but no `invoice` snapshot is provided. The element
    // owns the whole lifecycle — it creates the checkout against `${prefix}/checkouts`, then
    // polls status and drives swaps against `${prefix}/orders/${order-id}`.
    private isCreateMode(): boolean {
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      return (invoice === null || invoice === "") && orderId !== null && orderId.length > 0;
    }

    private async createCheckout(): Promise<void> {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (orderId === null || orderId.length === 0) return;
      const prefix =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ?? OPENRECEIVE_DEFAULT_PREFIX;
      const key = `${prefix}::${orderId}`;
      if (this.creating || this.createdKey === key) return;
      this.creating = true;
      this.createdKey = key;

      try {
        const checkout = await requestCheckout({ prefix, orderId, fetch: globalThis.fetch });
        this.handleControllerSnapshot(checkout);
        const orderUrl = resolveOrderUrlFromPrefix(prefix, orderId);
        // Populate the invoice/order-url attributes from the created snapshot so the existing
        // attribute-driven rendering + controller machinery takes over. Suppress
        // attributeChangedCallback during the bulk apply, then render and start once.
        this.applyingCreatedAttributes = true;
        applyCheckoutElementAttributes(this, createCheckoutElementAttributes(checkout, { orderUrl }));
        this.applyingCreatedAttributes = false;
        this.render();
        this.startCheckoutController();
      } catch (error) {
        // Allow a later attribute change (or reconnection) to retry the create.
        this.createdKey = undefined;
        this.dispatchError(error);
      } finally {
        this.creating = false;
      }
    }

    private handleControllerSnapshot(snapshot: CheckoutSnapshot): void {
      this.latestCheckoutSnapshot = snapshot;
      // Payable assets ride on the order object itself (payment_methods).
      this.swapOptions = snapshot.payment_methods ?? [];
      const swapInvoice = snapshot.invoices.find(
        (invoice) => invoice.rail === "swap" && invoice.swap !== undefined
      );
      if (swapInvoice !== undefined) {
        this.startedSwapInvoice = swapInvoice;
      }
      this.render();
    }

    render() {
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      if (invoice === null || invoice === "") {
        if (this.isCreateMode()) {
          const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
          root.innerHTML = renderCheckoutCreatingHtml(
            parseOpenReceiveResolvedTheme(
              this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme)
            )
          );
          return;
        }
        this.replaceChildren();
        return;
      }

      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = renderCheckoutHtml({
        invoice_id: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId) ?? undefined,
        invoice,
        rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
        payment_hash: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined,
        amount_msats: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats),
          { label: "amount-msats" }
        ),
        fiat_quote: readElementFiatQuote(this),
        status: parseElementStatus(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status)
        ),
        expires_at: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt),
          { label: "expires-at" }
        ),
        theme: parseOpenReceiveResolvedTheme(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme)),
        payment_wizard: parseOpenReceiveBooleanAttribute(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard)),
        wizard: {
          selectedMethod: this.selection.selectedMethod,
          selectedCountryCode: this.selection.selectedCountryCode,
          selectedBitcoinRoute: this.selection.selectedBitcoinRoute,
          selectedCryptoRoute: this.selection.selectedCryptoRoute,
          selectedRegion: this.selection.selectedRegion,
          countryPickerOpen: this.selection.countryPickerOpen,
          swapOptions: this.swapOptions,
          selectedSwapNetworks: this.selectedSwapNetworks,
          selectedSwapAsset: this.selectedSwapAsset,
          ...(this.latestCheckoutSnapshot?.amount_msats === undefined
            ? {}
            : { amountMsats: this.latestCheckoutSnapshot.amount_msats }),
          ...(this.latestCheckoutSnapshot?.fiat === undefined
            ? {}
            : { fiat: this.latestCheckoutSnapshot.fiat }),
          swapInvoice: this.currentSwapInvoice(),
          activeTutorialProviderId: this.activeTutorialProviderId,
          activeTutorialIndex: this.activeTutorialIndex,
          activeTutorialCopied: this.activeTutorialCopied
        }
      });

      const copyButton = root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.copy);
      copyButton?.addEventListener("click", () => {
        void (this.controller?.copyInvoice() ?? copyInvoice({ invoice, logger: options.logger }))
          .then(() => {
            showElementCopyFeedback(copyButton);
            this.dispatchEvent(
              createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy)
            );
          })
          .catch((error) => this.dispatchError(error));
      });

      root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.open)?.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          this.controller?.openWallet() ?? openWallet({ invoice, logger: options.logger });
          this.dispatchEvent(
            createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet)
          );
        } catch (error) {
          this.dispatchError(error);
        }
      });

      root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.startOver)?.addEventListener("click", () => {
        this.dispatchEvent(
          createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver)
        );
      });

      const qrTarget = root.querySelector(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr);
      if (qrTarget !== null) {
        void createQrSvg(invoice, {
          encoder: options.qrEncoder,
          width: 256
        })
          .then((svg) => {
            const qr = root.querySelector(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr);
            if (qr !== null) qr.innerHTML = svg;
          })
          .catch((error) => this.dispatchError(error));
      }

      this.bindWizard(root, invoice, options.logger);
      this.renderSwapQrCodes(root);
    }

    private startCheckoutController(): void {
      const snapshot = this.currentCheckoutSnapshot();
      const orderUrl = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl);
      if (snapshot === undefined) {
        this.stopCheckoutController();
        return;
      }

      this.stopCheckoutController();
      this.controller = createCheckoutController({
        snapshot,
        ...(orderUrl === null
          ? {}
          : { orderUrl }),
        logger: options.logger,
        onError: (error) => this.dispatchError(error),
        onState: (nextState) => this.applyCheckoutState(nextState),
        onSnapshot: (snapshot) => this.handleControllerSnapshot(snapshot)
      });
      this.controller.start();
      void this.controller.reloadState().catch((error) => this.dispatchError(error));
    }

    private stopCheckoutController(): void {
      this.controller?.stop();
      this.controller = undefined;
    }

    private currentCheckoutSnapshot(): CheckoutSnapshot | undefined {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      const invoiceId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId);
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      if (invoiceId === null || invoice === null) return undefined;
      const amountMsats = parseOpenReceiveOptionalInteger(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats),
        { label: "amount-msats" }
      );
      const expiresAt = parseOpenReceiveOptionalInteger(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt),
        { label: "expires-at" }
      );
      return createCheckoutSnapshotFromDisplayData({
        ...(orderId === null ? {} : { order_id: orderId }),
        invoice_id: invoiceId,
        invoice,
        rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
        ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) === null
          ? {}
          : { payment_hash: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined }),
        ...(amountMsats === undefined ? {} : { amount_msats: amountMsats }),
        ...(readElementFiatQuote(this) === undefined ? {} : { fiat_quote: readElementFiatQuote(this) }),
        transaction_state: transactionStateFromStatus(
          parseElementStatus(
            this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status)
          ) ?? "pending"
        ),
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      });
    }

    private applyCheckoutState(state: CheckoutState): void {
      this.setAttributeIfChanged(
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status,
        deriveStatus(state)
      );
      if (state.expires_at !== undefined) {
        this.setAttributeIfChanged(
          OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
          String(state.expires_at)
        );
      }
      this.render();
      this.dispatchEvent(
        createCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state, state)
      );
      if (state.settled && state.order_id !== this.announcedSettledOrderId) {
        this.announcedSettledOrderId = state.order_id;
        this.dispatchEvent(
          createCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled, state)
        );
      }
    }

    private setAttributeIfChanged(name: string, value: string): void {
      if (this.getAttribute(name) !== value) this.setAttribute(name, value);
    }

    private bindWizard(
      root: ShadowRoot,
      invoice: string,
      logger: OpenReceiveBrowserLogger | undefined
    ): void {
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.method).forEach((button) => {
        button.addEventListener("click", () => {
          const method = parseOpenReceivePaymentMethod(
            button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method)
          );
          if (method === null) return;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_method",
            method,
            storedCountryCode: method === "card" || method === "bank"
              ? readOpenReceiveStoredCountryCode()
              : undefined
          });
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.breadcrumb).forEach((button) => {
        button.addEventListener("click", () => {
          const target = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb);
          if (target === "swap-asset") {
            this.selectedSwapAsset = null;
            this.render();
            return;
          }
          if (target === "method") {
            this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
              type: "change_method"
            });
            this.render();
            return;
          }
          if (target === "route") {
            this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
              type: "change_route"
            });
            this.render();
          }
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.region).forEach((button) => {
        button.addEventListener("click", () => {
          const region = parseOpenReceiveRegion(
            button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.region)
          );
          if (region === null) return;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_region",
            region
          });
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.country).forEach((button) => {
        const selectCountry = (): void => {
          const countryCode = button instanceof HTMLSelectElement
            ? button.value
            : button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country);
          if (countryCode === null) return;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_country",
            countryCode
          });
          writeOpenReceiveStoredCountryCode(countryCode, {
            storageKey: OPENRECEIVE_COUNTRY_STORAGE_KEY
          });
          this.render();
        };
        if (button instanceof HTMLSelectElement) {
          button.addEventListener("change", selectCountry);
          return;
        }
        button.addEventListener("click", selectCountry);
        button.addEventListener("keydown", (event) => {
          if (!(event instanceof KeyboardEvent)) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selectCountry();
        });
      });

      root.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.switchCountry)?.addEventListener("click", () => {
        this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
          type: "open_country_picker"
        });
        this.render();
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.route).forEach((button) => {
        button.addEventListener("click", () => {
          const route = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.route);
          if (route === null) return;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_route",
            route
          });
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapStart).forEach((button) => {
        button.addEventListener("click", () => {
          const payInAsset = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart);
          if (payInAsset === null) return;
          this.selectedSwapAsset = payInAsset;
          void this.startSwap(payInAsset);
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapNetwork).forEach((select) => {
        if (!(select instanceof HTMLSelectElement)) return;
        select.addEventListener("change", () => {
          const groupKey = select.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork);
          if (groupKey === null || groupKey.length === 0) return;
          this.selectedSwapNetworks = {
            ...this.selectedSwapNetworks,
            [groupKey]: select.value,
          };
          this.render();
        });
      });

      root.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapBack)?.addEventListener("click", () => {
        const current = this.currentSwapInvoice();
        this.dismissedSwapInvoiceId = current?.invoice_id ?? null;
        this.selectedSwapAsset = null;
        this.render();
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopy).forEach((button) => {
        button.addEventListener("click", () => {
          const value = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy);
          if (value === null) return;
          void globalThis.navigator?.clipboard?.writeText(value)
            .then(() => showElementCopyFeedback(button))
            .catch((error) => this.dispatchError(error));
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundForm).forEach((form) => {
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const attemptId = form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm);
          const refundNonce = form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce);
          const confirm =
            form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm) === "true";
          const input = form.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundAddress);
          const refundAddress = input instanceof HTMLInputElement ? input.value.trim() : "";
          if (attemptId === null || refundNonce === null || refundAddress.length === 0) return;
          void this.refundSwap(attemptId, refundAddress, refundNonce, confirm);
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerTutorial).forEach((button) => {
        button.addEventListener("click", () => {
          const providerId = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial);
          if (providerId === null) return;
          if (providerId === "") {
            this.activeTutorialProviderId = null;
            this.activeTutorialIndex = 0;
            this.activeTutorialCopied = false;
            this.render();
            return;
          }
          const index = Number(
            button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex) ?? "0"
          );
          if (this.activeTutorialProviderId !== providerId) {
            this.activeTutorialCopied = false;
          }
          this.activeTutorialProviderId = providerId;
          this.activeTutorialIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
          this.render();
        });
      });

      root.querySelector('[part="tutorial-copy"]')?.addEventListener("click", () => {
        void copyInvoice({ invoice, logger })
          .then(() => {
            this.activeTutorialCopied = true;
            if (this.activeTutorialProviderId !== null) {
              this.dispatchEvent(createCheckoutProviderCopyEvent(this.activeTutorialProviderId));
            }
            this.dispatchEvent(
              createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy)
            );
            this.render();
          })
          .catch((error) => this.dispatchError(error));
      });

      const tutorial = root.querySelector('[part="tutorial"]');
      tutorial?.addEventListener("click", (event) => {
        if (event.target !== event.currentTarget) return;
        this.activeTutorialProviderId = null;
        this.activeTutorialIndex = 0;
        this.activeTutorialCopied = false;
        this.render();
      });
      tutorial?.addEventListener("keydown", (event) => {
        if (!(event instanceof KeyboardEvent)) return;
        if (event.key !== "Escape" || this.activeTutorialProviderId === null) return;
        this.activeTutorialProviderId = null;
        this.activeTutorialIndex = 0;
        this.activeTutorialCopied = false;
        this.render();
      });
      if (tutorial instanceof HTMLElement) tutorial.focus();
    }

    private async startSwap(payInAsset: string): Promise<void> {
      const url = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl);
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (url === null || orderId === null || orderId.length === 0) return;

      try {
        const body = await postOpenReceiveJson(globalThis.fetch, url, {
          order_id: orderId,
          action: "start_swap",
          pay_in_asset: payInAsset
        });
        this.startedSwapInvoice = normalizeSwapStartInvoice(body);
        this.dismissedSwapInvoiceId = null;
        this.render();
      } catch (error) {
        this.dispatchError(error);
      }
    }

    private async refundSwap(
      attemptId: string,
      refundAddress: string,
      refundNonce: string,
      confirm: boolean
    ): Promise<void> {
      const url = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl);
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (url === null) return;

      try {
        const body = await postOpenReceiveJson(globalThis.fetch, url, {
          ...(orderId === null ? {} : { order_id: orderId }),
          action: "refund_swap",
          attempt_id: attemptId,
          refund_address: refundAddress,
          refund_nonce: refundNonce,
          confirm
        });
        this.startedSwapInvoice = normalizeSwapStartInvoice(body);
        this.dismissedSwapInvoiceId = null;
        this.render();
      } catch (error) {
        this.dispatchError(error);
      }
    }

    private currentSwapInvoice(): CheckoutInvoiceSnapshot | undefined {
      const fromSnapshot = this.latestCheckoutSnapshot?.invoices.find((invoice) =>
        invoice.rail === "swap" &&
        invoice.swap !== undefined &&
        invoice.invoice_id !== this.dismissedSwapInvoiceId
      );
      if (this.startedSwapInvoice === undefined || this.startedSwapInvoice.invoice_id === this.dismissedSwapInvoiceId) {
        return fromSnapshot;
      }
      return this.latestCheckoutSnapshot?.invoices.find((invoice) =>
        invoice.invoice_id === this.startedSwapInvoice?.invoice_id
      ) ?? this.startedSwapInvoice;
    }

    private renderSwapQrCodes(root: ShadowRoot): void {
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapQr).forEach((target) => {
        const payload = target.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr);
        if (payload === null) return;
        void createQrPayloadSvg(payload, {
          encoder: options.qrEncoder,
          width: 220
        })
          .then((svg) => {
            target.innerHTML = svg;
          })
          .catch((error) => this.dispatchError(error));
      });
    }

    private dispatchError(error: unknown): void {
      this.dispatchEvent(createCheckoutErrorEvent(error));
    }
  }

  class OpenReceiveThemeToggleElement extends HTMLElementCtor {
    private observer: MutationObserver | undefined;

    static get observedAttributes() {
      return [
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey
      ];
    }

    connectedCallback() {
      this.render();
      this.startObserver();
      this.syncTheme();
    }

    attributeChangedCallback() {
      if (!this.isConnected) return;
      this.render();
      this.syncTheme();
    }

    disconnectedCallback() {
      this.observer?.disconnect();
      this.observer = undefined;
    }

    render() {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const theme = this.syncTheme();
      root.innerHTML = renderOpenReceiveThemeToggleHtml(theme.toggleLabel, theme.resolvedTheme);
      root.querySelector(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS.button)?.addEventListener("click", () => {
        const nextTheme = toggleOpenReceiveStoredThemeControls(this.themeTargets(), this.themeOptions());
        this.setAttributeIfChanged(
          OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
          nextTheme.resolvedTheme
        );
        this.dispatchEvent(createOpenReceiveThemeChangeEvent(nextTheme));
        this.render();
      });
    }

    private syncTheme() {
      const theme = syncOpenReceiveStoredThemeControls(this.themeTargets(), this.themeOptions());
      this.setAttributeIfChanged(
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
        theme.resolvedTheme
      );
      return theme;
    }

    private startObserver(): void {
      if (this.observer !== undefined) return;
      const MutationObserverCtor = globalThis.MutationObserver;
      if (MutationObserverCtor === undefined || this.ownerDocument.body === null) return;
      this.observer = new MutationObserverCtor(() => {
        this.syncTheme();
      });
      this.observer.observe(this.ownerDocument.body, {
        childList: true,
        subtree: true
      });
    }

    private themeTargets() {
      const rootSelector = this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector);
      const checkoutSelector = this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector);
      const button =
        this.shadowRoot?.querySelector(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS.button) ??
        null;
      return {
        root: rootSelector === null ? undefined : this.ownerDocument.querySelector(rootSelector),
        checkout: checkoutSelector === null ? undefined : this.ownerDocument.querySelector(checkoutSelector),
        toggle: button
      };
    }

    private themeOptions() {
      const defaultTheme = parseOpenReceiveThemePreference(
        this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme)
      );
      return {
        ...(defaultTheme === undefined ? {} : { defaultTheme }),
        ...(this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey) === null
          ? {}
          : {
            storageKey:
              this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey) ??
              undefined
          })
      };
    }

    private setAttributeIfChanged(name: string, value: string): void {
      if (this.getAttribute(name) !== value) this.setAttribute(name, value);
    }
  }

  if (registry.get(tagName) === undefined) {
    registry.define(tagName, CheckoutElement);
  }
  if (registry.get(themeToggleTagName) === undefined) {
    registry.define(themeToggleTagName, OpenReceiveThemeToggleElement);
  }
}

export const formatMsats = formatOpenReceiveMsats;

const elementCopyFeedbackControllers =
  new WeakMap<Element, ReturnType<typeof createOpenReceiveTransientFeedbackController<string>>>();
const escapeHtml = escapeOpenReceiveHtml;

function readElementFiatQuote(element: Element) {
  const currency = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency);
  const value = element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue);
  if (currency === null || value === null) return undefined;
  return {
    fiat: {
      currency,
      value
    }
  };
}

function parseElementRail(value: string | null): "lightning" | "swap" {
  if (value === "swap") return "swap";
  return "lightning";
}

function showElementCopyFeedback(button: Element | null): void {
  if (button === null) return;
  let controller = elementCopyFeedbackControllers.get(button);
  if (controller === undefined) {
    controller = createOpenReceiveTransientFeedbackController({
      resetValue: openReceiveCheckoutLabels.copyInvoice,
      onValue: (label) => {
        if (button.isConnected) button.textContent = label;
      }
    });
    elementCopyFeedbackControllers.set(button, controller);
  }
  controller.show(openReceiveCheckoutLabels.copied);
}
