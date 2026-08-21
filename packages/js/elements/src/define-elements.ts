import {
  applyCheckoutElementAttributes,
  buildOpenReceiveMethodGridEntries,
  type CheckoutController,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  copyInvoice,
  createCheckoutActionEvent,
  createCheckoutController,
  createCheckoutElementAttributes,
  createCheckoutErrorEvent,
  createCheckoutProviderCopyEvent,
  createCheckoutSnapshotFromDisplayData,
  createCheckoutStateEvent,
  createCheckoutStatusModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceiveSwapDisplayModel,
  createOpenReceiveThemeChangeEvent,
  createQrPayloadSvg,
  createQrSvg,
  status as deriveStatus,
  enterCheckoutResumePath,
  getSwapRefundAddressError,
  isReusableLightningInvoice,
  normalizeSwapStartInvoice,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_DEFAULT_PREFIX,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type OpenReceiveBrowserLoggerOption,
  openReceivePaymentMethods,
  openWallet,
  orClasses,
  overlayOpenReceiveSwapRefundStaging,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveMethodPickerKey,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveSwapPickerKey,
  parseOpenReceiveThemePreference,
  postOpenReceiveJson,
  prepareCheckout,
  requestCheckout,
  resolveOpenReceivePreservedNetworkSelection,
  resolveOrderUrlFromPrefix,
  selectCheckoutDisplayInvoice,
  startOpenReceiveSwapRequest,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  updateOpenReceivePaymentWizardSelection,
} from "@openreceive/browser/internal";
import {
  parseElementRail,
  readElementFiatQuote,
  showElementCopyFeedback,
  wireSwapSelectAllInputs,
} from "./dom-helpers.ts";
import { adoptOpenReceiveCheckoutStyles } from "./element-styles.ts";
import {
  renderCheckoutCreateErrorHtml,
  renderCheckoutCreatingHtml,
  renderCheckoutHtml,
  renderOpenReceiveThemeToggleHtml,
} from "./render-checkout.ts";
import {
  type DefineOpenReceiveElementsOptions,
  type OpenReceiveElementsSwapOption,
  parseElementStatus,
  transactionStateFromStatus,
} from "./views.ts";

const DEFAULT_TAG_NAME = "openreceive-checkout";

function markElementConfirmButtonBusy(button: HTMLButtonElement): void {
  button.disabled = true;
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  if (button.querySelector('[part="spinner"]') !== null) return;
  const spinner = button.ownerDocument.createElement("span");
  spinner.setAttribute("part", "spinner");
  spinner.className = orClasses.continueSpinner;
  spinner.setAttribute("aria-hidden", "true");
  button.prepend(spinner);
}

/** Display-affecting snapshot fields only, so a poll that changes nothing visible skips a render. */
function checkoutSnapshotDisplayKey(snapshot: CheckoutSnapshot): string {
  return JSON.stringify({
    checkout_id: snapshot.checkout_id,
    order_id: snapshot.order_id,
    status: snapshot.status,
    amount_msats: snapshot.amount_msats,
    fiat: snapshot.fiat,
    payment_methods: snapshot.payment_methods,
    invoices: snapshot.invoices.map((invoice) => ({
      invoice_id: invoice.invoice_id,
      invoice: invoice.invoice,
      rail: invoice.rail,
      payment_hash: invoice.payment_hash,
      transaction_state: invoice.transaction_state,
      workflow_state: invoice.workflow_state,
      expires_at: invoice.expires_at,
      settled_at: invoice.settled_at,
      swap:
        invoice.swap === undefined
          ? undefined
          : {
              attempt_id: invoice.swap.attempt_id,
              provider: invoice.swap.provider,
              provider_order_id: invoice.swap.provider_order_id,
              pay_in_asset: invoice.swap.pay_in_asset,
              deposit_address: invoice.swap.deposit_address,
              deposit_memo: invoice.swap.deposit_memo,
              deposit_amount: invoice.swap.deposit_amount,
              provider_state: invoice.swap.provider_state,
              provider_expires_at: invoice.swap.provider_expires_at,
              deposit_tx_id: invoice.swap.deposit_tx_id,
              payout_tx_id: invoice.swap.payout_tx_id,
              refund_address: invoice.swap.refund_address,
              refund_nonce: invoice.swap.refund_nonce,
              refund_nonce_expires_at: invoice.swap.refund_nonce_expires_at,
              refund_tx_id: invoice.swap.refund_tx_id,
              attention: invoice.swap.attention,
              attention_reason: invoice.swap.attention_reason,
              refund_reason: invoice.swap.refund_reason,
              deposit_received_amount: invoice.swap.deposit_received_amount,
              refund_amount: invoice.swap.refund_amount,
              fee: invoice.swap.fee,
            },
    })),
  });
}

