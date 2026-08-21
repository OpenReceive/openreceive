// The create-mode lifecycle of the checkout element, lifted out of the element
// class: prepare-once bookkeeping, the deferred Lightning mint, the swap start,
// and the "these attributes are ours" re-entrancy guard.
//
// Every piece of state here is a DOUBLE-POST GUARD. A second click, a poll-driven
// re-render or an attribute the element wrote itself must not become a second
// request; the comments on each field say which bug that was.
// tests/element-lifecycle.test.mjs pins them.
//
// The element passes itself in as `host`: the session owns the request lifecycle
// and its error strings, the class keeps DOM, attributes and rendering.

import {
  applyCheckoutElementAttributes,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  createCheckoutElementAttributes,
  findOpenReceiveReusableLightningInvoice,
  mergeOpenReceiveAttemptIntoCheckout,
  mergeOpenReceiveAttemptIntoSnapshot,
  mergeOpenReceiveMintedCheckout,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_DEFAULT_PREFIX,
  type OpenReceiveBrowserLoggerOption,
  prepareCheckout,
  requestCheckout,
  resolveOrderUrlFromPrefix,
  startOpenReceiveSwapRequest,
} from "@openreceive/browser/internal";

/**
 * The swap attempt the wizard is showing. It is element state (the breadcrumb
 * and the deposit panel read it), so the session reads and writes it through
 * the host rather than owning a second copy.
 */
export interface ElementSwapSelection {
  started(): CheckoutInvoiceSnapshot | undefined;
  setStarted(invoice: CheckoutInvoiceSnapshot): void;
  dismissedInvoiceId(): string | null;
  setDismissedInvoiceId(invoiceId: string | null): void;
  setSelectedAsset(payInAsset: string | null): void;
}

/** What the session needs back from the element it drives. */
export interface ElementCheckoutSessionHost {
  /** The custom element: its attributes are the create-mode inputs. */
  readonly element: HTMLElement;
  readonly logger: OpenReceiveBrowserLoggerOption | undefined;
  readonly swapSelection: ElementSwapSelection;
  isCreateMode(): boolean;
  render(): void;
  startCheckoutController(): void;
  handleControllerSnapshot(snapshot: CheckoutSnapshot): void;
  latestCheckoutSnapshot(): CheckoutSnapshot | undefined;
  currentCheckoutSnapshot(): CheckoutSnapshot | undefined;
  currentThemeOption(): { readonly theme?: "light" | "dark" };
  createMetadata(): Record<string, unknown> | undefined;
  syncResumePath(orderId: string): void;
  resolveOrderUrl(orderId?: string): string | null;
  dispatchError(error: unknown): void;
}

export interface ElementCheckoutSession {
  /** Create-mode prepare failure shown inline with a retry button. */
  readonly createError: string | undefined;
  /** Lightning mint failure shown inline in the wizard. */
  readonly wizardError: string | undefined;
  /** Swap-start failure shown inline in the deposit slot with a retry button. */
  readonly swapStartError: string | undefined;
  /** Create-mode: Lightning QR is deferred until the payer selects Bitcoin. */
  readonly lightningRequested: boolean;
  readonly mintingLightning: boolean;
  /** In-flight swap create; a second click must not mint a colliding attempt. */
  readonly startingSwapAsset: string | null;
  /** True while the element is writing attributes it owns. */
  readonly applyingOwnAttributes: boolean;
  createCheckout(): Promise<void>;
  retryCreateCheckout(): void;
  ensureLightning(): Promise<void>;
  startSwap(payInAsset: string): Promise<void>;
  /** Write attributes the element owns without re-entering attributeChangedCallback. */
  applyOwnAttributes(attributes: Parameters<typeof applyCheckoutElementAttributes>[1]): void;
  /** Run a block of self-writes under the same guard, for conditional writes. */
  writeOwnAttributes(write: () => void): void;
  /** A create input changed: the next connect/render may prepare again. */
  forgetCreateKey(): void;
}

