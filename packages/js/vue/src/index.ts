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

export interface OpenReceiveVueCheckoutBindingOptions
  extends OpenReceiveCheckoutElementAttributeOptions,
    OpenReceiveCheckoutElementEventHandlers {}

export interface OpenReceiveVueCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attrs: OpenReceiveCheckoutElementAttributes;
  readonly listeners: OpenReceiveCheckoutElementListeners;
}

export interface OpenReceiveVueThemeToggleBinding {
  readonly tagName: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly attrs: OpenReceiveThemeToggleElementAttributes;
}

export interface OpenReceiveVueCheckoutShellBinding {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttrs: OpenReceiveThemeModel["attributes"];
  readonly checkout: OpenReceiveVueCheckoutBinding;
  readonly themeToggle: OpenReceiveVueThemeToggleBinding;
}

export interface OpenReceiveVueCheckoutComponentOptions
  extends OpenReceiveCheckoutShellOptions {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveVueCheckoutComponentModel
  extends OpenReceiveVueCheckoutShellBinding {
  readonly componentName: "OpenReceiveCheckout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveVueCheckoutBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveVueCheckoutBindingOptions = {}
): OpenReceiveVueCheckoutBinding {
  return {
    tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    attrs: createOpenReceiveCheckoutElementAttributes(snapshot, options),
    listeners: createOpenReceiveCheckoutElementListeners(options)
  };
}

export function createOpenReceiveVueThemeBinding(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveThemeModel(theme, options);
}

export function createOpenReceiveVueStoredThemeBinding(
  options: OpenReceiveStoredThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveStoredThemeModel(options);
}

export function createOpenReceiveVueThemeToggleBinding(
  options: OpenReceiveThemeToggleElementAttributeOptions = {}
): OpenReceiveVueThemeToggleBinding {
  return {
    tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    attrs: createOpenReceiveThemeToggleElementAttributes(options)
  };
}

export function createOpenReceiveVueCheckoutShellBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveCheckoutShellOptions = {}
): OpenReceiveVueCheckoutShellBinding {
  const shell = createOpenReceiveCheckoutShellModel(snapshot, options);
  return {
    theme: shell.theme,
    rootAttrs: shell.rootAttributes,
    checkout: {
      tagName: shell.checkout.tagName,
      attrs: shell.checkout.attributes,
      listeners: shell.checkout.listeners
    },
    themeToggle: {
      tagName: shell.themeToggle.tagName,
      attrs: shell.themeToggle.attributes
    }
  };
}

export function createOpenReceiveVueCheckoutComponentModel(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveVueCheckoutComponentOptions = {}
): OpenReceiveVueCheckoutComponentModel {
  const { defineElementsOptions, ...shellOptions } = options;
  const shell = createOpenReceiveVueCheckoutShellBinding(snapshot, shellOptions);
  return {
    componentName: "OpenReceiveCheckout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveVueCheckoutController(
  options: OpenReceiveCheckoutControllerOptions
): OpenReceiveCheckoutController {
  return createOpenReceiveCheckoutController(options);
}

export function createOpenReceiveVueCheckoutShell(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: CreateOpenReceiveCheckoutShellOptions = {}
): OpenReceiveCheckoutShellElements {
  return createOpenReceiveCheckoutShell(snapshot, options);
}
