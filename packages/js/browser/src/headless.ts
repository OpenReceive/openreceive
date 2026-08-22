// @openreceive/browser/headless — the supported surface for integrations that
// bring their own UI (own components, own stores, this engine underneath).
// Curated symbol-by-symbol: a symbol is promoted here iff a real headless
// integration needs it (seed: the hello-fruit rails example + shared demo
// helpers). Never `export *` — everything not listed stays private wrapper
// plumbing. The drop-in surfaces (@openreceive/browser main entry,
// @openreceive/react, @openreceive/elements) are unaffected.

// Checkout lifecycle: prepare/create calls, state snapshots, status polling.
export {
  createCheckoutState,
  createCheckoutStatusModel,
  createOpenReceiveStatusFetcher,
  isReusableLightningInvoice,
  OpenReceiveBrowserRequestError,
  prepareCheckout,
  requestCheckout,
  selectCheckoutDisplayInvoice,
} from "./internal/checkout.ts";
export type {
  CheckoutInvoiceSnapshot,
  CheckoutSnapshot,
  CheckoutState,
  CheckoutStatusModel,
} from "./internal/ui.ts";
export { OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS } from "./internal/ui.ts";
export { postOpenReceiveJson } from "./internal/swap-http.ts";
export { status, type Status } from "./status.ts";

// Payment methods + wizard model.
export {
  buildOpenReceiveMethodGridEntries,
  createOpenReceivePaymentWizardModel,
  createOpenReceivePaymentWizardSelection,
  createOpenReceiveWizardRouteDisplays,
  getOpenReceiveRouteNetworkLabel,
  openReceivePaymentAccentId,
  resolveOpenReceivePreservedNetworkSelection,
  updateOpenReceivePaymentWizardSelection,
} from "./internal/wizard.ts";
export { openReceivePaymentMethods } from "./internal/ui.ts";
export type {
  OpenReceiveCheckoutPaymentMethod,
  OpenReceivePaymentMethod,
  OpenReceivePaymentWizardModel,
  OpenReceivePaymentWizardSelection,
  OpenReceiveWizardProviderDisplay,
} from "./internal/ui.ts";
export type {
  OpenReceiveMethodGridEntry,
  OpenReceiveSwapMethodGroup,
} from "./internal/wizard.ts";

// Swap flows.
export {
  createOpenReceiveSwapDisplayModel,
  formatOpenReceiveSwapLimit,
  openReceiveSwapAssetMatchesRoute,
} from "./internal/checkout.ts";
export {
  normalizeSwapStartInvoice,
  startOpenReceiveSwapRequest,
} from "./internal/swap-http.ts";
export { openReceiveSwapPickerKey } from "./internal/wizard.ts";
export type { OpenReceiveSwapDisplayModel } from "./internal/ui.ts";

// Formatting + labels.
//
// THE RULE, stated where a headless integration meets it: FORMATTERS THROW,
// DISPLAY BOUNDARIES BLANK. `formatOpenReceiveMsats` throws a RangeError on an
// amount that is not a non-negative safe integer, because wire construction and
// amount validation share it and a bad amount there is a bug that must surface.
// `optionalMsatsLabel` / `optionalUnixTimeLabel` are the same rules with
// `undefined` in place of the throw.
//
// REACH FOR THE BOUNDARY WHEN THE VALUE CAME FROM A SERVER — a swap limit, an
// order total, a `paid_at` — and keep printing the raw value beside the blanked
// label. A field a server should never have sent must cost one label or one
// row, never the screen. Reach for the formatter only when you are building or
// validating a value you own, and a throw is the answer you want.
//
// They were package-private until now, which left a demo holding a bare msats
// number no safe option on this surface. That is the shape of bug this pair
// exists to prevent, so both ship here, next to the formatter.
export {
  createOpenReceiveLightningInvoiceDecodeUrl,
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
  formatOpenReceiveFiatAmount,
  formatOpenReceiveMsats,
  optionalMsatsLabel,
  optionalUnixTimeLabel,
} from "./internal/checkout.ts";
export {
  formatOpenReceiveChooseNetworkHeading,
  formatOpenReceiveNetworkSummary,
} from "./internal/wizard.ts";
export { openReceiveCheckoutLabels } from "./internal/ui.ts";
export type {
  OpenReceiveTransactionDetailRow,
  OpenReceiveTransactionDetailsInput,
} from "./internal/ui.ts";

// Styling tokens: the contract with the shipped stylesheet — an interface by
// nature, so custom UIs can reuse the same class names and data attributes.
export { orClasses } from "./ui-classes.ts";
export {
  openReceiveAssetButtonClasses,
  openReceiveNetworkButtonClasses,
  openReceiveNetworkCheckClasses,
  openReceiveNetworkMobileRevealClasses,
  openReceiveNetworkSummaryIconClasses,
} from "./internal/wizard.ts";
export {
  createCheckoutProviderCopyEvent,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
} from "./internal/ui.ts";
