import {
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  createOpenReceiveCheckoutController,
  createOpenReceiveCheckoutShell,
  createOpenReceiveCheckoutShellModel,
  createOpenReceiveCheckoutElementAttributes,
  createOpenReceiveCheckoutElementListeners,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveThemeToggleElementAttributes,
  type CreateOpenReceiveCheckoutShellOptions,
  type OpenReceiveCheckoutElementAttributeOptions,
  type OpenReceiveCheckoutElementAttributes,
  type OpenReceiveCheckoutElementEventHandlers,
  type OpenReceiveCheckoutElementListeners,
  type OpenReceiveCheckoutController,
  type OpenReceiveCheckoutControllerOptions,
  type OpenReceiveCheckoutShellElements,
  type OpenReceiveCheckoutShellOptions,
  type OpenReceiveCheckoutSnapshot,
  type OpenReceiveReadThemePreferenceOptions,
  type OpenReceiveStoredThemeModelOptions,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeModel,
  type OpenReceiveThemeModelOptions,
  type OpenReceiveThemePreference,
  type OpenReceiveThemeStorageOptions,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes
} from "@openreceive/browser";
import {
  defineOpenReceiveElements,
  type DefineOpenReceiveElementsOptions
} from "@openreceive/elements";

export {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_STORAGE_KEY,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  applyOpenReceiveCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createOpenReceiveCheckoutController,
  createOpenReceiveCheckoutElement,
  createOpenReceiveCheckoutElementAttributes,
  createOpenReceiveCheckoutElementListeners,
  createOpenReceiveCheckoutShell,
  createOpenReceiveCheckoutShellModel,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveThemeToggleElement,
  createOpenReceiveThemeToggleElementAttributes,
  readOpenReceiveThemePreference,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  writeOpenReceiveThemePreference
} from "@openreceive/browser";
export type {
  CreateOpenReceiveCheckoutElementOptions,
  CreateOpenReceiveCheckoutShellOptions,
  CreateOpenReceiveThemeToggleElementOptions,
  OpenReceiveCheckoutElementAttributeOptions,
  OpenReceiveCheckoutElementAttributes,
  OpenReceiveCheckoutElementDocument,
  OpenReceiveCheckoutElementEventHandlers,
  OpenReceiveCheckoutElementListeners,
  OpenReceiveCheckoutController,
  OpenReceiveCheckoutControllerOptions,
  OpenReceiveCheckoutShellElements,
  OpenReceiveCheckoutShellCheckoutBinding,
  OpenReceiveCheckoutShellModel,
  OpenReceiveCheckoutShellOptions,
  OpenReceiveCheckoutShellThemeToggleBinding,
  OpenReceiveCheckoutElementTarget,
  OpenReceiveCheckoutSnapshot,
  OpenReceiveReadThemePreferenceOptions,
  OpenReceiveStoredThemeModelOptions,
  OpenReceiveThemeAttributeTarget,
  OpenReceiveThemeControlTargets,
  OpenReceiveThemeLabelTarget,
  OpenReceiveThemeModel,
  OpenReceiveThemeModelOptions,
  OpenReceiveThemePreference,
  OpenReceiveThemeStorageOptions,
  OpenReceiveThemeToggleElementAttributeOptions,
  OpenReceiveThemeToggleElementAttributes
} from "@openreceive/browser";
export { defineOpenReceiveElements } from "@openreceive/elements";
export type { DefineOpenReceiveElementsOptions } from "@openreceive/elements";

export interface OpenReceiveSvelteCheckoutPropsOptions
  extends OpenReceiveCheckoutElementAttributeOptions {}

export interface OpenReceiveSvelteCheckoutBindingOptions
  extends OpenReceiveSvelteCheckoutPropsOptions,
    OpenReceiveCheckoutElementEventHandlers {}

export interface OpenReceiveSvelteCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly props: OpenReceiveCheckoutElementAttributes;
  readonly events: OpenReceiveCheckoutElementListeners;
}

export interface OpenReceiveSvelteThemeToggleBinding {
  readonly tagName: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly props: OpenReceiveThemeToggleElementAttributes;
}

export interface OpenReceiveSvelteCheckoutShellBinding {
  readonly theme: OpenReceiveThemeModel;
  readonly rootProps: OpenReceiveThemeModel["attributes"];
  readonly checkout: OpenReceiveSvelteCheckoutBinding;
  readonly themeToggle: OpenReceiveSvelteThemeToggleBinding;
}

export interface OpenReceiveSvelteCheckoutComponentOptions
  extends OpenReceiveCheckoutShellOptions {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveSvelteCheckoutComponentModel
  extends OpenReceiveSvelteCheckoutShellBinding {
  readonly componentName: "OpenReceiveCheckout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveSvelteCheckoutProps(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveSvelteCheckoutPropsOptions = {}
): OpenReceiveCheckoutElementAttributes {
  return createOpenReceiveCheckoutElementAttributes(snapshot, options);
}

export function createOpenReceiveSvelteCheckoutBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveSvelteCheckoutBindingOptions = {}
): OpenReceiveSvelteCheckoutBinding {
  return {
    tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    props: createOpenReceiveSvelteCheckoutProps(snapshot, options),
    events: createOpenReceiveCheckoutElementListeners(options)
  };
}

export function createOpenReceiveSvelteThemeBinding(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveThemeModel(theme, options);
}

export function createOpenReceiveSvelteStoredThemeBinding(
  options: OpenReceiveStoredThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveStoredThemeModel(options);
}

export function createOpenReceiveSvelteThemeToggleBinding(
  options: OpenReceiveThemeToggleElementAttributeOptions = {}
): OpenReceiveSvelteThemeToggleBinding {
  return {
    tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    props: createOpenReceiveThemeToggleElementAttributes(options)
  };
}

export function createOpenReceiveSvelteCheckoutShellBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveCheckoutShellOptions = {}
): OpenReceiveSvelteCheckoutShellBinding {
  const shell = createOpenReceiveCheckoutShellModel(snapshot, options);
  return {
    theme: shell.theme,
    rootProps: shell.rootAttributes,
    checkout: {
      tagName: shell.checkout.tagName,
      props: shell.checkout.attributes,
      events: shell.checkout.listeners
    },
    themeToggle: {
      tagName: shell.themeToggle.tagName,
      props: shell.themeToggle.attributes
    }
  };
}

export function createOpenReceiveSvelteCheckoutComponentModel(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveSvelteCheckoutComponentOptions = {}
): OpenReceiveSvelteCheckoutComponentModel {
  const { defineElementsOptions, ...shellOptions } = options;
  const shell = createOpenReceiveSvelteCheckoutShellBinding(snapshot, shellOptions);
  return {
    componentName: "OpenReceiveCheckout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveSvelteCheckoutController(
  options: OpenReceiveCheckoutControllerOptions
): OpenReceiveCheckoutController {
  return createOpenReceiveCheckoutController(options);
}

export function createOpenReceiveSvelteCheckoutShell(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: CreateOpenReceiveCheckoutShellOptions = {}
): OpenReceiveCheckoutShellElements {
  return createOpenReceiveCheckoutShell(snapshot, options);
}
