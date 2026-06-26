import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_COUNTRY_STORAGE_KEY,
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
  copyInvoice,
  createCheckoutActionEvent,
  createCheckoutDisplayModel,
  createCheckoutController,
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
  createOpenReceiveWizardRouteAssetDisplays,
  createOpenReceiveWizardRouteDisplays,
  createQrSvg,
  escapeOpenReceiveHtml,
  formatOpenReceiveMsats,
  getOpenReceiveDefaultCountryCode,
  getOpenReceivePaymentMethodIcon,
  getOpenReceiveRegionForCountry,
  getOpenReceiveWizardEmptyMessage,
  openReceiveCheckoutLabels,
  openReceiveCheckoutElementStyles,
  openWallet,
  openReceivePaymentMethods,
  openReceiveThemeToggleElementStyles,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveRegion,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveThemePreference,
  readOpenReceiveStoredCountryCode,
  status as deriveStatus,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveStoredCountryCode,
  type CheckoutController,
  type CheckoutSnapshot,
  type CheckoutState,
  type OpenReceivePaymentWizardSelection,
  type OpenReceiveWizardProviderDisplay,
  type OpenReceiveWizardRouteAssetDisplay,
  type OpenReceiveWizardRouteDisplay,
  type Status
} from "@openreceive/browser/internal";

export interface CheckoutView {
  readonly invoice_id?: string;
  readonly invoice: string;
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
  readonly activeTutorialProviderId?: string | null;
  readonly activeTutorialIndex?: number;
  readonly activeTutorialCopied?: boolean;
}

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
}

const DEFAULT_TAG_NAME = "openreceive-checkout";
export { OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME } from "@openreceive/browser/internal";