export function defineOpenReceiveElements(options: DefineOpenReceiveElementsOptions = {}): void {
  const registry = options.registry ?? globalThis.customElements;
  const HTMLElementCtor = globalThis.HTMLElement;
  const tagName = options.tagName ?? DEFAULT_TAG_NAME;
  const themeToggleTagName =
    options.themeToggleTagName ?? OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;

  if (registry === undefined || HTMLElementCtor === undefined) {
    throw new Error("Custom elements are unavailable in this environment.");
  }

  class CheckoutElement extends HTMLElementCtor {
    private selection = createOpenReceivePaymentWizardSelection();
    private activeTutorialProviderId: string | null = null;
    private activeTutorialIndex = 0;
    private activeTutorialCopied = false;
    private swapOptions: readonly OpenReceiveElementsSwapOption[] = [];
    private swapOptionsLoaded = false;
    private selectedSwapNetworks: Record<string, string> = {};
    private selectedPickerKey: string | null = null;
    private selectedSwapAsset: string | null = null;
    private startedSwapInvoice: CheckoutInvoiceSnapshot | undefined;
    private latestCheckoutSnapshot: CheckoutSnapshot | undefined;
    /** Skip full shadow rebuilds when a poll returns the same payable UI. */
    private lastSnapshotDisplayKey: string | undefined;
    private dismissedSwapInvoiceId: string | null = null;
    private controller: CheckoutController | undefined;
    private announcedSettledOrderId: string | undefined;
    /** Last applied state, used to detect countdown-only ticks (partial DOM update). */
    private lastCheckoutState: CheckoutState | undefined;
    /** Refund-address draft survives poll rebuilds of the shadow tree. */
    private refundAddressDraft = "";
    private refundAddressDraftFocused = false;
    private refundAddressDraftSelectionStart: number | null = null;
    private refundAddressDraftSelectionEnd: number | null = null;
    /** Tutorial provider whose dialog was last focused, so re-renders don't re-steal focus. */
    private focusedTutorialProviderId: string | null = null;
    /** Create-mode prepare failure shown inline with a retry button. */
    private createError: string | undefined;
    /** Swap-start failure shown inline in the deposit slot with a retry button. */
    private swapStartError: string | undefined;
    /** In-flight swap create; a second click must not mint a colliding attempt. */
    private startingSwapAsset: string | null = null;
    /** Lightning mint failure shown inline in the wizard. */
    private wizardError: string | undefined;
    // Create-mode bookkeeping: `createdKey` is `${prefix}::${orderId}` so prepare runs once
    // per order/prefix and re-runs when either changes; `creating` guards against overlap.
    // Keep `createdKey` after prepare failure so theme/error DOM churn cannot storm
    // `/checkouts/prepare`.
    private creating = false;
    private createdKey: string | undefined;
    /**
     * Depth of the "these attributes are ours" guard. Attributes the element writes
     * back to itself (the created snapshot, every status/expiry transition) must not
     * re-enter attributeChangedCallback: that rebuilt the shadow tree, replaced the
     * controller and fired another status request for a change the element just made.
     */
    private applyingOwnAttributes = 0;
    /** Create-mode: Lightning QR is deferred until the payer selects Bitcoin. */
    private lightningRequested = false;
    private mintingLightning = false;
    /** When `theme` is unset, follow the nearest ancestor `[data-theme]` (e.g. ThemeScope). */
    private themeAncestorObserver: MutationObserver | undefined;
    private observedThemeAncestor: Element | null = null;

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
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeOrderId,
      ];
    }

    connectedCallback() {
      this.render();
      this.syncThemeAncestorObserver();
      if (this.isCreateMode()) {
        void this.createCheckout();
        return;
      }
      this.startCheckoutController();
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
      if (!this.isConnected || this.applyingOwnAttributes > 0) return;
      if (oldValue === newValue) return;

      const createInputChanged =
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice;
      if (createInputChanged) {
        this.createdKey = undefined;
      }

      if (this.isCreateMode()) {
        this.render();
        this.syncThemeAncestorObserver();
        // Theme/status attrs must not re-prepare; only create inputs may.
        if (createInputChanged) {
          void this.createCheckout();
        }
        return;
      }
      this.render();
      this.syncThemeAncestorObserver();
      this.startCheckoutController();
    }

    disconnectedCallback() {
      this.stopCheckoutController();
      this.stopThemeAncestorObserver();
    }

    // Create mode: an `order-id` is set but no `invoice` snapshot is provided. The element
    // owns the whole lifecycle — it creates the checkout against `${prefix}/checkouts`, then
    // polls status against `${prefix}/payments/check` and drives swaps under the prefix.
    private isCreateMode(): boolean {
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      return (invoice === null || invoice === "") && orderId !== null && orderId.length > 0;
    }

    /** `${prefix}::${orderId}` the element would prepare right now, or undefined. */
    private currentCreateKey(): string | undefined {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (orderId === null || orderId.length === 0) return undefined;
      const prefix =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
        OPENRECEIVE_DEFAULT_PREFIX;
      return `${prefix}::${orderId}`;
    }

    private async createCheckout(): Promise<void> {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (orderId === null || orderId.length === 0) return;
      const prefix =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
        OPENRECEIVE_DEFAULT_PREFIX;
      const key = `${prefix}::${orderId}`;
      if (this.creating || this.createdKey === key) return;
      this.creating = true;
      this.createdKey = key;
      this.lightningRequested = false;

      try {
        this.createError = undefined;
        this.syncResumePath(orderId);
        // Lock amount without minting a payer Lightning invoice. Bitcoin selection mints later.
        const checkout = await prepareCheckout({
          prefix,
          orderId,
          fetch: globalThis.fetch,
        });
        // The host may have re-pointed order-id/prefix while this was in flight;
        // applying an older order's attributes here would silently show, and poll,
        // the wrong order. The finally block re-runs for whatever is current.
        if (this.currentCreateKey() !== key) return;
        this.handleControllerSnapshot(checkout);
        const orderUrl = resolveOrderUrlFromPrefix(prefix, orderId);
        // Apply routing attrs only (no invoice) so render stays in deferred wizard mode.
        // Preserve the host theme attribute so shadow data-theme cannot fall through.
        this.applyOwnAttributes(
          createCheckoutElementAttributes(checkout, {
            orderUrl,
            prefix,
            ...this.currentThemeOption(),
          }),
        );
        this.render();
        this.startCheckoutController();
      } catch (error) {
        if (this.currentCreateKey() !== key) return;
        // Leave createdKey set so theme sync / host error DOM updates cannot retry-storm.
        // The payer sees an inline error with a retry button instead of an
        // infinite "Creating checkout…" spinner.
        this.createError =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Could not start checkout.";
        this.dispatchError(error);
        this.render();
      } finally {
        this.creating = false;
        const current = this.currentCreateKey();
        if (this.isConnected && current !== undefined && current !== key && this.isCreateMode()) {
          void this.createCheckout();
        }
      }
    }

    /** Write attributes the element owns without re-entering attributeChangedCallback. */
    private applyOwnAttributes(attributes: Parameters<typeof applyCheckoutElementAttributes>[1]) {
      this.applyingOwnAttributes += 1;
      try {
        applyCheckoutElementAttributes(this, attributes);
      } finally {
        this.applyingOwnAttributes -= 1;
      }
    }

    /** Explicit payer retry after a failed prepare. */
    private retryCreateCheckout(): void {
      this.createdKey = undefined;
      this.createError = undefined;
      this.render();
      void this.createCheckout();
    }

    /** Create-time metadata from the JSON `metadata` attribute, when present and valid. */
    private createMetadata(): Record<string, unknown> | undefined {
      const raw = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.metadata);
      if (raw === null || raw.length === 0) return undefined;
      try {
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        return undefined;
      }
    }

    /** Order data belongs to the host; this only performs optional History API sync. */
    private syncResumePath(orderId: string): void {
      const syncUrl = parseOpenReceiveBooleanAttribute(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl),
      );
      if (syncUrl) {
        const resumePathPrefix =
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix) ??
          "/checkout";
        const routeOrderId =
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeOrderId) ?? undefined;
        enterCheckoutResumePath(orderId, {
          pathPrefix: resumePathPrefix,
          ...(routeOrderId === undefined || routeOrderId.length === 0 ? {} : { routeOrderId }),
        });
      }
    }

    private async ensureLightning(): Promise<void> {
      // A second click while the first mint is in flight would POST /checkouts
      // again; the loser's 409 then surfaced as a wizard error over a perfectly
      // good invoice. `startSwap` guards the same way.
      if (this.mintingLightning) return;
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (orderId === null || orderId.length === 0) return;
      const prefix =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
        OPENRECEIVE_DEFAULT_PREFIX;
      const current = this.latestCheckoutSnapshot;
      if (current !== undefined) {
        const reusableLightning = current.invoices.find(
          (invoice) =>
            invoice.rail === "lightning" &&
            typeof invoice.invoice === "string" &&
            invoice.invoice.length > 0 &&
            invoice.expires_at !== undefined &&
            isReusableLightningInvoice(invoice.expires_at),
        );
        if (reusableLightning !== undefined) {
          const withoutSame = current.invoices.filter(
            (entry) =>
              entry.invoice_id !== reusableLightning.invoice_id && entry.rail !== "checkout_lock",
          );
          const focused: CheckoutSnapshot = {
            ...current,
            checkout_id: reusableLightning.invoice_id,
            active: reusableLightning,
            invoices: [reusableLightning, ...withoutSame],
          };
          this.handleControllerSnapshot(focused);
          this.lightningRequested = true;
          this.applyOwnAttributes(
            createCheckoutElementAttributes(focused, {
              orderUrl: resolveOrderUrlFromPrefix(prefix, orderId),
              prefix,
              ...this.currentThemeOption(),
            }),
          );
          this.render();
          this.startCheckoutController();
          return;
        }
      }
      this.mintingLightning = true;
      this.wizardError = undefined;
      this.render();
      try {
        const checkout = await requestCheckout({
          prefix,
          orderId,
          ...(this.createMetadata() === undefined ? {} : { metadata: this.createMetadata() }),
          fetch: globalThis.fetch,
        });
        const previous = this.latestCheckoutSnapshot;
        const minted = selectCheckoutDisplayInvoice(checkout) ?? checkout.active;
        const merged =
          minted === undefined
            ? {
                ...checkout,
                ...(previous?.payment_methods === undefined
                  ? {}
                  : { payment_methods: previous.payment_methods }),
              }
            : {
                ...(previous ?? checkout),
                ...checkout,
                checkout_id: minted.invoice_id,
                active: minted,
                invoices: [
                  minted,
                  ...(previous?.invoices ?? checkout.invoices).filter(
                    (entry) =>
                      entry.invoice_id !== minted.invoice_id && entry.rail !== "checkout_lock",
                  ),
                ],
                payment_methods: previous?.payment_methods ?? checkout.payment_methods,
              };
        this.handleControllerSnapshot(merged);
        this.lightningRequested = true;
        this.applyOwnAttributes(
          createCheckoutElementAttributes(merged, {
            orderUrl: resolveOrderUrlFromPrefix(prefix, orderId),
            prefix,
            ...this.currentThemeOption(),
          }),
        );
        this.render();
        this.startCheckoutController();
      } catch (error) {
        // Surface the mint failure inline (the server's message travels on the
        // thrown error) instead of silently returning to the method picker.
        this.wizardError =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Could not create the Lightning invoice. Please try again.";
        this.dispatchError(error);
      } finally {
        this.mintingLightning = false;
        this.render();
      }
    }

    private handleControllerSnapshot(snapshot: CheckoutSnapshot): void {
      this.latestCheckoutSnapshot = snapshot;
      // Payable assets ride on the order object itself (payment_methods).
      // Undefined means status has not returned yet (catalog may still be warming).
      if (snapshot.payment_methods !== undefined) {
        this.swapOptions = snapshot.payment_methods;
        this.swapOptionsLoaded = true;
      }
      const swapInvoice = snapshot.invoices.find(
        (invoice) => invoice.rail === "swap" && invoice.swap !== undefined,
      );
      if (swapInvoice !== undefined) {
        this.startedSwapInvoice = overlayOpenReceiveSwapRefundStaging(
          swapInvoice,
          this.startedSwapInvoice,
        );
      }
      const displayKey = checkoutSnapshotDisplayKey(snapshot);
      if (this.lastSnapshotDisplayKey === displayKey) return;
      this.lastSnapshotDisplayKey = displayKey;
      this.render();
    }

    render() {
      this.captureRefundAddressDraft();
      const invoiceAttr = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      const deferredReady =
        this.isCreateMode() &&
        this.latestCheckoutSnapshot !== undefined &&
        (invoiceAttr === null || invoiceAttr === "");
      if ((invoiceAttr === null || invoiceAttr === "") && !deferredReady) {
        if (this.isCreateMode()) {
          const { root, inlineStyles } = this.prepareShadowRoot();
          if (this.createError !== undefined) {
            root.innerHTML = renderCheckoutCreateErrorHtml(this.createError, {
              theme: this.resolveTheme(),
              inlineStyles,
            });
            root
              .querySelector('[part="retry"]')
              ?.addEventListener("click", () => this.retryCreateCheckout());
            return;
          }
          root.innerHTML = renderCheckoutCreatingHtml({
            theme: this.resolveTheme(),
            inlineStyles,
          });
          return;
        }
        this.replaceChildren();
        return;
      }

      const invoice = invoiceAttr ?? "";
      const lightningRequested =
        !this.isCreateMode() || this.lightningRequested || invoice.length > 0;
      const decodeLinkUrl =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.decodeLinkUrl) ?? undefined;
      const { root, inlineStyles } = this.prepareShadowRoot();
      root.innerHTML = renderCheckoutHtml({
        inlineStyles,
        ...(decodeLinkUrl === undefined ? {} : { decodeLinkUrl }),
        invoice_id:
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId) ?? undefined,
        invoice,
        rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
        payment_hash:
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined,
        amount_msats: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats),
          { label: "amount-msats" },
        ),
        fiat_quote: readElementFiatQuote(this),
        status: parseElementStatus(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status),
        ),
        expires_at: parseOpenReceiveOptionalInteger(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt),
          { label: "expires-at" },
        ),
        theme: this.resolveTheme(),
        payment_wizard: parseOpenReceiveBooleanAttribute(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard),
        ),
        lightningRequested: this.mintingLightning ? false : lightningRequested,
        wizard: {
          selectedMethod: this.selection.selectedMethod,
          selectedBitcoinRoute: this.selection.selectedBitcoinRoute,
          selectedCryptoRoute: this.selection.selectedCryptoRoute,
          swapOptions: this.swapOptions,
          currenciesLoading: !this.swapOptionsLoaded,
          selectedSwapNetworks: this.selectedSwapNetworks,
          selectedPickerKey: this.selectedPickerKey,
          startingSwapAsset: this.startingSwapAsset,
          selectedSwapAsset: this.selectedSwapAsset,
          ...(this.latestCheckoutSnapshot?.amount_msats === undefined
            ? {}
            : { amountMsats: this.latestCheckoutSnapshot.amount_msats }),
          ...(this.latestCheckoutSnapshot?.fiat === undefined
            ? {}
            : { fiat: this.latestCheckoutSnapshot.fiat }),
          ...(this.latestCheckoutSnapshot?.order_id === undefined
            ? {}
            : { orderId: this.latestCheckoutSnapshot.order_id }),
          ...(this.latestCheckoutSnapshot?.checkout_id === undefined
            ? {}
            : { checkoutId: this.latestCheckoutSnapshot.checkout_id }),
          lightningInvoice: invoice,
          ...(decodeLinkUrl === undefined ? {} : { decodeLinkUrl }),
          ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) === null
            ? {}
            : {
                paymentHash:
                  this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ??
                  undefined,
              }),
          swapInvoice: this.currentSwapInvoice(),
          activeTutorialProviderId: this.activeTutorialProviderId,
          activeTutorialIndex: this.activeTutorialIndex,
          activeTutorialCopied: this.activeTutorialCopied,
          ...(this.swapStartError === undefined ? {} : { swapStartError: this.swapStartError }),
          ...(this.wizardError === undefined ? {} : { wizardError: this.wizardError }),
        },
        ...(this.lastCheckoutState === undefined ? {} : { liveState: this.lastCheckoutState }),
      });

      const copyButton = root.querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.copy);
      if (invoice.length > 0) {
        copyButton?.addEventListener("click", () => {
          void (this.controller?.copyInvoice() ?? copyInvoice({ invoice, logger: options.logger }))
            .then(() => {
              showElementCopyFeedback(copyButton);
              this.dispatchEvent(
                createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy),
              );
            })
            .catch((error) => this.dispatchError(error));
        });

        root
          .querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.open)
          ?.addEventListener("click", (event) => {
            event.preventDefault();
            try {
              this.controller?.openWallet() ?? openWallet({ invoice, logger: options.logger });
              this.dispatchEvent(
                createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet),
              );
            } catch (error) {
              this.dispatchError(error);
            }
          });
      }

      root
        .querySelector(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS.startOver)
        ?.addEventListener("click", () => {
          this.dispatchEvent(
            createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver),
          );
        });

      const qrTarget = root.querySelector(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr);
      if (qrTarget !== null && invoice.length > 0) {
        void createQrSvg(invoice, {
          encoder: options.qrEncoder,
          width: 256,
        })
          .then((svg) => {
            // Write to the node this render created, and only while it is still
            // the current invoice: re-querying at resolve time let a slow encode
            // paint an old invoice's QR over a newer one.
            if (this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice) !== invoice) {
              return;
            }
            qrTarget.innerHTML = svg;
          })
          .catch((error) => this.dispatchError(error));
      }

      this.bindWizard(root, invoice, options.logger);
      this.renderSwapQrCodes(root);
    }

    /**
     * Shadow root plus the shared compiled stylesheet. `inlineStyles` is true only
     * where constructable stylesheets are unavailable and the markup must carry a
     * `<style>` of its own.
     */
    private prepareShadowRoot(): { root: ShadowRoot; inlineStyles: boolean } {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      return { root, inlineStyles: !adoptOpenReceiveCheckoutStyles(root) };
    }

    private captureRefundAddressDraft(): void {
      const root = this.shadowRoot;
      if (root === null) return;
      const input = root.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundAddress);
      if (!(input instanceof HTMLInputElement) || input.type === "hidden") return;
      this.refundAddressDraft = input.value;
      this.refundAddressDraftFocused = root.activeElement === input;
      this.refundAddressDraftSelectionStart = input.selectionStart;
      this.refundAddressDraftSelectionEnd = input.selectionEnd;
    }

    private clearRefundAddressDraft(): void {
      this.refundAddressDraft = "";
      this.refundAddressDraftFocused = false;
      this.refundAddressDraftSelectionStart = null;
      this.refundAddressDraftSelectionEnd = null;
    }

    private startCheckoutController(): void {
      const attributeSnapshot = this.currentCheckoutSnapshot();
      const latest = this.latestCheckoutSnapshot;
      // After a swap starts, the merged snapshot (swap active) must drive
      // polling — the attribute snapshot still describes the pre-swap
      // Lightning attempt.
      const snapshot = latest?.active?.rail === "swap" ? latest : (attributeSnapshot ?? latest);
      const orderUrl = this.resolveOrderUrl(snapshot?.order_id);
      if (snapshot === undefined) {
        this.stopCheckoutController();
        return;
      }

      this.stopCheckoutController();
      this.controller = createCheckoutController({
        snapshot,
        ...(orderUrl === null ? {} : { orderUrl }),
        logger: options.logger,
        onError: (error) => this.dispatchError(error),
        onState: (nextState) => this.applyCheckoutState(nextState),
        onSnapshot: (snapshot) => this.handleControllerSnapshot(snapshot),
      });
      this.controller.start();
      void this.controller.reloadState().catch((error) => this.dispatchError(error));
    }

    private stopCheckoutController(): void {
      this.controller?.stop();
      this.controller = undefined;
    }

    /**
     * Status/swap endpoint resolution, matching React snapshot mode: an explicit
     * `order-url` wins; otherwise `${prefix}/payments/check` (default `/openreceive`).
     */
    private resolveOrderUrl(orderId?: string): string | null {
      const attribute = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl);
      if (attribute !== null && attribute.length > 0) return attribute;
      const prefix =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
        OPENRECEIVE_DEFAULT_PREFIX;
      const id = orderId ?? this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      if (id === null || id === undefined || id.length === 0) return null;
      return resolveOrderUrlFromPrefix(prefix, id);
    }

    private currentCheckoutSnapshot(): CheckoutSnapshot | undefined {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      const invoiceId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId);
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      if (invoiceId === null || invoice === null) return undefined;
      const amountMsats = parseOpenReceiveOptionalInteger(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats),
        { label: "amount-msats" },
      );
      const expiresAt = parseOpenReceiveOptionalInteger(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt),
        { label: "expires-at" },
      );
      return createCheckoutSnapshotFromDisplayData({
        ...(orderId === null ? {} : { order_id: orderId }),
        invoice_id: invoiceId,
        invoice,
        rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
        ...(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) === null
          ? {}
          : {
              payment_hash:
                this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined,
            }),
        ...(amountMsats === undefined ? {} : { amount_msats: amountMsats }),
        ...(readElementFiatQuote(this) === undefined
          ? {}
          : { fiat_quote: readElementFiatQuote(this) }),
        transaction_state: transactionStateFromStatus(
          parseElementStatus(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status)) ??
            "pending",
        ),
        ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      });
    }

    private applyCheckoutState(state: CheckoutState): void {
      const previous = this.lastCheckoutState;
      this.lastCheckoutState = state;
      // These mirror the controller's state back onto the element. Left
      // unsuppressed, every real transition re-entered attributeChangedCallback
      // and rebuilt the shadow tree, replaced the controller, and fired another
      // POST /payments/check for a change that had just arrived from one.
      this.applyingOwnAttributes += 1;
      try {
        this.setAttributeIfChanged(
          OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status,
          deriveStatus(state),
        );
        if (state.expires_at !== undefined) {
          this.setAttributeIfChanged(
            OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt,
            String(state.expires_at),
          );
        }
      } finally {
        this.applyingOwnAttributes -= 1;
      }
      // A countdown tick only moves the remaining-time text. Rebuilding the
      // whole shadow DOM every second destroyed focus, collapsed open
      // pickers, wiped "Copied!" feedback, and re-encoded the QR — so ticks
      // patch the countdown text nodes in place instead.
      if (previous !== undefined && this.isCountdownOnlyTick(previous, state)) {
        this.updateCountdownText(state);
      } else {
        this.render();
      }
      this.dispatchEvent(
        createCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state, state),
      );
      if (state.settled && state.order_id !== this.announcedSettledOrderId) {
        this.announcedSettledOrderId = state.order_id;
        this.dispatchEvent(
          createCheckoutStateEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled, state),
        );
      }
    }

    private isCountdownOnlyTick(previous: CheckoutState, next: CheckoutState): boolean {
      return (
        previous.checkout_id === next.checkout_id &&
        previous.invoice_id === next.invoice_id &&
        previous.invoice === next.invoice &&
        previous.rail === next.rail &&
        previous.payment_hash === next.payment_hash &&
        previous.transaction_state === next.transaction_state &&
        previous.workflow_state === next.workflow_state &&
        previous.phase === next.phase &&
        previous.settled === next.settled &&
        previous.terminal === next.terminal &&
        previous.paid === next.paid &&
        previous.expires_at === next.expires_at &&
        previous.swap?.provider_state === next.swap?.provider_state
      );
    }

    /** Patch the countdown text nodes without rebuilding the shadow DOM. */
    private updateCountdownText(state: CheckoutState): void {
      const root = this.shadowRoot;
      if (root === null) return;
      const model = createCheckoutStatusModel(state);
      const countdown = root.querySelector('[part="countdown"] strong');
      if (countdown !== null && model.countdownLabel !== undefined) {
        countdown.textContent = model.countdownLabel;
      }
      const swapInvoice = this.currentSwapInvoice();
      if (swapInvoice !== undefined) {
        const display = createOpenReceiveSwapDisplayModel(swapInvoice, {});
        const swapCountdown = root.querySelector('[part="swap-countdown"]');
        if (swapCountdown !== null && display !== undefined) {
          swapCountdown.textContent = display.countdownLabel;
        }
      }
    }

    private setAttributeIfChanged(name: string, value: string): void {
      if (this.getAttribute(name) !== value) this.setAttribute(name, value);
    }

    private bindWizard(
      root: ShadowRoot,
      invoice: string,
      logger: OpenReceiveBrowserLoggerOption | undefined,
    ): void {
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.method).forEach((button) => {
        button.addEventListener("click", () => {
          if (button.hasAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerContinue)) return;
          if (button.hasAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect)) return;
          const method = parseOpenReceivePaymentMethod(
            button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method),
          );
          if (method === null) return;
          this.selectedPickerKey = null;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_method",
            method,
          });
          if (method === "bitcoin") {
            void this.ensureLightning();
          }
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.pickerSelect).forEach((button) => {
        button.addEventListener("click", () => {
          if (!(button instanceof HTMLButtonElement) || button.disabled) return;
          const key = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect);
          if (key === null || key.length === 0) return;
          const methodPick = parseOpenReceiveMethodPickerKey(key);
          if (methodPick !== null) {
            const method = parseOpenReceivePaymentMethod(methodPick.methodId);
            if (method === null) return;
            this.selectedPickerKey = null;
            this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
              type: "select_method",
              method,
            });
            if (method === "bitcoin") {
              void this.ensureLightning();
            }
            this.render();
            return;
          }
          const previousKey = this.selectedPickerKey;
          this.selectedPickerKey = key;
          const nextSwap = parseOpenReceiveSwapPickerKey(key);
          if (nextSwap !== null) {
            const entries = buildOpenReceiveMethodGridEntries(
              openReceivePaymentMethods,
              this.swapOptions,
            );
            const nextEntry = entries.find(
              (entry) =>
                entry.kind === "swap" && entry.group.label.trim().toUpperCase() === nextSwap.label,
            );
            if (nextEntry?.kind === "swap" && nextEntry.group.options.length === 1) {
              const option =
                nextEntry.group.options.find((entry) => entry.available !== false) ??
                nextEntry.group.options[0];
              if (option === undefined || option.available === false) return;
              this.selectedPickerKey = null;
              void this.startSwap(option.pay_in_asset);
              return;
            }
            if (nextEntry?.kind === "swap" && nextEntry.group.options.length > 1) {
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
                selectedNetworks: this.selectedSwapNetworks,
              });
              const groupKey = nextEntry.group.label.trim().toUpperCase();
              if (preserved === undefined) {
                const { [groupKey]: _removed, ...rest } = this.selectedSwapNetworks;
                this.selectedSwapNetworks = rest;
              } else {
                this.selectedSwapNetworks = {
                  ...this.selectedSwapNetworks,
                  [groupKey]: preserved,
                };
              }
            }
          }
          this.render();
        });
      });

      root
        .querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.pickerContinue)
        .forEach((button) => {
          button.addEventListener("click", () => {
            if (!(button instanceof HTMLButtonElement) || button.disabled) return;
            const method = parseOpenReceivePaymentMethod(
              button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method),
            );
            if (method !== null) {
              this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
                type: "select_method",
                method,
              });
              this.render();
              return;
            }
            const payInAsset = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart);
            if (payInAsset === null) return;
            markElementConfirmButtonBusy(button);
            void this.startSwap(payInAsset);
          });
        });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.breadcrumb).forEach((button) => {
        button.addEventListener("click", () => {
          const target = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.breadcrumb);
          if (target === "swap-asset") {
            this.selectedSwapAsset = null;
            this.selectedPickerKey = null;
            this.selectedSwapNetworks = {};
            this.render();
            return;
          }
          if (target === "method") {
            this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
              type: "change_method",
            });
            this.render();
            return;
          }
          if (target === "route") {
            this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
              type: "change_route",
            });
            this.render();
          }
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.route).forEach((button) => {
        button.addEventListener("click", () => {
          const route = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.route);
          if (route === null) return;
          this.selection = updateOpenReceivePaymentWizardSelection(this.selection, {
            type: "select_route",
            route,
          });
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapStart).forEach((button) => {
        button.addEventListener("click", () => {
          if (button.hasAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerContinue)) return;
          const payInAsset = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart);
          if (payInAsset === null) return;
          if (button instanceof HTMLButtonElement) markElementConfirmButtonBusy(button);
          void this.startSwap(payInAsset);
        });
      });

      root
        .querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapNetworkValue)
        .forEach((button) => {
          button.addEventListener("click", () => {
            if (!(button instanceof HTMLButtonElement) || button.disabled) return;
            const groupKey = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetwork);
            const payInAsset = button.getAttribute(
              OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapNetworkValue,
            );
            if (groupKey === null || groupKey.length === 0 || payInAsset === null) return;
            const details = button.closest("details");
            if (details instanceof HTMLDetailsElement) details.open = false;
            this.selectedSwapNetworks = {
              ...this.selectedSwapNetworks,
              [groupKey]: payInAsset,
            };
            this.render();
          });
        });

      root
        .querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapBack)
        ?.addEventListener("click", () => {
          const current = this.currentSwapInvoice();
          this.dismissedSwapInvoiceId = current?.invoice_id ?? null;
          this.selectedSwapAsset = null;
          this.selectedPickerKey = null;
          this.selectedSwapNetworks = {};
          this.clearRefundAddressDraft();
          void this.ensureLightning();
          this.render();
        });

      wireSwapSelectAllInputs(root);
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapCopy).forEach((button) => {
        button.addEventListener("click", () => {
          const value = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapCopy);
          if (value === null) return;
          void globalThis.navigator?.clipboard
            ?.writeText(value)
            .then(() => showElementCopyFeedback(button))
            .catch((error) => this.dispatchError(error));
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundForm).forEach((form) => {
        const input = form.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundAddress);
        const errorEl = form.querySelector(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapRefundError);
        const payInAsset =
          form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundPayInAsset) ?? "";
        const networkLabel =
          form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNetworkLabel) ??
          "refund";
        const setRefundAddressError = (message: string | undefined) => {
          if (input instanceof HTMLInputElement) {
            input.className =
              message === undefined ? orClasses.swapRefundInput : orClasses.swapRefundInputInvalid;
            if (message === undefined) input.removeAttribute("aria-invalid");
            else input.setAttribute("aria-invalid", "true");
          }
          if (errorEl instanceof HTMLElement) {
            if (message === undefined) {
              errorEl.textContent = "";
              errorEl.hidden = true;
            } else {
              errorEl.textContent = message;
              errorEl.hidden = false;
            }
          }
        };
        const validateRefundAddress = (address: string, showEmpty: boolean): string | undefined => {
          if (address.length === 0) {
            return showEmpty ? "Enter a refund address." : undefined;
          }
          return getSwapRefundAddressError(payInAsset, address, networkLabel);
        };
        if (input instanceof HTMLInputElement && input.type !== "hidden") {
          if (this.refundAddressDraft.length > 0) {
            input.value = this.refundAddressDraft;
          }
          input.addEventListener("input", () => {
            this.refundAddressDraft = input.value;
            const address = input.value.trim();
            if (address.length === 0) {
              setRefundAddressError(undefined);
              return;
            }
            setRefundAddressError(validateRefundAddress(address, false));
          });
          input.addEventListener("blur", () => {
            const address = input.value.trim();
            if (address.length === 0) return;
            setRefundAddressError(validateRefundAddress(address, false));
          });
          if (this.refundAddressDraftFocused) {
            input.focus();
            const start = this.refundAddressDraftSelectionStart ?? input.value.length;
            const end = this.refundAddressDraftSelectionEnd ?? input.value.length;
            input.setSelectionRange(start, end);
          }
          const restoredError = validateRefundAddress(input.value.trim(), false);
          if (restoredError !== undefined) setRefundAddressError(restoredError);
        }
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const attemptId = form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundForm);
          const refundNonce = form.getAttribute(
            OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundNonce,
          );
          const confirm =
            form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm) === "true";
          const refundAddress = input instanceof HTMLInputElement ? input.value.trim() : "";
          if (attemptId === null || refundNonce === null) return;
          const error = validateRefundAddress(refundAddress, true);
          if (error !== undefined) {
            setRefundAddressError(error);
            return;
          }
          setRefundAddressError(undefined);
          void this.refundSwap(attemptId, refundAddress, refundNonce, confirm);
        });
      });

      root
        .querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerTutorial)
        .forEach((button) => {
          button.addEventListener("click", () => {
            const providerId = button.getAttribute(
              OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorial,
            );
            if (providerId === null) return;
            if (providerId === "") {
              this.activeTutorialProviderId = null;
              this.activeTutorialIndex = 0;
              this.activeTutorialCopied = false;
              this.render();
              return;
            }
            const index = Number(
              button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.providerTutorialIndex) ??
                "0",
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
            this.dispatchEvent(createCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy));
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
      // Focus the tutorial dialog only when it OPENS. Focusing on every
      // render yanked keyboard focus back to the dialog once per countdown
      // tick while it was open.
      if (
        tutorial instanceof HTMLElement &&
        this.activeTutorialProviderId !== null &&
        this.focusedTutorialProviderId !== this.activeTutorialProviderId
      ) {
        this.focusedTutorialProviderId = this.activeTutorialProviderId;
        tutorial.focus();
      }
      if (this.activeTutorialProviderId === null) {
        this.focusedTutorialProviderId = null;
      }
    }

    private async startSwap(payInAsset: string): Promise<void> {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      const url = this.resolveOrderUrl(orderId ?? undefined);
      if (url === null || orderId === null || orderId.length === 0) return;
      if (this.startingSwapAsset !== null) return;
      if (
        this.startedSwapInvoice?.swap?.pay_in_asset === payInAsset &&
        this.startedSwapInvoice.invoice_id !== this.dismissedSwapInvoiceId
      ) {
        this.selectedSwapAsset = payInAsset;
        this.render();
        return;
      }
      this.startingSwapAsset = payInAsset;
      this.render();

      try {
        this.swapStartError = undefined;
        this.startedSwapInvoice = await startOpenReceiveSwapRequest(
          globalThis.fetch,
          url,
          orderId,
          payInAsset,
          { logger: options.logger },
        );
        this.dismissedSwapInvoiceId = null;
        // Merge the swap attempt into the snapshot and RE-KEY the controller
        // onto it: without this the status poller kept the pre-swap snapshot
        // (create mode never polled at all; snapshot mode polled the old
        // Lightning hash, which the handler 404s) and a paid swap customer
        // was told "Invoice expired".
        const invoice = this.startedSwapInvoice;
        if (invoice !== undefined) {
          const previous =
            this.latestCheckoutSnapshot ??
            this.currentCheckoutSnapshot() ??
            ({
              checkout_id: invoice.invoice_id,
              order_id: orderId,
              status: "open" as const,
              amount_msats: invoice.amount_msats ?? 0,
              invoices: [],
            } satisfies CheckoutSnapshot);
          const withoutSame = previous.invoices.filter(
            (entry) => entry.invoice_id !== invoice.invoice_id && entry.rail !== "checkout_lock",
          );
          this.handleControllerSnapshot({
            ...previous,
            checkout_id: invoice.invoice_id,
            active: invoice,
            invoices: [invoice, ...withoutSame],
            ...(invoice.amount_msats === undefined ? {} : { amount_msats: invoice.amount_msats }),
          });
          this.startCheckoutController();
        }
        this.selectedSwapAsset = payInAsset;
        this.render();
      } catch (error) {
        // A concurrent start that already landed instructions must not replace
        // the deposit panel with the loser's persist/conflict error.
        if (this.startedSwapInvoice !== undefined) {
          this.selectedSwapAsset = this.startedSwapInvoice.swap?.pay_in_asset ?? payInAsset;
          this.render();
          return;
        }
        // Inline error with retry — never an infinite "Preparing payment
        // address…" spinner (the retry button re-triggers this swap start).
        this.selectedSwapAsset = payInAsset;
        this.swapStartError =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Could not prepare the payment address. Please try again.";
        this.dispatchError(error);
        this.render();
      } finally {
        this.startingSwapAsset = null;
      }
    }

    private async refundSwap(
      attemptId: string,
      refundAddress: string,
      refundNonce: string,
      confirm: boolean,
    ): Promise<void> {
      const orderId = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
      const url = this.resolveOrderUrl(orderId ?? undefined);
      if (url === null) return;

      try {
        const payment = [
          this.startedSwapInvoice,
          ...(this.latestCheckoutSnapshot?.invoices ?? []),
        ].find(
          (invoice) =>
            invoice != null && (invoice.swap?.attempt_id ?? invoice.invoice_id) === attemptId,
        );
        if (payment?.payment_hash === undefined) {
          throw new Error("Swap refund requires the original payment hash.");
        }
        const body = await postOpenReceiveJson(
          globalThis.fetch,
          url,
          {
            ...(orderId === null ? {} : { order_id: orderId }),
            payment_hash: payment.payment_hash,
            action: "refund_swap",
            attempt_id: attemptId,
            refund_address: refundAddress,
            refund_nonce: refundNonce,
            confirm,
          },
          { logger: options.logger },
        );
        this.startedSwapInvoice = normalizeSwapStartInvoice(body);
        this.dismissedSwapInvoiceId = null;
        this.render();
      } catch (error) {
        this.dispatchError(error);
      }
    }

    private currentSwapInvoice(): CheckoutInvoiceSnapshot | undefined {
      const fromSnapshot = this.latestCheckoutSnapshot?.invoices.find(
        (invoice) =>
          invoice.rail === "swap" &&
          invoice.swap !== undefined &&
          invoice.invoice_id !== this.dismissedSwapInvoiceId,
      );
      if (
        this.startedSwapInvoice === undefined ||
        this.startedSwapInvoice.invoice_id === this.dismissedSwapInvoiceId
      ) {
        return fromSnapshot;
      }
      const matched =
        this.latestCheckoutSnapshot?.invoices.find(
          (invoice) => invoice.invoice_id === this.startedSwapInvoice?.invoice_id,
        ) ?? this.startedSwapInvoice;
      return overlayOpenReceiveSwapRefundStaging(matched, this.startedSwapInvoice);
    }

    private renderSwapQrCodes(root: ShadowRoot): void {
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.swapQr).forEach((target) => {
        const payload = target.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapQr);
        if (payload === null) return;
        void createQrPayloadSvg(payload, {
          encoder: options.qrEncoder,
          width: 220,
        })
          .then((svg) => {
            target.innerHTML = svg;
          })
          .catch((error) => this.dispatchError(error));
      });
    }

    private currentThemeOption(): { readonly theme?: "light" | "dark" } {
      const theme = parseOpenReceiveResolvedTheme(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme),
      );
      return theme === undefined ? {} : { theme };
    }

    /** Explicit `theme` attr wins; otherwise inherit nearest ancestor `[data-theme]`. */
    private resolveTheme(): "light" | "dark" {
      const attr = parseOpenReceiveResolvedTheme(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme),
      );
      if (attr !== undefined) return attr;
      const ancestor = this.closest("[data-theme]");
      const inherited = parseOpenReceiveResolvedTheme(ancestor?.getAttribute("data-theme"));
      if (inherited !== undefined) return inherited;
      return "light";
    }

    private syncThemeAncestorObserver(): void {
      const hasOwnTheme =
        parseOpenReceiveResolvedTheme(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme),
        ) !== undefined;
      if (hasOwnTheme) {
        this.stopThemeAncestorObserver();
        return;
      }
      const ancestor = this.closest("[data-theme]");
      if (ancestor === this.observedThemeAncestor && this.themeAncestorObserver !== undefined) {
        return;
      }
      this.stopThemeAncestorObserver();
      if (ancestor === null) return;
      const MutationObserverCtor = globalThis.MutationObserver;
      if (MutationObserverCtor === undefined) return;
      this.observedThemeAncestor = ancestor;
      this.themeAncestorObserver = new MutationObserverCtor(() => {
        this.render();
        this.syncThemeAncestorObserver();
      });
      this.themeAncestorObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }

    private stopThemeAncestorObserver(): void {
      this.themeAncestorObserver?.disconnect();
      this.themeAncestorObserver = undefined;
      this.observedThemeAncestor = null;
    }

    private dispatchError(error: unknown): void {
      this.dispatchEvent(createCheckoutErrorEvent(error));
    }
  }

  class OpenReceiveThemeToggleElement extends HTMLElementCtor {
    private observer: MutationObserver | undefined;
    private observedTarget: Element | null = null;

    static get observedAttributes() {
      return [
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme,
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey,
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
      this.startObserver();
      this.syncTheme();
    }

    disconnectedCallback() {
      this.stopObserver();
    }

    render() {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const inlineStyles = !adoptOpenReceiveCheckoutStyles(root);
      const theme = this.syncTheme();
      root.innerHTML = renderOpenReceiveThemeToggleHtml(theme.toggleLabel, { inlineStyles });
      root
        .querySelector(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS.button)
        ?.addEventListener("click", () => {
          const nextTheme = toggleOpenReceiveStoredThemeControls(
            this.themeTargets(),
            this.themeOptions(),
          );
          this.setAttributeIfChanged(
            OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
            nextTheme.resolvedTheme,
          );
          this.dispatchEvent(createOpenReceiveThemeChangeEvent(nextTheme));
          this.render();
        });
    }

    private syncTheme() {
      const theme = syncOpenReceiveStoredThemeControls(this.themeTargets(), this.themeOptions());
      this.setAttributeIfChanged(
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
        theme.resolvedTheme,
      );
      return theme;
    }

    /**
     * Watch only what can invalidate the toggle: the theme attributes it mirrors,
     * and children arriving under the same wrapper (a checkout element mounted
     * after the toggle). Observing the whole page body with `subtree` ran a
     * querySelector sweep on every unrelated DOM mutation on the host page.
     */
    private startObserver(): void {
      const MutationObserverCtor = globalThis.MutationObserver;
      if (MutationObserverCtor === undefined) return;
      const target = this.themeTargets().root ?? this.ownerDocument.documentElement;
      if (target === null || target === undefined) return;
      if (this.observer !== undefined && this.observedTarget === target) return;
      this.stopObserver();
      this.observedTarget = target;
      this.observer = new MutationObserverCtor(() => {
        this.syncTheme();
      });
      this.observer.observe(target, {
        attributes: true,
        attributeFilter: ["data-theme", "data-openreceive-theme"],
        childList: true,
      });
    }

    private stopObserver(): void {
      this.observer?.disconnect();
      this.observer = undefined;
      this.observedTarget = null;
    }

    private themeTargets() {
      const rootSelector = this.getAttribute(
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector,
      );
      const checkoutSelector = this.getAttribute(
        OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector,
      );
      const button =
        this.shadowRoot?.querySelector(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS.button) ??
        null;
      // Default targets: the nearest wrapper section (it carries data-theme /
      // data-openreceive-theme from the shell binding). Without this, a toggle
      // inside a wrapper only rewrote explicitly configured selectors and the
      // wrapper's own data-theme went stale after the payer toggled; the
      // checkout element then keeps following its ancestor's updated
      // data-theme via its own observer.
      const defaultRoot = this.closest("[data-openreceive-theme]");
      return {
        root:
          rootSelector === null
            ? (defaultRoot ?? undefined)
            : (this.ownerDocument.querySelector(rootSelector) ?? undefined),
        checkout:
          checkoutSelector === null
            ? (defaultRoot?.querySelector(tagName) ?? undefined)
            : (this.ownerDocument.querySelector(checkoutSelector) ?? undefined),
        toggle: button,
      };
    }

    private themeOptions() {
      const defaultTheme = parseOpenReceiveThemePreference(
        this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme),
      );
      return {
        ...(defaultTheme === undefined ? {} : { defaultTheme }),
        ...(this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey) === null
          ? {}
          : {
              storageKey:
                this.getAttribute(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey) ??
                undefined,
            }),
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
