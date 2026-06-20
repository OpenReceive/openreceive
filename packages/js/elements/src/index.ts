import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_COUNTRY_MAP_VIEW_BOX,
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
  createOpenReceiveCheckoutActionEvent,
  createOpenReceiveCheckoutDisplayModel,
  createOpenReceiveCheckoutController,
  createOpenReceiveCheckoutErrorEvent,
  createOpenReceiveCheckoutStatusModel,
  createOpenReceiveCheckoutSnapshotFromDisplayData,
  createOpenReceiveCheckoutStateFromDisplayData,
  createOpenReceiveCheckoutStateEvent,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceiveProviderCopyEvent,
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
  openReceiveCountryMapRegions,
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
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  updateOpenReceivePaymentWizardSelection,
  writeOpenReceiveStoredCountryCode,
  type OpenReceiveCheckoutController,
  type OpenReceiveCheckoutSnapshot,
  type OpenReceiveCheckoutState,
  type OpenReceivePaymentWizardSelection
} from "@openreceive/browser";

export { parseOpenReceiveInvoiceEvent } from "@openreceive/browser";
export type { OpenReceiveInvoiceEventPayload } from "@openreceive/browser";

export interface OpenReceiveCheckoutView {
  readonly invoice_id?: string;
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly expires_at?: number;
  readonly checkout?: {
    readonly events_url?: string;
  };
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
}

export interface DefineOpenReceiveElementsOptions {
  readonly tagName?: string;
  readonly themeToggleTagName?: string;
  readonly registry?: CustomElementRegistry;
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
}

const DEFAULT_TAG_NAME = "openreceive-checkout";
export { OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME } from "@openreceive/browser";

export function renderOpenReceiveCheckoutHtml(view: OpenReceiveCheckoutView): string {
  const display = createOpenReceiveCheckoutDisplayModel(view);
  const checkoutState = createElementCheckoutState(view);
  const amountLabel =
    display.amountLabel === undefined
      ? ""
      : `<span part="amount">${escapeHtml(display.amountLabel)}</span>`;
  const transactionStateLabel =
    checkoutState?.transaction_state ?? display.transactionStateLabel;
  const stateLabel =
    transactionStateLabel === undefined
      ? ""
      : `<span part="state" data-state="${escapeHtml(transactionStateLabel)}">${escapeHtml(transactionStateLabel)}</span>`;
  const paymentHash =
    display.paymentHashLabel === undefined
      ? ""
      : `<code part="payment-hash">${escapeHtml(display.paymentHashLabel)}</code>`;
  const status = checkoutState === undefined
    ? ""
    : renderElementPaymentStatusHtml(checkoutState);
  const wizard =
    view.payment_wizard === false ? "" : renderOpenReceivePaymentWizardHtml(view.wizard);

  return `
    <style>${openReceiveCheckoutElementStyles}</style>
    <section part="root"${view.theme === undefined ? "" : ` data-theme="${escapeHtml(view.theme)}"`}>
      <div part="qr" ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr}></div>
      ${status}
      <div part="meta">${amountLabel}${stateLabel}${paymentHash}</div>
      <textarea part="invoice" readonly>${escapeHtml(view.invoice)}</textarea>
      <div part="actions">
        <button part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.copy}" type="button">${escapeHtml(openReceiveCheckoutLabels.copyInvoice)}</button>
        <a part="${OPENRECEIVE_CHECKOUT_ELEMENT_PARTS.open}" href="${escapeHtml(display.lightningUri)}">${escapeHtml(openReceiveCheckoutLabels.openWallet)}</a>
      </div>
      ${wizard}
    </section>
  `;
}

