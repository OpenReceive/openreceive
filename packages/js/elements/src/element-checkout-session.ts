// The create-mode lifecycle of the checkout element, lifted out of the element
// class: prepare-once bookkeeping, the "these attributes are ours" re-entrancy
// guard, and the element's half of the shared checkout session.
//
// The mint and the swap start themselves are NOT here — they are the same
// decision React makes, so they live once in
// @openreceive/browser/headless's `createCheckoutSession` and this
// file supplies the element's answers to the two questions that genuinely
// differ: how a new snapshot reaches the screen (attributes + a shadow rebuild
// + a re-keyed poll controller) and where a failure is shown (an inline panel
// plus an `openreceive:error` event).
//
// Every piece of state left here is a DOUBLE-POST GUARD. A second click, a
// poll-driven re-render or an attribute the element wrote itself must not
// become a second request; the comments on each field say which bug that was.
// tests/element-lifecycle.test.mjs pins them.
//
// The element passes itself in as `host`: the session owns the request
// lifecycle and its error strings, the class keeps DOM, attributes and
// rendering.

import {
  applyCheckoutElementAttributes,
  type CheckoutSnapshot,
  createCheckoutElementAttributes,
  createCheckoutSession,
  mergeAttemptIntoCheckout,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_DEFAULT_PREFIX,
  type BrowserLoggerOption,
  type CheckoutPaymentMethod,
  type SwapSelection,
  prepareCheckout,
  requestCheckout,
} from "@openreceive/browser/headless";

/** What the session needs back from the element it drives. */
export interface ElementCheckoutSessionHost {
  /** The custom element: its attributes are the create-mode inputs. */
  readonly element: HTMLElement;
  readonly logger: BrowserLoggerOption | undefined;
  readonly swapSelection: SwapSelection;
  isCreateMode(): boolean;
  render(): void;
  startCheckoutController(): void;
  handleControllerSnapshot(snapshot: CheckoutSnapshot): void;
  latestCheckoutSnapshot(): CheckoutSnapshot | undefined;
  currentCheckoutSnapshot(): CheckoutSnapshot | undefined;
  currentThemeOption(): { readonly theme?: "light" | "dark" };
  createMetadata(): Record<string, unknown> | undefined;
  syncResumePath(reference: string): void;
  /** The mount every server route is derived from, or undefined when there is no order. */
  resolvePollPrefix(reference?: string): string | undefined;
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
  /** Quotes observed per pay-in asset; an unavailable one drives the range pane. */
  readonly swapQuotes: Readonly<Record<string, CheckoutPaymentMethod>>;
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
  // Create-mode bookkeeping: `createdKey` is `${prefix}::${reference}` so prepare runs once
  // per reference/prefix and re-runs when either changes; `creating` guards against overlap.
  // Keep `createdKey` after prepare failure so theme/error DOM churn cannot storm
  // `/checkouts/prepare`.
  let creating = false;
  let createdKey: string | undefined;
  let createError: string | undefined;
  /**
   * Depth of the "these attributes are ours" guard. Attributes the element writes
   * back to itself (the created snapshot, every status/expiry transition) must not
   * re-enter attributeChangedCallback: that rebuilt the shadow tree, replaced the
   * controller and fired another status request for a change the element just made.
   */
  let applyingOwnAttributes = 0;

