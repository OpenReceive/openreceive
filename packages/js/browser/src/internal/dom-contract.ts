// The browser's DOM contract: the constants, data attributes, element parts,
// and custom events the checkout markup is built from and that the element,
// wizard, and wrapper packages query against. Attribute maps are the single
// source of truth; the matching selector maps are derived from them.
import type {
  CheckoutState,
  ResolvedTheme,
  ThemeModel,
  ThemePreference,
} from "./checkout-types.ts";

export const OPENRECEIVE_QR_QUIET_ZONE_MODULES = 4 as const;
export const OPENRECEIVE_QR_DARK_COLOR = "#000000" as const;
export const OPENRECEIVE_QR_LIGHT_COLOR = "#FFFFFFFF" as const;
export const OPENRECEIVE_QR_ERROR_CORRECTION = "M" as const;
export const OPENRECEIVE_THEME_STORAGE_KEY = "openreceive.theme" as const;
export const OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS = 3000 as const;
/**
 * Minimum remaining seconds a Lightning invoice must have before it is considered
 * reusable by the browser before asking the mounted create route for a stored
 * or new attempt.
 */
export const OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS = 60 as const;
/**
 * Default base path the shipped OpenReceive router is mounted at. When a developer passes
 * only an order id (React `<Checkout orderId>` / `<openreceive-checkout order-id>`), this is
 * the prefix every route is derived from — see `checkoutRoutes` in ./routes.ts. It is
 * the only URL input the checkout components accept.
 */
export const OPENRECEIVE_DEFAULT_PREFIX = "/openreceive" as const;
/**
 * Browser-only token for the refund-address review step. Host authorization and
 * the provider refund call happen only after the payer confirms.
 */
export const OPENRECEIVE_REFUND_REVIEW_NONCE = "confirm" as const;
export const OPENRECEIVE_COPY_FEEDBACK_MS = 1800 as const;
export const OPENRECEIVE_PROVIDER_PREVIEW_LIMIT = 4 as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME = "openreceive-checkout" as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME = "openreceive-theme-toggle" as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS = {
  copy: "openreceive-copy",
  openWallet: "openreceive-open-wallet",
  state: "openreceive-state",
  settled: "openreceive-settled",
  providerCopy: "openreceive-provider-copy",
  startOver: "openreceive-start-over",
  error: "openreceive-error",
} as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS = {
  change: "openreceive-theme-change",
} as const;
// The mapped return types are template-literal, not `string`, so a derived
// selector keeps the exact literal type its hand-written predecessor had —
// `OPENRECEIVE_CHECKOUT_DATA_SELECTORS.root` is still
// `"[data-openreceive-checkout]"` and not merely `string`. These maps are
// published, so widening them would silently loosen every consumer.
const attributeSelectors = <T extends Record<string, string>>(
  attributes: T,
): { readonly [K in keyof T]: `[${T[K]}]` } =>
  Object.fromEntries(
    Object.entries(attributes).map(([key, attribute]) => [key, `[${attribute}]`]),
  ) as { readonly [K in keyof T]: `[${T[K]}]` };
const partSelectors = <T extends Record<string, string>>(
  parts: T,
): { readonly [K in keyof T]: `[part="${T[K]}"]` } =>
  Object.fromEntries(Object.entries(parts).map(([key, part]) => [key, `[part="${part}"]`])) as {
    readonly [K in keyof T]: `[part="${T[K]}"]`;
  };
export const OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES = {
  root: "data-openreceive-wizard",
  breadcrumb: "data-or-breadcrumb",
  method: "data-or-method",
  route: "data-or-route",
  swapStart: "data-or-swap-start",
  swapBack: "data-or-swap-back",
  swapQr: "data-or-swap-qr",
  swapCopy: "data-or-swap-copy",
  swapCopyLabel: "data-or-swap-copy-label",
  swapSelectAll: "data-or-swap-select-all",
  swapNetwork: "data-or-swap-network",
  swapNetworkValue: "data-or-swap-network-value",
  pickerSelect: "data-or-picker-select",
  pickerContinue: "data-or-picker-continue",
  swapRefundForm: "data-or-swap-refund-form",
  swapRefundAddress: "data-or-swap-refund-address",
  swapRefundNonce: "data-or-swap-refund-nonce",
  swapRefundConfirm: "data-or-swap-refund-confirm",
  swapRefundPayInAsset: "data-or-swap-refund-pay-in-asset",
  swapRefundNetworkLabel: "data-or-swap-refund-network-label",
  swapRefundError: "data-or-swap-refund-error",
  providerCopy: "data-or-provider-copy",
  providerTutorial: "data-or-provider-tutorial",
  providerTutorialIndex: "data-or-provider-tutorial-index",
} as const;
export const OPENRECEIVE_PAYMENT_WIZARD_SELECTORS = attributeSelectors(
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
);
export const OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES = {
  root: "data-openreceive-checkout",
  qr: "data-openreceive-qr",
  meta: "data-openreceive-meta",
  state: "data-openreceive-state",
  actions: "data-openreceive-actions",
  theme: "data-openreceive-theme",
  themeToggle: "data-openreceive-theme-toggle",
} as const;
export const OPENRECEIVE_CHECKOUT_DATA_SELECTORS = attributeSelectors(
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
);
export const OPENRECEIVE_CHECKOUT_ELEMENT_PARTS = {
  copy: "copy",
  open: "open",
  startOver: "start-over",
} as const;
export const OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS = partSelectors(
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
);
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS = {
  button: "button",
} as const;
export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS = partSelectors(
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
);
export type CheckoutElementEventName =
  (typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS)[keyof typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS];
