import { status as deriveStatus } from "../status.ts";
import { assertOpenReceiveDisplayInvoice } from "./checkout-invoice.ts";
import { isPaidCheckoutSnapshot, selectCheckoutDisplayInvoice } from "./checkout-state.ts";
import { applyOpenReceiveThemeAttributes, createOpenReceiveStoredThemeModel } from "./theme.ts";
import {
  type CheckoutElementAttributeOptions,
  type CheckoutElementAttributes,
  type CheckoutElementEventHandlers,
  type CheckoutElementListeners,
  type CheckoutElementTarget,
  type CheckoutShellElements,
  type CheckoutShellModel,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type CreateCheckoutShellOptions,
  type CreateOpenReceiveThemeToggleElementOptions,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes,
} from "./ui.ts";

/**
 * Attributes every mode carries: routing, theming, and the create-time options the
 * element re-reads later (`metadata` is read when Lightning is finally minted, the
 * resume-path trio when the element syncs the URL). Snapshot mode has already
 * created the attempt, so the create-time options are not emitted there.
 */
function createModeAttributes(options: CheckoutElementAttributeOptions): CheckoutElementAttributes {
  const attributes: CheckoutElementAttributes = {};
  if (options.metadata !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.metadata] = JSON.stringify(options.metadata);
  }
  if (options.syncUrl === true) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.syncUrl] = "";
  }
  if (options.resumePathPrefix !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.resumePathPrefix] = options.resumePathPrefix;
  }
  if (options.routeOrderId !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeOrderId] = options.routeOrderId;
  }
  return attributes;
}

function sharedElementAttributes(
  options: CheckoutElementAttributeOptions,
): CheckoutElementAttributes {
  const attributes: CheckoutElementAttributes = {};
  // An unbound framework prop arrives as `null` from Vue/Svelte/Angular and as
  // `undefined` from React; both mean "not set" and must leave the attribute
  // off entirely, so the element falls back to its own default.
  const isSet = <T>(value: T | null | undefined): value is T =>
    value !== undefined && value !== null;
  if (isSet(options.prefix)) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix] = options.prefix;
  }
  if (isSet(options.theme)) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme] = options.theme;
  }
  if (options.paymentWizard !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard] = String(
      options.paymentWizard,
    );
  }
  if (options.decodeLinkUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.decodeLinkUrl] = options.decodeLinkUrl;
  }
  if (options.polling !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.polling] = String(options.polling);
  }
  if (options.pollIntervalMs !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.pollIntervalMs] = String(
      options.pollIntervalMs,
    );
  }
  return attributes;
}

/**
 * Attributes for `<openreceive-checkout>` in each of its three modes:
 *
 * - **create** (`snapshot === null`): routing + theming + the create-time options.
 *   The element owns the whole lifecycle from `order-id` (+ optional `prefix`).
 * - **deferred** (a snapshot with no payer bolt11 — amount locked, method grid
 *   showing): the same set, because the element still has a Lightning mint ahead of
 *   it, plus the locked amount.
 * - **snapshot** (a snapshot carrying a bolt11): the full invoice display set. The
 *   attempt already exists, so create-time options no longer apply.
 */
export function createCheckoutElementAttributes(
  snapshot: CheckoutSnapshot | null,
  options: CheckoutElementAttributeOptions = {},
): CheckoutElementAttributes {
  // `orderId` is required in create mode because there is no snapshot to read it from.
  if (snapshot === null) {
    if (options.orderId === undefined || options.orderId.length === 0) {
      throw new TypeError(
        "OpenReceive checkout element create mode requires an orderId when no snapshot is given.",
      );
    }
    return {
      [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: options.orderId,
      ...sharedElementAttributes(options),
      ...createModeAttributes(options),
    };
  }

  const displayInvoice = selectCheckoutDisplayInvoice(snapshot);
  const bolt11 = displayInvoice?.invoice;
  if (displayInvoice === undefined || typeof bolt11 !== "string") {
    const deferred: CheckoutElementAttributes = {
      [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: snapshot.order_id,
      ...sharedElementAttributes(options),
      ...createModeAttributes(options),
    };
    if (snapshot.amount_msats !== undefined) {
      deferred[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats] = String(snapshot.amount_msats);
    }
    return deferred;
  }
  const invoice = displayInvoice;
  assertOpenReceiveDisplayInvoice(bolt11);
  const attributes: CheckoutElementAttributes = {
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: snapshot.order_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId]: invoice.invoice_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice]: bolt11,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.rail]: invoice.rail,
  };

  if (invoice.payment_hash !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentHash] = invoice.payment_hash;
  }
  const amountMsats = invoice.amount_msats ?? snapshot.amount_msats;
  if (amountMsats !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.amountMsats] = String(amountMsats);
  }
  const fiat = invoice.fiat_quote?.fiat ?? snapshot.fiat;
  if (fiat?.currency !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatCurrency] = fiat.currency;
  }
  if (fiat?.value !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.fiatValue] = fiat.value;
  }
  attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.status] = isPaidCheckoutSnapshot(snapshot)
    ? "settled"
    : snapshot.status === "expired"
      ? "expired"
      : deriveStatus(invoice);
  if (invoice.expires_at !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.expiresAt] = String(invoice.expires_at);
  }

  return { ...attributes, ...sharedElementAttributes(options) };
}

