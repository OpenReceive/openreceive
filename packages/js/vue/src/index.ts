// @openreceive/vue — thin wrapper over the OpenReceive checkout custom
// element. All binding logic lives in @openreceive/elements/wrapper-shared
// (shared with the other element wrappers); this file only aliases the shared
// factories under the framework-prefixed names. The binding contract is
// canonical across frameworks: { tagName, attributes, listeners }.
export * from "@openreceive/elements/wrapper-shared";
export {
  createOpenReceiveWrapperCheckoutBinding as createOpenReceiveVueCheckoutBinding,
  createOpenReceiveWrapperThemeBinding as createOpenReceiveVueThemeBinding,
  createOpenReceiveWrapperStoredThemeBinding as createOpenReceiveVueStoredThemeBinding,
  createOpenReceiveWrapperThemeToggleBinding as createOpenReceiveVueThemeToggleBinding,
  createOpenReceiveWrapperCheckoutShellBinding as createOpenReceiveVueCheckoutShellBinding,
  createOpenReceiveWrapperCheckoutController as createOpenReceiveVueCheckoutController,
  createOpenReceiveWrapperCheckoutShell as createOpenReceiveVueCheckoutShell,
} from "@openreceive/elements/wrapper-shared";
export type {
  OpenReceiveWrapperCheckoutBindingOptions as OpenReceiveVueCheckoutBindingOptions,
  OpenReceiveWrapperCheckoutBinding as OpenReceiveVueCheckoutBinding,
  OpenReceiveWrapperThemeToggleBinding as OpenReceiveVueThemeToggleBinding,
  OpenReceiveWrapperCheckoutShellBinding as OpenReceiveVueCheckoutShellBinding,
  OpenReceiveWrapperCheckoutComponentProps as OpenReceiveVueCheckoutComponentProps,
  OpenReceiveWrapperCheckoutEventHandlers as OpenReceiveVueCheckoutEventHandlers,
  OpenReceiveWrapperCheckoutShellOptions as OpenReceiveVueCheckoutShellOptions,
} from "@openreceive/elements/wrapper-shared";
