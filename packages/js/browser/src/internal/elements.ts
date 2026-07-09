import { status as deriveStatus } from "../status.ts";
import {
  assertOpenReceiveDisplayInvoice,
  checkoutInvoiceFromOrderSnapshot,
  isPaidCheckoutSnapshot,
} from "./checkout.ts";
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
  type CreateCheckoutElementOptions,
  type CreateCheckoutShellOptions,
  type CreateOpenReceiveThemeToggleElementOptions,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type OpenReceiveCheckoutShellProps,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes,
} from "./ui.ts";

export function createCheckoutElementAttributes(
  snapshot: CheckoutSnapshot | null,
  options: CheckoutElementAttributeOptions = {},
): CheckoutElementAttributes {
  // Create mode: no snapshot yet. The element owns the whole lifecycle from `order-id` (+
  // optional `prefix`) — it creates the checkout, then renders and polls — so we emit just
  // those routing attributes plus theme/order-url/wizard and let the element do the rest.
  // `orderId` is required here because there is no snapshot to read the order id from.
  if (snapshot === null) {
    if (options.orderId === undefined || options.orderId.length === 0) {
      throw new TypeError(
        "OpenReceive checkout element create mode requires an orderId when no snapshot is given.",
      );
    }
    const createAttributes: CheckoutElementAttributes = {
      [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: options.orderId,
    };
    if (options.prefix !== undefined) {
      createAttributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix] = options.prefix;
    }
    if (options.orderUrl !== undefined) {
      createAttributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl] = options.orderUrl;
    }
    if (options.theme !== undefined) {
      createAttributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme] = options.theme;
    }
    if (options.paymentWizard !== undefined) {
      createAttributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard] = String(
        options.paymentWizard,
      );
    }
    return createAttributes;
  }

  const invoice = checkoutInvoiceFromOrderSnapshot(snapshot);
  if (typeof invoice.invoice !== "string") {
    throw new TypeError("OpenReceive checkout element requires a display Lightning invoice.");
  }
  assertOpenReceiveDisplayInvoice(invoice.invoice);
  const attributes: CheckoutElementAttributes = {
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId]: snapshot.order_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoiceId]: invoice.invoice_id,
    [OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.invoice]: invoice.invoice,
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
  if (options.orderUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderUrl] = options.orderUrl;
  }
  if (options.prefix !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.prefix] = options.prefix;
  }
  if (options.theme !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.theme] = options.theme;
  }
  if (options.paymentWizard !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.paymentWizard] = String(
      options.paymentWizard,
    );
  }

  return attributes;
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
  return {
    theme,
    rootAttributes: theme.attributes,
    checkout: {
      tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
      attributes: createCheckoutElementAttributes(snapshot, {
        ...options,
        theme: theme.resolvedTheme,
      }),
      listeners: createCheckoutElementListeners(options),
    },
    themeToggle: {
      tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
      attributes: createOpenReceiveThemeToggleElementAttributes({
        rootSelector: options.rootSelector,
        checkoutSelector: options.checkoutSelector ?? OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
        defaultTheme: options.defaultTheme,
        storageKey: options.storageKey,
      }),
    },
  };
}

export function createCheckoutShellModelFromProps(
  props: OpenReceiveCheckoutShellProps,
): CheckoutShellModel {
  const {
    checkout,
    status: _status,
    providers: _providers,
    theme,
    defaultTheme,
    ...options
  } = props;
  return createCheckoutShellModel(checkout, {
    ...options,
    defaultTheme: defaultTheme ?? theme,
  });
}

export function applyCheckoutElementAttributes(
  target: OpenReceiveThemeAttributeTarget,
  attributes: CheckoutElementAttributes,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) target.setAttribute(name, value);
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

export function createCheckoutElement(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutElementOptions = {},
): HTMLElement {
  const ownerDocument = options.document ?? globalThis.document;
  if (ownerDocument === undefined) {
    throw new Error("OpenReceive checkout element creation requires document.");
  }

  const element = ownerDocument.createElement(OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  applyCheckoutElementAttributes(element, createCheckoutElementAttributes(snapshot, options));
  applyCheckoutElementListeners(element, createCheckoutElementListeners(options));
  return element;
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
  applyOpenReceiveThemeAttributes(options.root, shell.theme);

  const checkout = ownerDocument.createElement(shell.checkout.tagName);
  applyCheckoutElementAttributes(checkout, shell.checkout.attributes);
  applyCheckoutElementListeners(checkout, shell.checkout.listeners);

  const themeToggle = ownerDocument.createElement(shell.themeToggle.tagName);
  applyOpenReceiveThemeToggleElementAttributes(themeToggle, shell.themeToggle.attributes);

  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout,
    themeToggle,
  };
}
