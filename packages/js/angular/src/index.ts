// @openreceive/angular — thin wrapper over the OpenReceive checkout custom
// element. All binding logic lives in @openreceive/elements/wrapper-shared
// (shared with the other element wrappers); this file only aliases the shared
// factories under the framework-prefixed names. The binding contract is
// canonical across frameworks: { tagName, attributes, listeners }.
export * from "@openreceive/elements/wrapper-shared";
export {
  createOpenReceiveWrapperCheckoutBinding as createOpenReceiveAngularCheckoutBinding,
  createOpenReceiveWrapperThemeBinding as createOpenReceiveAngularThemeBinding,
  createOpenReceiveWrapperStoredThemeBinding as createOpenReceiveAngularStoredThemeBinding,
  createOpenReceiveWrapperThemeToggleBinding as createOpenReceiveAngularThemeToggleBinding,
  createOpenReceiveWrapperCheckoutShellBinding as createOpenReceiveAngularCheckoutShellBinding,
  createOpenReceiveWrapperCheckoutController as createOpenReceiveAngularCheckoutController,
  createOpenReceiveWrapperCheckoutShell as createOpenReceiveAngularCheckoutShell,
} from "@openreceive/elements/wrapper-shared";
export type {
  OpenReceiveWrapperCheckoutBindingOptions as OpenReceiveAngularCheckoutBindingOptions,
  OpenReceiveWrapperCheckoutBinding as OpenReceiveAngularCheckoutBinding,
  OpenReceiveWrapperThemeToggleBinding as OpenReceiveAngularThemeToggleBinding,
  OpenReceiveWrapperCheckoutShellBinding as OpenReceiveAngularCheckoutShellBinding,
  OpenReceiveWrapperCheckoutComponentProps as OpenReceiveAngularCheckoutComponentProps,
  OpenReceiveWrapperCheckoutEventHandlers as OpenReceiveAngularCheckoutEventHandlers,
  OpenReceiveWrapperCheckoutShellOptions as OpenReceiveAngularCheckoutShellOptions,
} from "@openreceive/elements/wrapper-shared";
