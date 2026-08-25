import {
  buildMethodGridEntries,
  type CheckoutController,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutState,
  copyInvoice,
  createCheckoutActionEvent,
  createCheckoutController,
  createCheckoutErrorEvent,
  createCheckoutProviderCopyEvent,
  createCheckoutSnapshotFromInvoice,
  createCheckoutStateEvent,
  createCheckoutStatusModel,
  createPaymentWizardSelection,
  createSwapDisplayModel,
  createThemeChangeEvent,
  createQrPayloadSvg,
  createQrSvg,
  deriveStatus,
  enterCheckoutResumePath,
  findSwapGridGroup,
  getSwapRefundFormError,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_DEFAULT_PREFIX,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type BrowserLoggerOption,
  paymentMethods,
  orClasses,
  overlaySwapRefundStaging,
  parseBooleanAttribute,
  parseMethodPickerKey,
  parseOptionalInteger,
  parsePaymentMethod,
  parseResolvedTheme,
  parseThemePreference,
  requestSwapRefund,
  syncStoredThemeControls,
  toggleStoredThemeControls,
  updatePaymentWizardSelection,
  updateSelectedSwapNetworks,
} from "@openreceive/browser/headless";
import { createElementCheckoutSession } from "./element-checkout-session.ts";
import {
  parseElementRail,
  readElementAmountMsats,
  readElementExpiresAt,
  readElementFiatQuote,
  showElementCopyFeedback,
  wireSwapSelectAllInputs,
} from "./dom-helpers.ts";
import { adoptCheckoutStyles } from "./element-styles.ts";
import {
  renderCheckoutCreateErrorHtml,
  renderCheckoutCreatingHtml,
  renderCheckoutHtml,
  renderThemeToggleHtml,
} from "./render-checkout.ts";
import {
  type DefineElementsOptions,
  type ElementsSwapOption,
  parseElementInvoiceId,
  parseElementStatus,
  transactionStateFromStatus,
} from "./views.ts";

const DEFAULT_TAG_NAME = OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;

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

/**
 * Display-affecting snapshot fields only, so a poll that changes nothing visible skips a
 * render. Everything is keyed verbatim except `active` (already one of `invoices`),
 * `paid_at` (`status` flips whenever it appears), and each invoice's own amount/fiat
 * quote (the rendered amount rides on the snapshot itself).
 */
function checkoutSnapshotDisplayKey(snapshot: CheckoutSnapshot): string {
  const { active: _active, paid_at: _paidAt, invoices, ...display } = snapshot;
  return JSON.stringify({
    ...display,
    invoices: invoices.map(
      ({ amount_msats: _amountMsats, fiat_quote: _fiatQuote, ...invoice }) => invoice,
    ),
  });
}

/**
 * Register the OpenReceive custom elements with the browser's element
 * registry. Until this runs, `<openreceive-checkout>` and
 * `<openreceive-theme-toggle>` are unknown tags the browser renders as
 * nothing; once it runs, every such tag on the page — already in the HTML or
 * added later — upgrades into the live checkout / theme toggle. Call it once
 * from your page's JS; order relative to the markup does not matter, and
 * calling it again skips tags that are already defined.
 */
