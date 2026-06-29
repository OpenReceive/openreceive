import {
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  createCheckoutController,
  createCheckoutShell,
  createCheckoutShellModel,
  createCheckoutShellModelFromProps,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveThemeToggleElementAttributes,
  type CreateCheckoutShellOptions,
  type CheckoutElementAttributeOptions,
  type CheckoutElementAttributes,
  type CheckoutElementEventHandlers,
  type CheckoutElementListeners,
  type CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutShellElements,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type OpenReceiveCheckoutShellProps,
  type OpenReceiveReadThemePreferenceOptions,
  type OpenReceiveStoredThemeModelOptions,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeModel,
  type OpenReceiveThemeModelOptions,
  type OpenReceiveThemePreference,
  type OpenReceiveThemeStorageOptions,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes
} from "@openreceive/browser/internal";
import {
  defineOpenReceiveElements,
  type DefineOpenReceiveElementsOptions
} from "@openreceive/elements";

export {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_STORAGE_KEY,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  applyCheckoutThemeAttributes,
  applyOpenReceiveThemeAttributes,
  createCheckoutController,
  createCheckoutElement,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createCheckoutShell,
  createCheckoutShellModel,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  createOpenReceiveThemeToggleElement,
  createOpenReceiveThemeToggleElementAttributes,
  readOpenReceiveThemePreference,
  syncOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemeControls,
  toggleOpenReceiveStoredThemePreference,
  writeOpenReceiveThemePreference
} from "@openreceive/browser/internal";
export type {
  CreateCheckoutElementOptions,
  CreateCheckoutShellOptions,
  CreateOpenReceiveThemeToggleElementOptions,
  CheckoutElementAttributeOptions,
  CheckoutElementAttributes,
  CheckoutElementDocument,
  CheckoutElementEventHandlers,
  CheckoutElementListeners,
  CheckoutController,
  CheckoutControllerOptions,
  CheckoutShellElements,
  CheckoutShellCheckoutBinding,
  CheckoutShellModel,
  CheckoutShellOptions,
  CheckoutShellThemeToggleBinding,
  CheckoutElementTarget,
  CheckoutSnapshot as Checkout,
  CheckoutSnapshot,
  OpenReceiveCheckoutProps,
  OpenReceiveCheckoutShellProps,
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
} from "@openreceive/browser/internal";
export { defineOpenReceiveElements } from "@openreceive/elements";
export type { DefineOpenReceiveElementsOptions } from "@openreceive/elements";

export interface OpenReceiveVueCheckoutBindingOptions
  extends CheckoutElementAttributeOptions,
    CheckoutElementEventHandlers {}

export interface OpenReceiveVueCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attrs: CheckoutElementAttributes;
  readonly listeners: CheckoutElementListeners;
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

export interface OpenReceiveVueCheckoutComponentProps
  extends OpenReceiveCheckoutShellProps {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveVueCheckoutComponentModel
  extends OpenReceiveVueCheckoutShellBinding {
  readonly componentName: "Checkout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveVueCheckoutBinding(
  snapshot: CheckoutSnapshot,
  options: OpenReceiveVueCheckoutBindingOptions = {}
): OpenReceiveVueCheckoutBinding {
  return {
    tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    attrs: createCheckoutElementAttributes(snapshot, options),
    listeners: createCheckoutElementListeners(options)
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
  snapshot: CheckoutSnapshot,
  options: CheckoutShellOptions = {}
): OpenReceiveVueCheckoutShellBinding {
  const shell = createCheckoutShellModel(snapshot, options);
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
  props: OpenReceiveVueCheckoutComponentProps
): OpenReceiveVueCheckoutComponentModel {
  const { defineElementsOptions, ...shellProps } = props;
  const shellModel = createCheckoutShellModelFromProps(shellProps);
  const shell: OpenReceiveVueCheckoutShellBinding = {
    theme: shellModel.theme,
    rootAttrs: shellModel.rootAttributes,
    checkout: {
      tagName: shellModel.checkout.tagName,
      attrs: shellModel.checkout.attributes,
      listeners: shellModel.checkout.listeners
    },
    themeToggle: {
      tagName: shellModel.themeToggle.tagName,
      attrs: shellModel.themeToggle.attributes
    }
  };
  return {
    componentName: "Checkout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveVueCheckoutController(
  options: CheckoutControllerOptions
): CheckoutController {
  return createCheckoutController(options);
}

export function createOpenReceiveVueCheckoutShell(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutShellOptions = {}
): CheckoutShellElements {
  return createCheckoutShell(snapshot, options);
}
