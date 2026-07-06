import { status as deriveStatus } from "../status.ts";
import { applyOpenReceiveThemeAttributes, createOpenReceiveStoredThemeModel } from "./theme.ts";
import { assertOpenReceiveDisplayInvoice } from "./checkout.ts";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type CheckoutElementAttributeOptions,
  type CheckoutElementAttributes,
  type CheckoutElementEventHandlers,
  type CheckoutElementListeners,
  type CheckoutElementTarget,
  type CheckoutInvoiceSnapshot,
  type CheckoutShellElements,
  type CheckoutShellModel,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type CreateCheckoutElementOptions,
  type CreateCheckoutShellOptions,
  type CreateOpenReceiveThemeToggleElementOptions,
  type OpenReceiveCheckoutShellProps,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes,
} from "./ui.ts";

export function createCheckoutElementAttributes(
  snapshot: CheckoutSnapshot,
  options: CheckoutElementAttributeOptions = {},
): CheckoutElementAttributes {
  const invoice = checkoutInvoiceFromOrderSnapshot(snapshot);
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
  if (options.statusUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.statusUrl] = options.statusUrl;
  }
  if (options.swapOptionsUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.swapOptionsUrl] = options.swapOptionsUrl;
  }
  if (options.swapStartUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.swapStartUrl] = options.swapStartUrl;
  }
  if (options.swapRefundUrl !== undefined) {
    attributes[OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.swapRefundUrl] = options.swapRefundUrl;
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
  snapshot: CheckoutSnapshot,
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

export function createCheckoutShellFromProps(
  props: OpenReceiveCheckoutShellProps & Omit<CreateCheckoutShellOptions, "root">,
): CheckoutShellElements {
  return createCheckoutShell(props.checkout, {
    ...props,
    defaultTheme: props.defaultTheme ?? props.theme,
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

function checkoutInvoiceFromOrderSnapshot(snapshot: CheckoutSnapshot): CheckoutInvoiceSnapshot {
  const invoice = snapshot.active ?? snapshot.invoices[0];
  if (invoice === undefined) {
    throw new TypeError("OpenReceive order snapshot requires active or invoices[0].");
  }
  return invoice;
}

function isPaidCheckoutSnapshot(snapshot: CheckoutSnapshot): boolean {
  return snapshot.status === "paid";
}
