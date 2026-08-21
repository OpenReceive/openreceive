// @openreceive/vue — thin wrapper over the OpenReceive checkout custom
// element. The component ships on the ./checkout.vue subpath; this entry carries
// the curated wrapper surface: the element registrar, the wrapper binding
// factories, and the props/binding types the component and README use (all
// implemented once in @openreceive/elements/wrapper-shared — the binding
// contract is canonical across frameworks: { tagName, attributes, listeners }).
// Lower-level element plumbing stays in @openreceive/elements and
// @openreceive/browser. tools/validate/check-public-api.mjs pins this surface.
export type {
  CheckoutController,
  CheckoutControllerOptions,
  CheckoutElementAttributeOptions,
  CheckoutElementAttributes,
  CheckoutElementEventHandlers,
  CheckoutElementListeners,
  CheckoutShellElements,
  CheckoutShellOptions,
  CheckoutSnapshot,
  CreateCheckoutShellOptions,
  DefineOpenReceiveElementsOptions,
  OpenReceiveStoredThemeModelOptions,
  OpenReceiveThemeModel,
  OpenReceiveThemeModelOptions,
  OpenReceiveThemePreference,
  OpenReceiveThemeToggleElementAttributeOptions,
  OpenReceiveThemeToggleElementAttributes,
  OpenReceiveWrapperCheckoutBinding,
  OpenReceiveWrapperCheckoutBindingOptions,
  OpenReceiveWrapperCheckoutComponentProps,
  OpenReceiveWrapperCheckoutEventHandlers,
  OpenReceiveWrapperCheckoutPropsValidation,
  OpenReceiveWrapperCheckoutShellBinding,
  OpenReceiveWrapperCheckoutShellOptions,
  OpenReceiveWrapperThemeToggleBinding,
} from "@openreceive/elements/wrapper-shared";
export {
  createOpenReceiveWrapperCheckoutBinding,
  createOpenReceiveWrapperCheckoutController,
  createOpenReceiveWrapperCheckoutShell,
  createOpenReceiveWrapperCheckoutShellBinding,
  createOpenReceiveWrapperStoredThemeBinding,
  createOpenReceiveWrapperThemeBinding,
  createOpenReceiveWrapperThemeToggleBinding,
  defineOpenReceiveElements,
  validateOpenReceiveWrapperCheckoutProps,
} from "@openreceive/elements/wrapper-shared";