export function createOpenReceiveThemeToggleElementAttributes(
  options: OpenReceiveThemeToggleElementAttributeOptions = {},
): OpenReceiveThemeToggleElementAttributes {
  return {
    ...(options.rootSelector === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.rootSelector]: options.rootSelector }),
    ...(options.checkoutSelector === undefined
      ? {}
      : {
          [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.checkoutSelector]: options.checkoutSelector,
        }),
    ...(options.defaultTheme === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.defaultTheme]: options.defaultTheme }),
    ...(options.storageKey === undefined
      ? {}
      : { [OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES.storageKey]: options.storageKey }),
  };
}

export function createCheckoutElementListeners(
  handlers: CheckoutElementEventHandlers = {},
): CheckoutElementListeners {
  return {
    ...(handlers.onCopy === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy]: handlers.onCopy }),
    ...(handlers.onOpenWallet === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet]: handlers.onOpenWallet }),
    ...(handlers.onState === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state]: handlers.onState }),
    ...(handlers.onSettled === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled]: handlers.onSettled }),
    ...(handlers.onProviderCopy === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy]: handlers.onProviderCopy }),
    ...(handlers.onStartOver === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver]: handlers.onStartOver }),
    ...(handlers.onError === undefined
      ? {}
      : { [OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error]: handlers.onError }),
  };
}

export function createCheckoutShellModel(
  snapshot: CheckoutSnapshot | null,
  options: CheckoutShellOptions = {},
): CheckoutShellModel {
  const theme = createOpenReceiveStoredThemeModel(options);
  // themeToggle: false → host (e.g. ThemeScope) owns theming; don't stamp a conflicting theme.
  const ownTheme = options.themeToggle !== false;
  return {
    theme,
    rootAttributes: ownTheme ? theme.attributes : {},
    checkout: {
      tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
      attributes: createCheckoutElementAttributes(snapshot, {
        ...options,
        ...(ownTheme ? { theme: theme.resolvedTheme } : {}),
      }),
      listeners: createCheckoutElementListeners(options),
    },
    themeToggle: ownTheme
      ? {
          tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
          attributes: createOpenReceiveThemeToggleElementAttributes({
            rootSelector: options.rootSelector,
            checkoutSelector: options.checkoutSelector ?? OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
            defaultTheme: options.defaultTheme,
            storageKey: options.storageKey,
          }),
        }
      : null,
  };
}

export function applyCheckoutElementAttributes(
  target: OpenReceiveThemeAttributeTarget,
  attributes: CheckoutElementAttributes,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    // `null` is skipped as well as `undefined`, and that is not belt-and-braces.
    // Vue, Svelte and Angular all surface an unbound prop as `null`, not
    // `undefined`, so a wrapper passing an unset `prefix` or `theme` straight
    // through would otherwise reach `setAttribute`, which stringifies it — and
    // the element would derive every route from a mount path of "null".
    if (value !== undefined && value !== null) target.setAttribute(name, value);
  }
}

export function applyCheckoutElementListeners(
  target: Pick<CheckoutElementTarget, "addEventListener">,
  listeners: CheckoutElementListeners,
): void {
  for (const [name, listener] of Object.entries(listeners)) {
    if (listener !== undefined) target.addEventListener(name, listener);
  }
}

export function applyOpenReceiveThemeToggleElementAttributes(
  target: OpenReceiveThemeAttributeTarget,
  attributes: OpenReceiveThemeToggleElementAttributes,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) target.setAttribute(name, value);
  }
}

export function createOpenReceiveThemeToggleElement(
  options: CreateOpenReceiveThemeToggleElementOptions = {},
): HTMLElement {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive theme toggle element creation requires document.");
  }

  const element = ownerDocument.createElement(OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME);
  applyOpenReceiveThemeToggleElementAttributes(
    element,
    createOpenReceiveThemeToggleElementAttributes(options),
  );
  return element;
}

export function createCheckoutShell(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutShellOptions = {},
): CheckoutShellElements {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive checkout shell creation requires document.");
  }

  const shell = createCheckoutShellModel(snapshot, options);
  if (shell.themeToggle !== null) {
    applyOpenReceiveThemeAttributes(options.root, shell.theme);
  }

  const checkout = ownerDocument.createElement(shell.checkout.tagName);
  applyCheckoutElementAttributes(checkout, shell.checkout.attributes);
  applyCheckoutElementListeners(checkout, shell.checkout.listeners);

  let themeToggle: HTMLElement | null = null;
  if (shell.themeToggle !== null) {
    themeToggle = ownerDocument.createElement(shell.themeToggle.tagName);
    applyOpenReceiveThemeToggleElementAttributes(themeToggle, shell.themeToggle.attributes);
  }

  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout,
    themeToggle,
  };
}