export function renderOpenReceiveThemeToggleHtml(label: string): string {
  return `
    <style>${openReceiveThemeToggleElementStyles}</style>
    <button part="${OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS.button}" type="button" ${OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle}>${escapeHtml(label)}</button>
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

  return `
    <section part="wizard" ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.root}>
      <div>
        <h2>${escapeHtml(openReceiveCheckoutLabels.wizardTitle)}</h2>
        <p>${escapeHtml(openReceiveCheckoutLabels.wizardSubtitle)}</p>
      </div>
      <div part="method-grid">
        ${openReceivePaymentMethods.map((method) => `
          <button
            part="method${selection.selectedMethod === method.id ? " selected" : ""}"
            ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method}="${escapeHtml(method.id)}"
            type="button"
          >
            <img alt="" src="${escapeHtml(getOpenReceivePaymentMethodIcon(method.id))}">
            <strong>${escapeHtml(method.title)}</strong>
            <small>${escapeHtml(method.detail)}</small>
          </button>
        `).join("")}
      </div>
      ${wizard.selectedRail !== null && selection.countryPickerOpen ? `
        <div part="region-tabs">
          ${model.countryPicker.regions.map((region) => `
              <button
                part="region${region.selected ? " selected" : ""}"
                ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.region}="${escapeHtml(region.id)}"
                ${region.enabled ? "" : "disabled"}
                type="button"
              >
                ${escapeHtml(region.label)}
                <small>${region.count}</small>
              </button>
            `).join("")}
        </div>
        <div part="country-map">
          <svg aria-label="Country map" role="img" viewBox="${escapeHtml(OPENRECEIVE_COUNTRY_MAP_VIEW_BOX)}">
            ${openReceiveCountryMapRegions.map((region) => `
              <ellipse
                part="map-region"
                ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.regionShape}="${escapeHtml(region.id)}"
                cx="${region.cx}"
                cy="${region.cy}"
                rx="${region.rx}"
                ry="${region.ry}"
              ></ellipse>
            `).join("")}
            ${model.countryPicker.mapCountries.map((entry) => `
              <circle
                aria-label="${escapeHtml(entry.label)}"
                part="map-pin${entry.selected ? " selected" : ""}"
                ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country}="${escapeHtml(entry.country.code)}"
                cx="${entry.point[0].toFixed(1)}"
                cy="${entry.point[1].toFixed(1)}"
                r="${entry.selected ? "9" : "6"}"
                role="button"
                tabindex="0"
              >
                <title>${escapeHtml(entry.label)}</title>
              </circle>
            `).join("")}
          </svg>
          <div part="map-readout">
            <strong>${escapeHtml(model.countryPicker.readoutLabel)}</strong>
            ${model.countryPicker.readoutMetaLabel === undefined ? "" : `
              <small>${escapeHtml(model.countryPicker.readoutMetaLabel)}</small>
            `}
          </div>
        </div>
        <div part="country-grid">
          ${model.visibleRegionCountryDisplays.map((country) => `
            <button
              part="country${country.selected ? " selected" : ""}"
              ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country}="${escapeHtml(country.code)}"
              type="button"
            >
              <strong>${escapeHtml(country.label)}</strong>
              <small>${escapeHtml(country.metaLabel)}</small>
            </button>
          `).join("")}
        </div>
      ` : ""}
      ${wizard.selectedRail !== null && !selection.countryPickerOpen && model.selectedCountryDisplay !== undefined ? `
        <div part="country-summary">
          <div>
            <strong>${escapeHtml(model.selectedCountryDisplay.label)}</strong>
            <small>${escapeHtml(model.selectedCountryDisplay.metaLabel)}</small>
          </div>
          <button ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.switchCountry} type="button">${escapeHtml(openReceiveCheckoutLabels.switchCountry)}</button>
        </div>
      ` : ""}
      ${routeAssetDisplays.length === 0 ? "" : `
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
      `}
      ${selection.selectedMethod === null || (wizard.selectedRail !== null && selection.countryPickerOpen) ? "" : `
        <div part="wizard-results">
          ${routeDisplays.length === 0 ? `
            <p part="wizard-empty">${
              escapeHtml(getOpenReceiveWizardEmptyMessage(selection.selectedMethod))
            }</p>
          ` : routeDisplays.map((route) => `
            <section part="wizard-route">
              <h3>${escapeHtml(route.title)}</h3>
              <p>${escapeHtml(route.subtitle)}</p>
              <div part="provider-grid">
                ${route.providers.map((provider) => `
                  <article part="provider${provider.recommended ? " selected" : ""}">
                    <div>
                      <h4>${escapeHtml(provider.name)}</h4>
                      ${provider.recommendedLabel === null ? "" : `<span part="recommended">${escapeHtml(provider.recommendedLabel)}</span>`}
                    </div>
                    <p>${escapeHtml(provider.blurb)}</p>
                    <div part="provider-badges">
                      <span>${escapeHtml(provider.mechanismLabel)}</span>
                      ${provider.usBadge === null ? "" : `<span>${escapeHtml(provider.usBadge)}</span>`}
                    </div>
                    <div part="provider-actions">
                      <button ${OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerCopy}="${escapeHtml(provider.id)}" type="button">${escapeHtml(provider.copyLabel)}</button>
                      <a href="${escapeHtml(provider.url)}" rel="noreferrer" target="_blank">${escapeHtml(provider.openLabel)}</a>
                    </div>
                  </article>
                `).join("")}
              </div>
            </section>
          `).join("")}
        </div>
      `}
    </section>
  `;
}

function createElementCheckoutState(
  view: OpenReceiveCheckoutView
): OpenReceiveCheckoutState | undefined {
  if (view.invoice_id === undefined) return undefined;
  return createOpenReceiveCheckoutStateFromDisplayData(view);
}

function renderElementPaymentStatusHtml(state: OpenReceiveCheckoutState): string {
  const status = createOpenReceiveCheckoutStatusModel(state);
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

  class OpenReceiveCheckoutElement extends HTMLElementCtor {
    private selection = createOpenReceivePaymentWizardSelection({
      storedCountryCode: readOpenReceiveStoredCountryCode(),
      defaultCountryCode: getOpenReceiveDefaultCountryCode()
    });
    private controller: OpenReceiveCheckoutController | undefined;
    private announcedSettledPaymentHash: string | undefined;

    static get observedAttributes() {
      return [
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.transactionState,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.workflowState,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.eventsUrl,
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
      root.innerHTML = renderOpenReceiveCheckoutHtml({
        invoice_id: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId) ?? undefined,
        invoice,
        payment_hash: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined,
        amount_msats: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats),
          { label: "amount-msats" }
        ),
        transaction_state: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.transactionState) ?? undefined,
        workflow_state: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.workflowState) ?? undefined,
        expires_at: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt),
          { label: "expires-at" }
        ),
        checkout: {
          ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.eventsUrl) === null
            ? {}
            : { events_url: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.eventsUrl) ?? undefined })
        },
        theme: parseOpenReceiveResolvedTheme(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme)),
        payment_wizard: parseOpenReceiveBooleanAttribute(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard)),
        wizard: {
          selectedMethod: this.selection.selectedMethod,
          selectedCountryCode: this.selection.selectedCountryCode,
          selectedBitcoinRoute: this.selection.selectedBitcoinRoute,
          selectedCryptoRoute: this.selection.selectedCryptoRoute,
          selectedRegion: this.selection.selectedRegion,
          countryPickerOpen: this.selection.countryPickerOpen
        }
      });

      const copyButton = root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.copy);
      copyButton?.addEventListener("click", () => {
        void (this.controller?.copyInvoice() ?? copyInvoice({ invoice, logger: options.logger }))
          .then(() => {
            showElementCopyFeedback(copyButton);
            this.dispatchEvent(
              createOpenReceiveCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy)
            );
          })
          .catch((error) => this.dispatchError(error));
      });

      root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.open)?.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          this.controller?.openWallet() ?? openWallet({ invoice, logger: options.logger });
          this.dispatchEvent(
            createOpenReceiveCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet)
          );
        } catch (error) {
          this.dispatchError(error);
        }
      });

      void createQrSvg(invoice, {
        encoder: options.qrEncoder,
        width: 256
      })
        .then((svg) => {
          const qr = root.querySelector(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr);
          if (qr !== null) qr.innerHTML = svg;
        })
        .catch((error) => this.dispatchError(error));

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
      this.controller = createOpenReceiveCheckoutController({
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

    private currentCheckoutSnapshot(): OpenReceiveCheckoutSnapshot | undefined {
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
      return createOpenReceiveCheckoutSnapshotFromDisplayData({
        invoice_id: invoiceId,
        invoice,
        ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) === null
          ? {}
          : { payment_hash: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined }),
        ...(amountMsats === undefined ? {} : { amount_msats: amountMsats }),
        transaction_state: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.transactionState) ?? "pending",
        workflow_state: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.workflowState) ?? "invoice_created",
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
        checkout: {
          ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.eventsUrl) === null
            ? {}
            : { events_url: this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.eventsUrl) ?? undefined })
        }
      });
    }

    private applyCheckoutState(state: OpenReceiveCheckoutState): void {
      this.setAttributeIfChanged(
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.transactionState,
        state.transaction_state
      );
      this.setAttributeIfChanged(
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.workflowState,
        state.workflow_state
      );
      if (state.expires_at !== undefined) {
        this.setAttributeIfChanged(
          OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
          String(state.expires_at)
        );
      }
      this.render();
      this.dispatchEvent(
        createOpenReceiveCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state, state)
      );
      if (state.settled && state.payment_hash !== this.announcedSettledPaymentHash) {
        this.announcedSettledPaymentHash = state.payment_hash;
        this.dispatchEvent(
          createOpenReceiveCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled, state)
        );
        this.dispatchEvent(
          createOpenReceiveCheckoutStateEvent(
            OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.paymentReceived,
            state
          )
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
          const countryCode = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.country);
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

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerCopy).forEach((button) => {
        button.addEventListener("click", () => {
          const providerId = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerCopy);
          if (providerId === null) return;
          void copyInvoice({ invoice, logger })
            .then(() => {
              showElementCopyFeedback(button);
              this.dispatchEvent(createOpenReceiveProviderCopyEvent(providerId));
              this.dispatchEvent(
                createOpenReceiveCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy)
              );
            })
            .catch((error) => this.dispatchError(error));
        });
      });
    }

    private dispatchError(error: unknown): void {
      this.dispatchEvent(createOpenReceiveCheckoutErrorEvent(error));
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
      root.innerHTML = renderOpenReceiveThemeToggleHtml(theme.toggleLabel);
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
    registry.define(tagName, OpenReceiveCheckoutElement);
  }
  if (registry.get(themeToggleTagName) === undefined) {
    registry.define(themeToggleTagName, OpenReceiveThemeToggleElement);
  }
}

export const formatMsats = formatOpenReceiveMsats;

const elementCopyFeedbackControllers =
  new WeakMap<Element, ReturnType<typeof createOpenReceiveTransientFeedbackController<string>>>();
const escapeHtml = escapeOpenReceiveHtml;

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
