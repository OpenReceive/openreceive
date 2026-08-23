// Public surface of @openreceive/elements. Implementation lives in the sibling
// modules; this file only re-exports (M41: the former single-file implementation
// is split by concern).

// Element plumbing (tag names, attribute/event constants, element factories)
// is @openreceive/elements surface: these are contracts between independently
// loaded code, and this package is where custom elements live.
export type { OpenReceiveTransactionDetailsSource } from "@openreceive/browser/headless";
export {
  createOpenReceiveThemeToggleElement,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
} from "@openreceive/browser/headless";
export { defineOpenReceiveElements } from "./define-elements.ts";
export {
  renderCheckoutCreateErrorHtml,
  renderCheckoutCreatingHtml,
  renderCheckoutHtml,
  renderOpenReceiveThemeToggleHtml,
} from "./render-checkout.ts";
export { renderOpenReceivePaymentWizardHtml } from "./render-wizard.ts";
export {
  createTransactionDetailsElement,
  renderTransactionDetailsHtml,
  wireTransactionDetailsCopy,
} from "./transaction-details.ts";
export type {
  CheckoutView,
  DefineOpenReceiveElementsOptions,
  OpenReceiveElementsSwapOption,
  OpenReceiveElementsWizardView,
} from "./views.ts";