export interface CheckoutProviderCopyEventDetail {
  readonly providerId: string;
}
export interface CheckoutStateEventDetail {
  readonly state: CheckoutState;
}
export interface CheckoutErrorEventDetail {
  readonly error: unknown;
}
export interface ThemeChangeEventDetail {
  readonly theme: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
}

export function createCheckoutProviderCopyEvent(
  providerId: string,
): CustomEvent<CheckoutProviderCopyEventDetail> {
  return new CustomEvent<CheckoutProviderCopyEventDetail>(
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy,
    {
      detail: {
        providerId,
      },
    },
  );
}

export function createCheckoutActionEvent(
  eventName:
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.openWallet
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver,
): CustomEvent {
  return new CustomEvent(eventName);
}

export function createCheckoutStateEvent(
  eventName:
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state
    | typeof OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled,
  state: CheckoutState,
): CustomEvent<CheckoutStateEventDetail> {
  return new CustomEvent<CheckoutStateEventDetail>(eventName, {
    detail: {
      state,
    },
  });
}

export function createCheckoutErrorEvent(error: unknown): CustomEvent<CheckoutErrorEventDetail> {
  return new CustomEvent<CheckoutErrorEventDetail>(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error, {
    detail: {
      error,
    },
  });
}

export function createThemeChangeEvent(theme: ThemeModel): CustomEvent<ThemeChangeEventDetail> {
  return new CustomEvent<ThemeChangeEventDetail>(OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS.change, {
    detail: {
      theme: theme.theme,
      resolvedTheme: theme.resolvedTheme,
    },
  });
}

export const OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES = {
  orderId: "order-id",
  /**
   * Base path the shipped router is mounted at (default `/openreceive`). The
   * element's ONLY URL input: create, prepare, payment-check and the four swap
   * routes are all derived from it. There is deliberately no per-route
   * attribute — see `checkoutRoutes` in ../internal/routes.ts.
   */
  prefix: "prefix",
  /** JSON-encoded create-time metadata forwarded to the create request. */
  metadata: "metadata",
  invoiceId: "invoice-id",
  invoice: "invoice",
  rail: "rail",
  paymentHash: "payment-hash",
  amountMsats: "amount-msats",
  fiatCurrency: "fiat-currency",
  fiatValue: "fiat-value",
  status: "status",
  expiresAt: "expires-at",
  theme: "theme",
  paymentWizard: "payment-wizard",
  /**
   * Opt into History API URL sync to `{resume-path-prefix}/{order-id}`.
   * Summary fetch always runs in create mode; this only controls URL mutation.
   */
  syncUrl: "sync-url",
  /** History API path prefix when `sync-url` is set. Default `/checkout`. */
  resumePathPrefix: "resume-path-prefix",
  /**
   * Order id owned by the app router (e.g. Next.js). When set, the element does not
   * push/replace the URL via the History API.
   */
  routeOrderId: "route-order-id",
  /**
   * Base URL of an external bolt11 decoder. When set, the checkout shows a
   * "Decode" link to `{decode-link-url}?invoice={bolt11}`. Omitted (the
   * default), no decode link is rendered and the invoice never leaves the page.
   */
  decodeLinkUrl: "decode-link-url",
  /** `polling="false"` renders the snapshot without status polling (no POST /payments/check). */
  polling: "polling",
  /** Status poll cadence in milliseconds; defaults to OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS. */
  pollIntervalMs: "poll-interval-ms",
} as const;

export const OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES = {
  rootSelector: "root-selector",
  checkoutSelector: "checkout-selector",
  defaultTheme: "default-theme",
  storageKey: "storage-key",
} as const;
