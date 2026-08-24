// Public surface of @openreceive/elements. Implementation lives in the sibling
// modules; this file only re-exports (M41: the former single-file implementation
// is split by concern).

// Element plumbing (tag names, attribute/event constants, element factories)
// is @openreceive/elements surface: these are contracts between independently
// loaded code, and this package is where custom elements live.
export type { TransactionDetailsSource } from "@openreceive/browser/headless";
export {
  createThemeToggleElement,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
} from "@openreceive/browser/headless";
export { defineElements } from "./define-elements.ts";
export {
  renderCheckoutCreateErrorHtml,
  renderCheckoutHtml,
  renderThemeToggleHtml,
} from "./render-checkout.ts";
export {
  createTransactionDetailsElement,
  renderTransactionDetailsHtml,
} from "./transaction-details.ts";
export type {
  CheckoutView,
  DefineElementsOptions,
  ElementsWizardView,
} from "./views.ts";
