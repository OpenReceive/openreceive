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

export interface OpenReceiveAngularCheckoutBindingOptions
  extends OpenReceiveCheckoutElementAttributeOptions,
    OpenReceiveCheckoutElementEventHandlers {}

export interface OpenReceiveAngularCheckoutBinding {
  readonly selector: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attributes: OpenReceiveCheckoutElementAttributes;
  readonly events: OpenReceiveCheckoutElementListeners;
}

export interface OpenReceiveAngularThemeToggleBinding {
  readonly selector: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly attributes: OpenReceiveThemeToggleElementAttributes;
}

export interface OpenReceiveAngularCheckoutShellBinding {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttributes: OpenReceiveThemeModel["attributes"];
  readonly checkout: OpenReceiveAngularCheckoutBinding;
  readonly themeToggle: OpenReceiveAngularThemeToggleBinding;
}

export interface OpenReceiveAngularCheckoutComponentOptions
  extends OpenReceiveCheckoutShellOptions {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveAngularCheckoutComponentModel
  extends OpenReceiveAngularCheckoutShellBinding {
  readonly componentName: "OpenReceiveCheckout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveAngularCheckoutBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveAngularCheckoutBindingOptions = {}
): OpenReceiveAngularCheckoutBinding {
  return {
    selector: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    attributes: createOpenReceiveCheckoutElementAttributes(snapshot, options),
    events: createOpenReceiveCheckoutElementListeners(options)
  };
}

export function createOpenReceiveAngularThemeBinding(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveThemeModel(theme, options);
}

export function createOpenReceiveAngularStoredThemeBinding(
  options: OpenReceiveStoredThemeModelOptions = {}
): OpenReceiveThemeModel {
  return createOpenReceiveStoredThemeModel(options);
}

export function createOpenReceiveAngularThemeToggleBinding(
  options: OpenReceiveThemeToggleElementAttributeOptions = {}
): OpenReceiveAngularThemeToggleBinding {
  return {
    selector: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    attributes: createOpenReceiveThemeToggleElementAttributes(options)
  };
}

export function createOpenReceiveAngularCheckoutShellBinding(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveCheckoutShellOptions = {}
): OpenReceiveAngularCheckoutShellBinding {
  const shell = createOpenReceiveCheckoutShellModel(snapshot, options);
  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout: {
      selector: shell.checkout.tagName,
      attributes: shell.checkout.attributes,
      events: shell.checkout.listeners
    },
    themeToggle: {
      selector: shell.themeToggle.tagName,
      attributes: shell.themeToggle.attributes
    }
  };
}

export function createOpenReceiveAngularCheckoutComponentModel(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: OpenReceiveAngularCheckoutComponentOptions = {}
): OpenReceiveAngularCheckoutComponentModel {
  const { defineElementsOptions, ...shellOptions } = options;
  const shell = createOpenReceiveAngularCheckoutShellBinding(snapshot, shellOptions);
  return {
    componentName: "OpenReceiveCheckout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveAngularCheckoutController(
  options: OpenReceiveCheckoutControllerOptions
): OpenReceiveCheckoutController {
  return createOpenReceiveCheckoutController(options);
}

export function createOpenReceiveAngularCheckoutShell(
  snapshot: OpenReceiveCheckoutSnapshot,
  options: CreateOpenReceiveCheckoutShellOptions = {}
): OpenReceiveCheckoutShellElements {
  return createOpenReceiveCheckoutShell(snapshot, options);
}
