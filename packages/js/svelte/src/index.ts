// @openreceive/svelte — thin wrapper over the OpenReceive checkout custom
// element. All binding logic lives in @openreceive/elements/wrapper-shared
// (shared with the other element wrappers); this file only aliases the shared
// factories under the framework-prefixed names. The binding contract is
// canonical across frameworks: { tagName, attributes, listeners }.
export * from "@openreceive/elements/wrapper-shared";
export {
  createOpenReceiveWrapperCheckoutBinding as createOpenReceiveSvelteCheckoutBinding,
  createOpenReceiveWrapperThemeBinding as createOpenReceiveSvelteThemeBinding,
  createOpenReceiveWrapperStoredThemeBinding as createOpenReceiveSvelteStoredThemeBinding,
  createOpenReceiveWrapperThemeToggleBinding as createOpenReceiveSvelteThemeToggleBinding,
  createOpenReceiveWrapperCheckoutShellBinding as createOpenReceiveSvelteCheckoutShellBinding,
  createOpenReceiveWrapperCheckoutController as createOpenReceiveSvelteCheckoutController,
  createOpenReceiveWrapperCheckoutShell as createOpenReceiveSvelteCheckoutShell,
} from "@openreceive/elements/wrapper-shared";
export type {
  OpenReceiveWrapperCheckoutBindingOptions as OpenReceiveSvelteCheckoutBindingOptions,
  OpenReceiveWrapperCheckoutBinding as OpenReceiveSvelteCheckoutBinding,
  OpenReceiveWrapperThemeToggleBinding as OpenReceiveSvelteThemeToggleBinding,
  OpenReceiveWrapperCheckoutShellBinding as OpenReceiveSvelteCheckoutShellBinding,
  OpenReceiveWrapperCheckoutComponentProps as OpenReceiveSvelteCheckoutComponentProps,
  OpenReceiveWrapperCheckoutEventHandlers as OpenReceiveSvelteCheckoutEventHandlers,
  OpenReceiveWrapperCheckoutShellOptions as OpenReceiveSvelteCheckoutShellOptions,
} from "@openreceive/elements/wrapper-shared";