export function createElementCheckoutSession(
  host: ElementCheckoutSessionHost,
): ElementCheckoutSession {
  // Create-mode bookkeeping: `createdKey` is `${prefix}::${orderId}` so prepare runs once
  // per order/prefix and re-runs when either changes; `creating` guards against overlap.
  // Keep `createdKey` after prepare failure so theme/error DOM churn cannot storm
  // `/checkouts/prepare`.
  let creating = false;
  let createdKey: string | undefined;
  let createError: string | undefined;
  let wizardError: string | undefined;
  let swapStartError: string | undefined;
  let lightningRequested = false;
  let mintingLightning = false;
  let startingSwapAsset: string | null = null;
  /**
   * Depth of the "these attributes are ours" guard. Attributes the element writes
   * back to itself (the created snapshot, every status/expiry transition) must not
   * re-enter attributeChangedCallback: that rebuilt the shadow tree, replaced the
   * controller and fired another status request for a change the element just made.
   */
  let applyingOwnAttributes = 0;

  /** `${prefix}::${orderId}` the element would prepare right now, or undefined. */
  function currentCreateKey(): string | undefined {
    const orderId = host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
    if (orderId === null || orderId.length === 0) return undefined;
    const prefix =
      host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
      OPENRECEIVE_DEFAULT_PREFIX;
    return `${prefix}::${orderId}`;
  }

  function writeOwnAttributes(write: () => void): void {
    applyingOwnAttributes += 1;
    try {
      write();
    } finally {
      applyingOwnAttributes -= 1;
    }
  }

  function applyOwnAttributes(
    attributes: Parameters<typeof applyCheckoutElementAttributes>[1],
  ): void {
    writeOwnAttributes(() => {
      applyCheckoutElementAttributes(host.element, attributes);
    });
  }

  async function createCheckout(): Promise<void> {
    const orderId = host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
    if (orderId === null || orderId.length === 0) return;
    const prefix =
      host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
      OPENRECEIVE_DEFAULT_PREFIX;
    const key = `${prefix}::${orderId}`;
    if (creating || createdKey === key) return;
    creating = true;
    createdKey = key;
    lightningRequested = false;

    try {
      createError = undefined;
      host.syncResumePath(orderId);
      // Lock amount without minting a payer Lightning invoice. Bitcoin selection mints later.
      const checkout = await prepareCheckout({
        prefix,
        orderId,
        fetch: globalThis.fetch,
      });
      // The host may have re-pointed order-id/prefix while this was in flight;
      // applying an older order's attributes here would silently show, and poll,
      // the wrong order. The finally block re-runs for whatever is current.
      if (currentCreateKey() !== key) return;
      host.handleControllerSnapshot(checkout);
      const orderUrl = resolveOrderUrlFromPrefix(prefix);
      // Apply routing attrs only (no invoice) so render stays in deferred wizard mode.
      // Preserve the host theme attribute so shadow data-theme cannot fall through.
      applyOwnAttributes(
        createCheckoutElementAttributes(checkout, {
          orderUrl,
          prefix,
          ...host.currentThemeOption(),
        }),
      );
      host.render();
      host.startCheckoutController();
    } catch (error) {
      if (currentCreateKey() !== key) return;
      // Leave createdKey set so theme sync / host error DOM updates cannot retry-storm.
      // The payer sees an inline error with a retry button instead of an
      // infinite "Creating checkout…" spinner.
      createError =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not start checkout.";
      host.dispatchError(error);
      host.render();
    } finally {
      creating = false;
      const current = currentCreateKey();
      if (
        host.element.isConnected &&
        current !== undefined &&
        current !== key &&
        host.isCreateMode()
      ) {
        void createCheckout();
      }
    }
  }

  /** Explicit payer retry after a failed prepare. */
  function retryCreateCheckout(): void {
    createdKey = undefined;
    createError = undefined;
    host.render();
    void createCheckout();
  }

  async function ensureLightning(): Promise<void> {
    // A second click while the first mint is in flight would POST /checkouts
    // again; the loser's 409 then surfaced as a wizard error over a perfectly
    // good invoice. `startSwap` guards the same way.
    if (mintingLightning) return;
    const orderId = host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
    if (orderId === null || orderId.length === 0) return;
    const prefix =
      host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
      OPENRECEIVE_DEFAULT_PREFIX;
    const current = host.latestCheckoutSnapshot();
    if (current !== undefined) {
      const reusableLightning = findOpenReceiveReusableLightningInvoice(current);
      if (reusableLightning !== undefined) {
        const focused = mergeOpenReceiveAttemptIntoSnapshot(reusableLightning, current);
        host.handleControllerSnapshot(focused);
        lightningRequested = true;
        applyOwnAttributes(
          createCheckoutElementAttributes(focused, {
            orderUrl: resolveOrderUrlFromPrefix(prefix),
            prefix,
            ...host.currentThemeOption(),
          }),
        );
        host.render();
        host.startCheckoutController();
        return;
      }
    }
    mintingLightning = true;
    wizardError = undefined;
    host.render();
    try {
      const metadata = host.createMetadata();
      const checkout = await requestCheckout({
        prefix,
        orderId,
        ...(metadata === undefined ? {} : { metadata }),
        fetch: globalThis.fetch,
      });
      const merged = mergeOpenReceiveMintedCheckout(checkout, host.latestCheckoutSnapshot());
      host.handleControllerSnapshot(merged);
      lightningRequested = true;
      applyOwnAttributes(
        createCheckoutElementAttributes(merged, {
          orderUrl: resolveOrderUrlFromPrefix(prefix),
          prefix,
          ...host.currentThemeOption(),
        }),
      );
      host.render();
      host.startCheckoutController();
    } catch (error) {
      // Surface the mint failure inline (the server's message travels on the
      // thrown error) instead of silently returning to the method picker.
      wizardError =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not create the Lightning invoice. Please try again.";
      host.dispatchError(error);
    } finally {
      mintingLightning = false;
      host.render();
    }
  }

  async function startSwap(payInAsset: string): Promise<void> {
    const orderId = host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId);
    const url = host.resolveOrderUrl(orderId ?? undefined);
    if (url === null || orderId === null || orderId.length === 0) return;
    if (startingSwapAsset !== null) return;
    const alreadyStarted = host.swapSelection.started();
    if (
      alreadyStarted?.swap?.pay_in_asset === payInAsset &&
      alreadyStarted.invoice_id !== host.swapSelection.dismissedInvoiceId()
    ) {
      host.swapSelection.setSelectedAsset(payInAsset);
      host.render();
      return;
    }
    startingSwapAsset = payInAsset;
    host.render();

    try {
      swapStartError = undefined;
      const started = await startOpenReceiveSwapRequest(
        globalThis.fetch,
        url,
        orderId,
        payInAsset,
        { logger: host.logger },
      );
      host.swapSelection.setStarted(started);
      host.swapSelection.setDismissedInvoiceId(null);
      // Merge the swap attempt into the snapshot and RE-KEY the controller
      // onto it: without this the status poller kept the pre-swap snapshot
      // (create mode never polled at all; snapshot mode polled the old
      // Lightning hash, which the handler 404s) and a paid swap customer
      // was told "Invoice expired".
      const invoice = host.swapSelection.started();
      if (invoice !== undefined) {
        const previous = host.latestCheckoutSnapshot() ?? host.currentCheckoutSnapshot();
        host.handleControllerSnapshot(
          mergeOpenReceiveAttemptIntoCheckout(invoice, previous, orderId),
        );
        host.startCheckoutController();
      }
      host.swapSelection.setSelectedAsset(payInAsset);
      host.render();
    } catch (error) {
      // A concurrent start that already landed instructions must not replace
      // the deposit panel with the loser's persist/conflict error.
      const landed = host.swapSelection.started();
      if (landed !== undefined) {
        host.swapSelection.setSelectedAsset(landed.swap?.pay_in_asset ?? payInAsset);
        host.render();
        return;
      }
      // Inline error with retry — never an infinite "Preparing payment
      // address…" spinner (the retry button re-triggers this swap start).
      host.swapSelection.setSelectedAsset(payInAsset);
      swapStartError =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Could not prepare the payment address. Please try again.";
      host.dispatchError(error);
      host.render();
    } finally {
      startingSwapAsset = null;
    }
  }

  return {
    get createError() {
      return createError;
    },
    get wizardError() {
      return wizardError;
    },
    get swapStartError() {
      return swapStartError;
    },
    get lightningRequested() {
      return lightningRequested;
    },
    get mintingLightning() {
      return mintingLightning;
    },
    get startingSwapAsset() {
      return startingSwapAsset;
    },
    get applyingOwnAttributes() {
      return applyingOwnAttributes > 0;
    },
    createCheckout,
    retryCreateCheckout,
    ensureLightning,
    startSwap,
    applyOwnAttributes,
    writeOwnAttributes,
    forgetCreateKey() {
      createdKey = undefined;
    },
  };
}