export function defineElements(options: DefineElementsOptions = {}): void {
  const registry = options.registry ?? globalThis.customElements;
  const HTMLElementCtor = globalThis.HTMLElement;
  const tagName = options.tagName ?? DEFAULT_TAG_NAME;
  const themeToggleTagName =
    options.themeToggleTagName ?? OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;

  if (registry === undefined || HTMLElementCtor === undefined) {
    throw new Error("Custom elements are unavailable in this environment.");
  }

  class CheckoutElement extends HTMLElementCtor {
    private selection = createPaymentWizardSelection();
    private activeTutorialProviderId: string | null = null;
    private activeTutorialIndex = 0;
    private activeTutorialCopied = false;
    private swapOptions: readonly ElementsSwapOption[] = [];
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
    private announcedSettledReference: string | undefined;
    /** Last applied state, used to detect countdown-only ticks (partial DOM update). */
    private lastCheckoutState: CheckoutState | undefined;
    /** Refund-address draft survives poll rebuilds of the shadow tree. */
    private refundAddressDraft = "";
    private refundAddressDraftFocused = false;
    private refundAddressDraftSelectionStart: number | null = null;
    private refundAddressDraftSelectionEnd: number | null = null;
    /** Tutorial provider whose dialog was last focused, so re-renders don't re-steal focus. */
    private focusedTutorialProviderId: string | null = null;
    /**
     * Create mode's whole request lifecycle — prepare-once, the deferred
     * Lightning mint, the swap start — plus the guard that keeps attributes the
     * element writes itself out of attributeChangedCallback. Every one of those
     * is a double-POST guard, which is why they live together.
     */
    private readonly session = createElementCheckoutSession({
      element: this,
      logger: options.logger,
      swapSelection: {
        started: () => this.startedSwapInvoice,
        setStarted: (invoice) => {
          this.startedSwapInvoice = invoice;
        },
        dismissedInvoiceId: () => this.dismissedSwapInvoiceId,
        setDismissedInvoiceId: (invoiceId) => {
          this.dismissedSwapInvoiceId = invoiceId;
        },
        setSelectedAsset: (payInAsset) => {
          this.selectedSwapAsset = payInAsset;
        },
      },
      isCreateMode: () => this.isCreateMode(),
      render: () => {
        this.render();
      },
      startCheckoutController: () => {
        this.startCheckoutController();
      },
      handleControllerSnapshot: (snapshot) => {
        this.handleControllerSnapshot(snapshot);
      },
      latestCheckoutSnapshot: () => this.latestCheckoutSnapshot,
      currentCheckoutSnapshot: () => this.currentCheckoutSnapshot(),
      currentThemeOption: () => this.currentThemeOption(),
      createMetadata: () => this.createMetadata(),
      syncResumePath: (reference) => {
        this.syncResumePath(reference);
      },
      resolvePollPrefix: (reference) => this.resolvePollPrefix(reference),
      dispatchError: (error) => {
        this.dispatchError(error);
      },
    });
    /** When `theme` is unset, follow the nearest ancestor `[data-theme]` (e.g. ThemeScope). */
    private themeAncestorObserver: MutationObserver | undefined;
    private observedThemeAncestor: Element | null = null;

    static get observedAttributes() {
      return [
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference,
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
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeReference,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.polling,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.pollIntervalMs,
        OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.decodeLinkUrl,
      ];
    }

    connectedCallback() {
      this.render();
      this.syncThemeAncestorObserver();
      if (this.isCreateMode()) {
        void this.session.createCheckout();
        return;
      }
      this.startCheckoutController();
    }

    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
      if (!this.isConnected || this.session.applyingOwnAttributes) return;
      if (oldValue === newValue) return;

      // Display-only attributes (theme, the resume-path trio) never change what is
      // polled: rebuilding the controller for them fired an extra POST
      // /payments/check on every cosmetic theme flip.
      const displayOnly =
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeReference ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.decodeLinkUrl;
      if (displayOnly) {
        this.render();
        this.syncThemeAncestorObserver();
        return;
      }

      // Polling attributes change WHAT the controller does, in both modes: a
      // create-mode element that returned before startCheckoutController here
      // ignored polling="false" until the next snapshot re-key.
      const pollingChanged =
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.polling ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.pollIntervalMs;
      if (pollingChanged) {
        this.render();
        this.syncThemeAncestorObserver();
        this.startCheckoutController();
        return;
      }

      const createInputChanged =
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix ||
        name === OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice;
      if (createInputChanged) {
        this.session.forgetCreateKey();
      }

      if (this.isCreateMode()) {
        this.render();
        this.syncThemeAncestorObserver();
        // Theme/status attrs must not re-prepare; only create inputs may.
        if (createInputChanged) {
          void this.session.createCheckout();
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

    // Create mode: a `reference` is set but no `invoice` snapshot is provided. The element
    // owns the whole lifecycle — it prepares the checkout against
    // `${prefix}/checkouts/prepare` (locking the amount without minting), mints a Lightning
    // invoice only when the payer picks Bitcoin, then polls status against
    // `${prefix}/payments/check` and drives swaps under the prefix.
    private isCreateMode(): boolean {
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      const reference = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference);
      return (invoice === null || invoice === "") && reference !== null && reference.length > 0;
    }

    /**
     * Create-time metadata from the JSON `metadata` attribute.
     *
     * Read lazily, at mint time — which is why `metadata` is deliberately NOT a
     * create input: a host that changes it after mount is picked up by the next
     * mint, and re-keying the prepared checkout for it would orphan the
     * prepared attempt for nothing.
     *
     * Host-authored like `poll-interval-ms`, and ruled the same way: a value
     * that is not a JSON object is a host typo and must be heard, not silently
     * dropped from the create request.
     */
    private createMetadata(): Record<string, unknown> | undefined {
      const raw = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.metadata);
      if (raw === null || raw.length === 0) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new TypeError(
          `metadata must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("metadata must be a JSON object");
      }
      return parsed as Record<string, unknown>;
    }

    /** Order data belongs to the host; this only performs optional History API sync. */
    private syncResumePath(reference: string): void {
      const syncUrl = parseBooleanAttribute(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl),
      );
      if (syncUrl) {
        const resumePathPrefix =
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix) ??
          "/checkout";
        const routeReference =
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeReference) ?? undefined;
        enterCheckoutResumePath(reference, {
          pathPrefix: resumePathPrefix,
          ...(routeReference === undefined || routeReference.length === 0
            ? {}
            : { routeReference }),
        });
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
        this.startedSwapInvoice = overlaySwapRefundStaging(swapInvoice, this.startedSwapInvoice);
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
          if (this.session.createError !== undefined) {
            root.innerHTML = renderCheckoutCreateErrorHtml(this.session.createError, {
              theme: this.resolveTheme(),
              inlineStyles,
            });
            root
              .querySelector('[part="retry"]')
              ?.addEventListener("click", () => this.session.retryCreateCheckout());
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

      const invoiceId = parseElementInvoiceId(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId),
      );

      const invoice = invoiceAttr ?? "";
      const lightningRequested =
        !this.isCreateMode() || this.session.lightningRequested || invoice.length > 0;
      const decodeLinkUrl =
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.decodeLinkUrl) ?? undefined;
      // The shared session quotes before it starts, so an out-of-range amount
      // arrives here as an unavailable quote — the same pane React shows.
      const selectedQuote =
        this.selectedSwapAsset === null
          ? undefined
          : this.session.swapQuotes[this.selectedSwapAsset];
      const unavailableSwapQuote = selectedQuote?.available === false ? selectedQuote : undefined;
      const { root, inlineStyles } = this.prepareShadowRoot();
      root.innerHTML = renderCheckoutHtml({
        inlineStyles,
        ...(decodeLinkUrl === undefined ? {} : { decodeLinkUrl }),
        invoice_id: invoiceId,
        invoice,
        rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
        payment_hash:
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash) ?? undefined,
        amount_msats: readElementAmountMsats(this),
        fiat_quote: readElementFiatQuote(this),
        status: parseElementStatus(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status),
        ),
        expires_at: readElementExpiresAt(this),
        theme: this.resolveTheme(),
        payment_wizard: parseBooleanAttribute(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard),
        ),
        lightningRequested: this.session.mintingLightning ? false : lightningRequested,
        wizard: {
          selectedMethod: this.selection.selectedMethod,
          selectedBitcoinRoute: this.selection.selectedBitcoinRoute,
          swapOptions: this.swapOptions,
          currenciesLoading: !this.swapOptionsLoaded,
          selectedSwapNetworks: this.selectedSwapNetworks,
          selectedPickerKey: this.selectedPickerKey,
          startingSwapAsset: this.session.startingSwapAsset,
          selectedSwapAsset: this.selectedSwapAsset,
          ...(this.latestCheckoutSnapshot?.amount_msats === undefined
            ? {}
            : { amountMsats: this.latestCheckoutSnapshot.amount_msats }),
          ...(this.latestCheckoutSnapshot?.fiat === undefined
            ? {}
            : { fiat: this.latestCheckoutSnapshot.fiat }),
          ...(this.latestCheckoutSnapshot?.reference === undefined
            ? {}
            : { reference: this.latestCheckoutSnapshot.reference }),
          ...(this.latestCheckoutSnapshot?.checkout_id === undefined
            ? {}
            : { checkoutId: this.latestCheckoutSnapshot.checkout_id }),
          lightningInvoice: invoice,
          ...(decodeLinkUrl === undefined ? {} : { decodeLinkUrl }),
          ...(options.resolveAssetUrl === undefined
            ? {}
            : { resolveAssetUrl: options.resolveAssetUrl }),
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
          ...(this.session.swapStartError === undefined
            ? {}
            : { swapStartError: this.session.swapStartError }),
          ...(unavailableSwapQuote === undefined ? {} : { unavailableSwapQuote }),
          ...(this.latestCheckoutSnapshot === undefined
            ? {}
            : { swapLimitContext: this.latestCheckoutSnapshot }),
          ...(this.session.wizardError === undefined
            ? {}
            : { wizardError: this.session.wizardError }),
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
      return { root, inlineStyles: !adoptCheckoutStyles(root) };
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
      const prefix = this.resolvePollPrefix(snapshot?.reference);
      if (snapshot === undefined) {
        this.stopCheckoutController();
        return;
      }

      // `polling="false"` renders the snapshot (countdown included) without ever
      // POSTing /payments/check, matching React's `polling` prop.
      const polling =
        parseBooleanAttribute(
          this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.polling),
        ) !== false;
      // The one attribute still read STRICTLY, and the only one left that may
      // be: `createCheckoutElementAttributes` writes it from its caller's own
      // `options.pollIntervalMs` and never from a server field, so a value that
      // is not a poll interval is a host typo and must be heard. See
      // `readElementNumberAttribute` in ./dom-helpers.ts for the per-attribute
      // ruling.
      const pollIntervalMs = parseOptionalInteger(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.pollIntervalMs),
        { label: "poll-interval-ms" },
      );
      this.stopCheckoutController();
      this.controller = createCheckoutController({
        snapshot,
        ...(prefix === undefined || !polling ? {} : { prefix }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
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
     * The mount every server route is derived from, matching React snapshot
     * mode: the `prefix` attribute, default `/openreceive`. Answers `undefined`
     * when there is no order to act on — nothing to poll, nothing to swap.
     */
    private resolvePollPrefix(reference?: string): string | undefined {
      const id = reference ?? this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference);
      if (id === null || id === undefined || id.length === 0) return undefined;
      return (
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
        OPENRECEIVE_DEFAULT_PREFIX
      );
    }

    private currentCheckoutSnapshot(): CheckoutSnapshot | undefined {
      const reference = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference);
      const invoiceId = parseElementInvoiceId(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId),
      );
      const invoice = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice);
      // The same create-mode discriminator render() applies: with no invoice-id
      // there is no attempt to build a snapshot from, and undefined simply
      // leaves the poll controller with nothing to poll.
      if (invoiceId === undefined || invoice === null) return undefined;
      const amountMsats = readElementAmountMsats(this);
      const expiresAt = readElementExpiresAt(this);
      const fiatQuote = readElementFiatQuote(this);
      const paymentHash = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash);
      // The ONLY path from raw HTML attributes to a snapshot (declarative / SSR
      // usage). The attributes describe one attempt; the checkout around it is
      // invented by createCheckoutSnapshotFromInvoice.
      return createCheckoutSnapshotFromInvoice(
        {
          invoice_id: invoiceId,
          invoice,
          rail: parseElementRail(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail)),
          ...(paymentHash === null ? {} : { payment_hash: paymentHash }),
          ...(amountMsats === undefined ? {} : { amount_msats: amountMsats }),
          ...(fiatQuote === undefined ? {} : { fiat_quote: fiatQuote }),
          transaction_state: transactionStateFromStatus(
            parseElementStatus(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status)) ??
              "pending",
          ),
          ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
        },
        { ...(reference === null ? {} : { reference: reference }) },
      );
    }

    private applyCheckoutState(state: CheckoutState): void {
      const previous = this.lastCheckoutState;
      this.lastCheckoutState = state;
      // These mirror the controller's state back onto the element. Left
      // unsuppressed, every real transition re-entered attributeChangedCallback
      // and rebuilt the shadow tree, replaced the controller, and fired another
      // POST /payments/check for a change that had just arrived from one.
      this.session.writeOwnAttributes(() => {
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
      });
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
      if (state.settled && state.reference !== this.announcedSettledReference) {
        this.announcedSettledReference = state.reference;
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
        const display = createSwapDisplayModel(swapInvoice, {});
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
      logger: BrowserLoggerOption | undefined,
    ): void {
      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.method).forEach((button) => {
        button.addEventListener("click", () => {
          if (button.hasAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerContinue)) return;
          if (button.hasAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect)) return;
          const method = parsePaymentMethod(
            button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method),
          );
          if (method === null) return;
          this.selectedPickerKey = null;
          this.selection = updatePaymentWizardSelection(this.selection, {
            type: "select_method",
            method,
          });
          if (method === "bitcoin") {
            void this.session.ensureLightning();
          }
          this.render();
        });
      });

      root.querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.pickerSelect).forEach((button) => {
        button.addEventListener("click", () => {
          if (!(button instanceof HTMLButtonElement) || button.disabled) return;
          const key = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.pickerSelect);
          if (key === null || key.length === 0) return;
          const methodPick = parseMethodPickerKey(key);
          if (methodPick !== null) {
            const method = parsePaymentMethod(methodPick.methodId);
            if (method === null) return;
            this.selectedPickerKey = null;
            this.selection = updatePaymentWizardSelection(this.selection, {
              type: "select_method",
              method,
            });
            if (method === "bitcoin") {
              void this.session.ensureLightning();
            }
            this.render();
            return;
          }
          const previousKey = this.selectedPickerKey;
          this.selectedPickerKey = key;
          const entries = buildMethodGridEntries(paymentMethods, this.swapOptions);
          const nextGroup = findSwapGridGroup(entries, key);
          if (nextGroup !== undefined && nextGroup.options.length === 1) {
            const option =
              nextGroup.options.find((entry) => entry.available !== false) ?? nextGroup.options[0];
            if (option === undefined || option.available === false) return;
            this.selectedPickerKey = null;
            void this.session.startSwap(option.pay_in_asset);
            return;
          }
          this.selectedSwapNetworks = updateSelectedSwapNetworks({
            entries,
            nextKey: key,
            previousKey,
            selectedNetworks: this.selectedSwapNetworks,
          });
          this.render();
        });
      });

      root
        .querySelectorAll(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.pickerContinue)
        .forEach((button) => {
          button.addEventListener("click", () => {
            if (!(button instanceof HTMLButtonElement) || button.disabled) return;
            const method = parsePaymentMethod(
              button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.method),
            );
            if (method !== null) {
              this.selection = updatePaymentWizardSelection(this.selection, {
                type: "select_method",
                method,
              });
              this.render();
              return;
            }
            const payInAsset = button.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapStart);
            if (payInAsset === null) return;
            markElementConfirmButtonBusy(button);
            void this.session.startSwap(payInAsset);
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
            this.selection = updatePaymentWizardSelection(this.selection, {
              type: "change_method",
            });
            this.render();
            return;
          }
          if (target === "route") {
            this.selection = updatePaymentWizardSelection(this.selection, {
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
          this.selection = updatePaymentWizardSelection(this.selection, {
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
          void this.session.startSwap(payInAsset);
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
          void this.session.ensureLightning();
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
          if (address.length === 0 && !showEmpty) return undefined;
          return getSwapRefundFormError(payInAsset, address, networkLabel);
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
          const refundAllowed =
            form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundAllowed) === "true";
          const confirm =
            form.getAttribute(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES.swapRefundConfirm) === "true";
          const refundAddress = input instanceof HTMLInputElement ? input.value.trim() : "";
          if (attemptId === null || !refundAllowed) return;
          const error = validateRefundAddress(refundAddress, true);
          if (error !== undefined) {
            setRefundAddressError(error);
            return;
          }
          setRefundAddressError(undefined);
          void this.refundSwap(attemptId, refundAddress, confirm);
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

    private async refundSwap(
      attemptId: string,
      refundAddress: string,
      confirm: boolean,
    ): Promise<void> {
      const reference = this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference);
      const prefix = this.resolvePollPrefix(reference ?? undefined);
      if (prefix === undefined) return;

      try {
        this.startedSwapInvoice = await requestSwapRefund({
          fetch: globalThis.fetch,
          prefix,
          ...(reference === null ? {} : { reference }),
          invoices: [this.startedSwapInvoice, ...(this.latestCheckoutSnapshot?.invoices ?? [])],
          attemptId,
          refundAddress,
          confirm,
          logger: options.logger,
        });
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
      return overlaySwapRefundStaging(matched, this.startedSwapInvoice);
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
      const theme = parseResolvedTheme(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme),
      );
      return theme === undefined ? {} : { theme };
    }

    /** Explicit `theme` attr wins; otherwise inherit nearest ancestor `[data-theme]`. */
    private resolveTheme(): "light" | "dark" {
      const attr = parseResolvedTheme(
        this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme),
      );
      if (attr !== undefined) return attr;
      const ancestor = this.closest("[data-theme]");
      const inherited = parseResolvedTheme(ancestor?.getAttribute("data-theme"));
      if (inherited !== undefined) return inherited;
      return "light";
    }

    private syncThemeAncestorObserver(): void {
      const hasOwnTheme =
        parseResolvedTheme(this.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme)) !==
        undefined;
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

  class ThemeToggleElement extends HTMLElementCtor {
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
    }

    attributeChangedCallback() {
      if (!this.isConnected) return;
      this.render();
      this.startObserver();
    }

    disconnectedCallback() {
      this.stopObserver();
    }

    render() {
      const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      const inlineStyles = !adoptCheckoutStyles(root);
      const theme = this.syncTheme();
      root.innerHTML = renderThemeToggleHtml(theme.toggleLabel, { inlineStyles });
      root
        .querySelector(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS.button)
        ?.addEventListener("click", () => {
          const nextTheme = toggleStoredThemeControls(this.themeTargets(), this.themeOptions());
          this.dispatchEvent(createThemeChangeEvent(nextTheme));
          this.render();
        });
    }

    private syncTheme() {
      return syncStoredThemeControls(this.themeTargets(), this.themeOptions());
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
      const defaultTheme = parseThemePreference(
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
  }

  if (registry.get(tagName) === undefined) {
    registry.define(tagName, CheckoutElement);
  }
  if (registry.get(themeToggleTagName) === undefined) {
    registry.define(themeToggleTagName, ThemeToggleElement);
  }
}
