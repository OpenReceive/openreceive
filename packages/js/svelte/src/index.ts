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

export interface OpenReceiveSvelteCheckoutPropsOptions
  extends CheckoutElementAttributeOptions {}

export interface OpenReceiveSvelteCheckoutBindingOptions
  extends OpenReceiveSvelteCheckoutPropsOptions,
    CheckoutElementEventHandlers {}

export interface OpenReceiveSvelteCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly props: CheckoutElementAttributes;
  readonly events: CheckoutElementListeners;
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

export interface OpenReceiveSvelteCheckoutComponentProps
  extends OpenReceiveCheckoutShellProps {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveSvelteCheckoutComponentModel
  extends OpenReceiveSvelteCheckoutShellBinding {
  readonly componentName: "Checkout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveSvelteCheckoutProps(
  checkout: CheckoutSnapshot,
  options: OpenReceiveSvelteCheckoutPropsOptions = {}
): CheckoutElementAttributes {
  return createCheckoutElementAttributes(checkout, options);
}

export function createCheckoutBinding(
  checkout: CheckoutSnapshot,
  options: OpenReceiveSvelteCheckoutBindingOptions = {}
): OpenReceiveSvelteCheckoutBinding {
  return {
    tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    props: createOpenReceiveSvelteCheckoutProps(checkout, options),
    events: createCheckoutElementListeners(options)
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
  checkout: CheckoutSnapshot,
  options: CheckoutShellOptions = {}
): OpenReceiveSvelteCheckoutShellBinding {
  const shell = createCheckoutShellModel(checkout, options);
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
  props: OpenReceiveSvelteCheckoutComponentProps
): OpenReceiveSvelteCheckoutComponentModel {
  const { defineElementsOptions, ...shellProps } = props;
  const shellModel = createCheckoutShellModelFromProps(shellProps);
  const shell: OpenReceiveSvelteCheckoutShellBinding = {
    theme: shellModel.theme,
    rootProps: shellModel.rootAttributes,
    checkout: {
      tagName: shellModel.checkout.tagName,
      props: shellModel.checkout.attributes,
      events: shellModel.checkout.listeners
    },
    themeToggle: {
      tagName: shellModel.themeToggle.tagName,
      props: shellModel.themeToggle.attributes
    }
  };
  return {
    componentName: "Checkout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveSvelteCheckoutController(
  options: CheckoutControllerOptions
): CheckoutController {
  return createCheckoutController(options);
}

export function createOpenReceiveSvelteCheckoutShell(
  checkout: CheckoutSnapshot,
  options: CreateCheckoutShellOptions = {}
): CheckoutShellElements {
  return createCheckoutShell(checkout, options);
}
