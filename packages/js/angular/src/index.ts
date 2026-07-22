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
  type OpenReceiveStoredThemeModelOptions,
  type OpenReceiveThemeModel,
  type OpenReceiveThemeModelOptions,
  type OpenReceiveThemePreference,
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

export interface OpenReceiveAngularCheckoutBindingOptions
  extends CheckoutElementAttributeOptions,
    CheckoutElementEventHandlers {}

export interface OpenReceiveAngularCheckoutBinding {
  readonly selector: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attributes: CheckoutElementAttributes;
  readonly events: CheckoutElementListeners;
}

export interface OpenReceiveAngularThemeToggleBinding {
  readonly selector: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly attributes: OpenReceiveThemeToggleElementAttributes;
}

export interface OpenReceiveAngularCheckoutShellBinding {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttributes: OpenReceiveThemeModel["attributes"];
  readonly checkout: OpenReceiveAngularCheckoutBinding;
  readonly themeToggle: OpenReceiveAngularThemeToggleBinding | null;
}

export interface OpenReceiveAngularCheckoutComponentProps
  extends OpenReceiveCheckoutShellProps {
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export interface OpenReceiveAngularCheckoutComponentModel
  extends OpenReceiveAngularCheckoutShellBinding {
  readonly componentName: "Checkout";
  readonly defineElements: typeof defineOpenReceiveElements;
  readonly defineElementsOptions?: DefineOpenReceiveElementsOptions;
}

export function createOpenReceiveAngularCheckoutBinding(
  snapshot: CheckoutSnapshot,
  options: OpenReceiveAngularCheckoutBindingOptions = {}
): OpenReceiveAngularCheckoutBinding {
  return {
    selector: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    attributes: createCheckoutElementAttributes(snapshot, options),
    events: createCheckoutElementListeners(options)
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
  snapshot: CheckoutSnapshot | null,
  options: CheckoutShellOptions = {}
): OpenReceiveAngularCheckoutShellBinding {
  const shell = createCheckoutShellModel(snapshot, options);
  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout: {
      selector: shell.checkout.tagName,
      attributes: shell.checkout.attributes,
      events: shell.checkout.listeners
    },
    themeToggle:
      shell.themeToggle === null
        ? null
        : {
            selector: shell.themeToggle.tagName,
            attributes: shell.themeToggle.attributes
          }
  };
}

export function createOpenReceiveAngularCheckoutComponentModel(
  props: OpenReceiveAngularCheckoutComponentProps
): OpenReceiveAngularCheckoutComponentModel {
  const { defineElementsOptions, ...shellProps } = props;
  const shellModel = createCheckoutShellModelFromProps(shellProps);
  const shell: OpenReceiveAngularCheckoutShellBinding = {
    theme: shellModel.theme,
    rootAttributes: shellModel.rootAttributes,
    checkout: {
      selector: shellModel.checkout.tagName,
      attributes: shellModel.checkout.attributes,
      events: shellModel.checkout.listeners
    },
    themeToggle:
      shellModel.themeToggle === null
        ? null
        : {
            selector: shellModel.themeToggle.tagName,
            attributes: shellModel.themeToggle.attributes
          }
  };
  return {
    componentName: "Checkout",
    defineElements: defineOpenReceiveElements,
    defineElementsOptions,
    ...shell
  };
}

export function createOpenReceiveAngularCheckoutController(
  options: CheckoutControllerOptions
): CheckoutController {
  return createCheckoutController(options);
}

export function createOpenReceiveAngularCheckoutShell(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutShellOptions = {}
): CheckoutShellElements {
  return createCheckoutShell(snapshot, options);
}