export function renderCheckoutHtml(view: CheckoutView): string {
  const display = createCheckoutDisplayModel(view);
  const checkoutState = createElementCheckoutState(view);
  const amountLabel =
    display.amountLabel === undefined
      ? ""
      : `<span part="amount">${escapeHtml(display.amountLabel)}</span>`;
  const fiatLabel =
    display.fiatLabel === undefined
      ? ""
      : `<span part="amount">${escapeHtml(display.fiatLabel)}</span>`;
  const statusLabel = view.status ?? (
    checkoutState === undefined
      ? deriveStatus(view)
      : deriveStatus(checkoutState)
  );
  const stateLabel =
    `<span part="state" data-state="${escapeHtml(statusLabel)}">${escapeHtml(statusLabel)}</span>`;
  const status = checkoutState === undefined
    ? ""
    : renderElementPaymentStatusHtml(checkoutState);
  const statusModel = checkoutState === undefined
    ? undefined
    : createCheckoutStatusModel(checkoutState);
  const expired = statusModel?.phase === "expired";
  const wizard =
    expired || view.payment_wizard === false
      ? ""
      : renderOpenReceivePaymentWizardHtml(view.wizard);

  return `
    <style>${openReceiveCheckoutElementStyles}</style>
    <section part="root"${view.theme === undefined ? "" : ` data-theme="${escapeHtml(view.theme)}"`}>
      ${expired ? "" : `<div part="qr" ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr}></div>`}
      ${status}
      <div part="meta">${amountLabel}${fiatLabel}${stateLabel}</div>
      <div part="actions">
        ${expired
          ? `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.startOver}" type="button">${escapeHtml(openReceiveCheckoutLabels.startOver)}</button>`
          : `<button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.copy}" type="button">${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>`}
      </div>
      ${wizard}
    </section>
  `;
}

export function renderOpenReceiveThemeToggleHtml(
  label: string,
  resolvedTheme: "light" | "dark" = label.toLowerCase().includes("dark") ? "dark" : "light"
): string {
  return `
    <style>${openReceiveThemeToggleElementStyles}</style>
    <button
      aria-label="${escapeHtml(label)}"
      class="or-theme-toggle-${escapeHtml(resolvedTheme)}"
      part="${OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS.button}"
      title="${escapeHtml(label)}"
      type="button"
      ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle}
    >
      <span class="or-theme-toggle-track" aria-hidden="true">
        <span class="or-theme-toggle-icon or-theme-toggle-icon-light"></span>
      </span>
      <span class="or-theme-toggle-label">${escapeHtml(label)}</span>
    </button>
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
  const methodPicker = selection.selectedMethod === null
    ? `
      <div>
        <h2>${escapeHtml(openReceiveCheckoutLabels.wizardTitle)}</h2>
        <p>${escapeHtml(openReceiveCheckoutLabels.wizardSubtitle)}</p>
      </div>
      <div part="method-grid">
        ${openReceivePaymentMethods.map((method) => `
          <button
            part="method"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="${escapeHtml(method.id)}"
            type="button"
          >
            <img alt="" src="${escapeHtml(getOpenReceivePaymentMethodIcon(method.id))}">
            <strong>${escapeHtml(method.title)}</strong>
            <small>${escapeHtml(method.detail)}</small>
          </button>
        `).join("")}
      </div>
    `
    : "";

  return `
    <section part="wizard" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}>
      ${methodPicker}
      ${breadcrumbs}
      ${showRoutePicker ? `
        <div part="route-picker">
          ${routeAssetDisplays.map((asset) => `
              <button
                part="route${asset.selected ? " selected" : ""}"
                ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.route}="${escapeHtml(asset.id)}"
                type="button"
              >
                <img alt="" src="${escapeHtml(asset.icon)}">
                <strong>${escapeHtml(asset.label)}</strong>
                <small>${escapeHtml(asset.subtitle)}</small>
              </button>
            `).join("")}
        </div>
      ` : ""}
      ${selection.selectedMethod === null ? "" : `
        <div part="wizard-results">
          ${routeDisplays.length === 0 ? `
            <p part="wizard-empty">${
              escapeHtml(getOpenReceiveWizardEmptyMessage(selection.selectedMethod))
            }</p>
	          ` : routeDisplays.map((route) => `
	            <section part="wizard-route">
                <h3>
                  ${escapeHtml(route.title)}
                  ${wizard.selectedRail === null ? "" : renderCountrySelectHtml({
                    countries: model.countryDisplays,
                    selectedCountryCode: selection.selectedCountryCode
                  })}
                </h3>
              <div part="provider-grid">
                ${route.providers.map((provider) => `
                  <article part="provider${provider.recommended ? " selected" : ""}">
                    <div part="provider-heading">
                      <img alt="" src="${escapeHtml(provider.icon)}">
                      <h4>${escapeHtml(provider.name)}</h4>
                      ${provider.recommendedLabel === null ? "" : `<span part="recommended">${escapeHtml(provider.recommendedLabel)}</span>`}
	                    </div>
                    <p part="provider-kind">${escapeHtml(provider.kind)}</p>
	                    <div part="provider-actions">
                      ${renderProviderOpenActionHtml(provider)}
                    </div>
                  </article>
                `).join("")}
              </div>
            </section>
          `).join("")}
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
    <nav part="wizard-breadcrumbs" aria-label="Payment path">
      <button
        part="wizard-breadcrumb"
        ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="method"
        type="button"
      >
        <span>${escapeHtml(openReceiveCheckoutLabels.paymentMethod)}</span>
      </button>
      <span part="wizard-breadcrumb-separator" aria-hidden="true">/</span>
      ${routeLabel === null
        ? `<span part="wizard-breadcrumb-current">${escapeHtml(methodLabel)}</span>`
        : `
          <button
            part="wizard-breadcrumb"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb}="route"
            type="button"
          >
            <span>${escapeHtml(methodLabel)}</span>
          </button>
          <span part="wizard-breadcrumb-separator" aria-hidden="true">/</span>
          <span part="wizard-breadcrumb-current">${escapeHtml(routeLabel)}</span>
        `}
    </nav>
  `;
}

function renderProviderOpenActionHtml(provider: OpenReceiveWizardProviderDisplay): string {
  if (provider.tutorials.length === 0) {
    return `<a href="${escapeHtml(provider.url)}" rel="noreferrer" target="_blank">${escapeHtml(provider.openLabel)}</a>`;
  }

  return `
    <button
      part="provider-open"
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
        <div part="tutorial-intro">
          <img part="tutorial-provider-logo" alt="" src="${escapeHtml(provider.icon)}">
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroPrefix)} ${escapeHtml(provider.name)}.</p>
          <p>${escapeHtml(openReceiveCheckoutLabels.tutorialIntroCopy)}</p>
          <button part="tutorial-copy" type="button">${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>
          ${copied
            ? `<p part="tutorial-copy-message">${escapeHtml(openReceiveCheckoutLabels.tutorialCopiedContinue)}</p>`
            : ""}
        </div>
      `
    : `
        <div part="tutorial-frame">
          <img part="tutorial-image" alt="${escapeHtml(tutorial?.caption ?? "")}" src="${escapeHtml(tutorial?.image ?? "")}">
        </div>
        <p part="tutorial-caption">${escapeHtml(tutorial?.caption ?? "")}</p>
      `;

  return `
    <div part="tutorial" role="dialog" aria-modal="true" aria-label="${escapeHtml(openReceiveCheckoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}" tabindex="-1">
      <div part="tutorial-dialog">
        <div part="tutorial-header">
          <div part="tutorial-title">
            <img part="tutorial-header-logo" alt="" src="${escapeHtml(provider.icon)}">
            <h3>${escapeHtml(openReceiveCheckoutLabels.tutorialTitlePrefix)} ${escapeHtml(provider.name)}</h3>
          </div>
          <button
            part="tutorial-close"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}=""
            type="button"
            aria-label="Close"
          >X</button>
        </div>
        ${body}
        <div part="tutorial-steps" aria-hidden="true">
          ${Array.from({ length: totalSteps }, (_, index) => `
            <span part="${index === stepIndex ? "tutorial-step-active" : "tutorial-step"}"></span>
          `).join("")}
        </div>
        <p part="tutorial-progress">Step ${stepIndex + 1} of ${totalSteps}</p>
        <div part="tutorial-controls">
          <button
            part="tutorial-nav"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial}="${escapeHtml(provider.id)}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex}="${previousIndex}"
            type="button"
            ${stepIndex === 0 ? "disabled" : ""}
          >Back</button>
          <button
            part="tutorial-nav"
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
    <label part="country-select">
      <span>${escapeHtml(openReceiveCheckoutLabels.chooseCountry)}</span>
      <select ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country}="${escapeHtml(options.selectedCountryCode)}">
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
      : `<small part="countdown">${escapeHtml(status.countdownPrefix)} <strong>${escapeHtml(status.countdownLabel)}</strong></small>`;

  return `
    <div part="status">
      ${status.waiting ? `<span part="spinner" aria-hidden="true"></span>` : ""}
      <div>
        <strong>${escapeHtml(status.title)}</strong>
        <p>${escapeHtml(status.detail)}</p>
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
    private controller: CheckoutController | undefined;
    private announcedSettledPaymentHash: string | undefined;

    static get observedAttributes() {
      return [
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.lookupUrl,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard
      ];
    }

    connectedCallback() {
      this.render();
      this.startCheckoutController();
    }

    attributeChangedCallback() {
      if (!this.isConnected) return;
      this.render();
      this.startCheckoutController();
    }

    disconnectedCallback() {
      this.stopCheckoutController();
    }

    render() {
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      if (invoice === null || invoice === "") {
        this.replaceChildren();
        return;
      }

      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      root.innerHTML = renderCheckoutHtml({
        invoice_id: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId) ?? undefined,
        invoice,
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
    }

    private startCheckoutController(): void {
      const snapshot = this.currentCheckoutSnapshot();
      const lookupUrl = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.lookupUrl);
      if (snapshot === undefined) {
        this.stopCheckoutController();
        return;
      }

      this.stopCheckoutController();
      this.controller = createCheckoutController({
        snapshot,
        ...(lookupUrl === null
          ? {}
          : { lookupUrl }),
        logger: options.logger,
        onError: (error) => this.dispatchError(error),
        onState: (nextState) => this.applyCheckoutState(nextState)
      });
      this.controller.start();
    }

    private stopCheckoutController(): void {
      this.controller?.stop();
      this.controller = undefined;
    }

    private currentCheckoutSnapshot(): CheckoutSnapshot | undefined {
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
        invoice_id: invoiceId,
        invoice,
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
      if (state.settled && state.payment_hash !== this.announcedSettledPaymentHash) {
        this.announcedSettledPaymentHash = state.payment_hash;
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