  /** The prefix the element would act under right now. */
  function currentPrefix(): string {
    return (
      host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix) ??
      OPENRECEIVE_DEFAULT_PREFIX
    );
  }

  /** The order the element would act on right now, or undefined. */
  function currentReference(): string | undefined {
    const reference = host.element.getAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.reference);
    return reference === null || reference.length === 0 ? undefined : reference;
  }

  /** `${prefix}::${reference}` the element would prepare right now, or undefined. */
  function currentCreateKey(): string | undefined {
    const reference = currentReference();
    return reference === undefined ? undefined : `${currentPrefix()}::${reference}`;
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

  /**
   * How a new snapshot reaches the screen in an element: it becomes attributes
   * the element owns, the shadow tree is rebuilt from them, and the poll
   * controller is re-keyed onto the attempt they describe.
   */
  function publishSnapshot(snapshot: CheckoutSnapshot): void {
    host.handleControllerSnapshot(snapshot);
    const prefix = currentPrefix();
    applyOwnAttributes(
      createCheckoutElementAttributes(snapshot, {
        prefix,
        ...host.currentThemeOption(),
      }),
    );
    host.render();
    host.startCheckoutController();
  }

  const session = createCheckoutSession({
    snapshot: () => host.latestCheckoutSnapshot(),
    reference: currentReference,
    requestCheckout: (reference) => {
      const metadata = host.createMetadata();
      return requestCheckout({
        prefix: currentPrefix(),
        reference,
        ...(metadata === undefined ? {} : { metadata }),
        fetch: globalThis.fetch,
      });
    },
    onSnapshot: publishSnapshot,
    swapPrefix: () => host.resolvePollPrefix(currentReference()),
    fetch: () => globalThis.fetch,
    swapSelection: host.swapSelection,
    // A swap attempt is NOT written back as attributes: a bolt11 attribute
    // would take the element out of create mode. It re-keys the poll
    // controller onto the merged snapshot and nothing else.
    onSwapStarted: (invoice) => {
      const reference = currentReference();
      if (reference === undefined) return;
      const previous = host.latestCheckoutSnapshot() ?? host.currentCheckoutSnapshot();
      host.handleControllerSnapshot(mergeAttemptIntoCheckout(invoice, previous, reference));
      host.startCheckoutController();
    },
    logger: host.logger,
    onError: (error) => host.dispatchError(error),
    onChange: () => host.render(),
  });

  async function createCheckout(): Promise<void> {
    const reference = currentReference();
    if (reference === undefined) return;
    const prefix = currentPrefix();
    const key = `${prefix}::${reference}`;
    if (creating) return;
    if (createdKey === key) {
      // Already prepared for this key — a re-mount (framework re-parenting,
      // appendChild moves) reaches this path after disconnectedCallback stopped
      // the controller, so restart polling instead of returning silently. An
      // active swap is never written back as an invoice attribute: without this
      // a paid deposit would never be confirmed after the move.
      host.startCheckoutController();
      return;
    }
    creating = true;
    createdKey = key;
    session.resetLightningRequest();

    try {
      createError = undefined;
      host.syncResumePath(reference);
      // Lock amount without minting a payer Lightning invoice. Bitcoin selection mints later.
      const checkout = await prepareCheckout({
        prefix,
        reference,
        fetch: globalThis.fetch,
      });
      // The host may have re-pointed reference/prefix while this was in flight;
      // applying an older order's attributes here would silently show, and poll,
      // the wrong order. The finally block re-runs for whatever is current.
      if (currentCreateKey() !== key) return;
      host.handleControllerSnapshot(checkout);
      // Apply routing attrs only (no invoice) so render stays in deferred wizard mode.
      // Preserve the host theme attribute so shadow data-theme cannot fall through.
      applyOwnAttributes(
        createCheckoutElementAttributes(checkout, {
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

  return {
    get createError() {
      return createError;
    },
    get wizardError() {
      return session.wizardError;
    },
    get swapStartError() {
      return session.swapStartError;
    },
    get lightningRequested() {
      return session.lightningRequested;
    },
    get mintingLightning() {
      return session.mintingLightning;
    },
    get startingSwapAsset() {
      return session.startingSwapAsset;
    },
    get swapQuotes() {
      return session.swapQuotes;
    },
    get applyingOwnAttributes() {
      return applyingOwnAttributes > 0;
    },
    createCheckout,
    retryCreateCheckout,
    ensureLightning: () => session.ensureLightning(),
    startSwap: (payInAsset) => session.startSwap(payInAsset),
    applyOwnAttributes,
    writeOwnAttributes,
    forgetCreateKey() {
      createdKey = undefined;
    },
  };
}
