// The single shared surface behind the vue/svelte/angular wrappers. Each
// wrapper package re-exports a curated list from this module — the byte-
// identical ~200-line blocks that used to live in all three packages (and had
// already drifted) live here once.
//
// Canonical binding contract (identical across frameworks): bindings expose
// `tagName`, `attributes`, and `listeners`.

import {
  type CheckoutElementAttributeOptions,
  type CheckoutElementAttributes,
  type CheckoutElementEventHandlers,
  type CheckoutElementListeners,
  type CheckoutShellModel,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  createCheckoutElementAttributes,
  createCheckoutElementListeners,
  createCheckoutShellModel,
  createOpenReceiveThemeToggleElementAttributes,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  type OpenReceiveCheckoutComponentProps,
  type OpenReceiveThemeModel,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes,
} from "@openreceive/browser/internal";

// Curated re-exports: only the browser/internal names the wrapper factories
// and components below put in their signatures (E21). The wrappers' curated
// index files re-export from here; anything not listed stays private
// element plumbing in @openreceive/browser and @openreceive/elements.
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
  OpenReceiveCheckoutComponentProps,
  OpenReceiveCheckoutPropsValidation,
  OpenReceiveStoredThemeModelOptions,
  OpenReceiveThemeModel,
  OpenReceiveThemeModelOptions,
  OpenReceiveThemePreference,
  OpenReceiveThemeToggleElementAttributeOptions,
  OpenReceiveThemeToggleElementAttributes,
} from "@openreceive/browser/internal";
// Re-exported under their own names: a wrapper that needs the controller, the
// standalone shell, or a theme model gets the browser factory itself. The
// four `createOpenReceiveWrapper*` aliases that used to wrap these one to one
// are gone — an alias is a second name for one concept, not a seam.
export {
  createCheckoutController,
  createCheckoutShell,
  createOpenReceiveStoredThemeModel,
  createOpenReceiveThemeModel,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  // The create/snapshot boundary check: one implementation in the browser floor,
  // called by these wrappers and by @openreceive/react alike (G6a).
  validateOpenReceiveCheckoutProps,
} from "@openreceive/browser/internal";
export type { DefineOpenReceiveElementsOptions } from "./index.ts";
export { defineOpenReceiveElements } from "./index.ts";

/**
 * Every event the checkout element dispatches, in one place. `docs/internal/wrapper-parity.md`
 * is the conformance table: each wrapper exposes all of these as first-class props.
 * The browser listener factory covers the full set (including `openreceive-open-wallet`),
 * so this is the base handler surface under a wrapper-facing name.
 */
export type OpenReceiveWrapperCheckoutEventHandlers = CheckoutElementEventHandlers;

export interface OpenReceiveWrapperCheckoutBindingOptions
  extends CheckoutElementAttributeOptions,
    OpenReceiveWrapperCheckoutEventHandlers {}

export interface OpenReceiveWrapperCheckoutShellOptions
  extends CheckoutShellOptions,
    OpenReceiveWrapperCheckoutEventHandlers {
  /**
   * Resolve the theme from the deterministic default instead of reading storage and
   * `matchMedia`. Wrappers pass this until they are mounted so a server-rendered shell
   * and the first client render agree on `data-theme`.
   */
  readonly deferThemeResolution?: boolean;
}

export interface OpenReceiveWrapperCheckoutBinding {
  readonly tagName: typeof OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME;
  readonly attributes: CheckoutElementAttributes;
  readonly listeners: CheckoutElementListeners;
}

export interface OpenReceiveWrapperThemeToggleBinding {
  readonly tagName: typeof OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME;
  readonly attributes: OpenReceiveThemeToggleElementAttributes;
}

export interface OpenReceiveWrapperCheckoutShellBinding {
  readonly theme: OpenReceiveThemeModel;
  readonly rootAttributes: Partial<OpenReceiveThemeModel["attributes"]>;
  readonly checkout: OpenReceiveWrapperCheckoutBinding;
  readonly themeToggle: OpenReceiveWrapperThemeToggleBinding | null;
}

/**
 * The flat prop surface of every element wrapper component: the shared checkout
 * props, the element's event handlers, and the shell escape hatch. The shipped
 * SFC `.d.ts` files alias this type and the Vue SFC derives its `defineProps`
 * from it, so the surface exists in exactly one place; prop names, defaults,
 * and per-mode applicability are the shared contract in
 * `docs/internal/wrapper-parity.md`.
 */
export interface OpenReceiveWrapperCheckoutComponentProps
  extends OpenReceiveCheckoutComponentProps,
    OpenReceiveWrapperCheckoutEventHandlers {
  /** Escape hatch for the rest of `CheckoutShellOptions`. */
  readonly options?: CheckoutShellOptions;
}

export function createOpenReceiveWrapperCheckoutBinding(
  snapshot: CheckoutSnapshot,
  options: OpenReceiveWrapperCheckoutBindingOptions = {},
): OpenReceiveWrapperCheckoutBinding {
  return {
    tagName: OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
    attributes: createCheckoutElementAttributes(snapshot, options),
    listeners: createCheckoutElementListeners(options),
  };
}

export function createOpenReceiveWrapperThemeToggleBinding(
  options: OpenReceiveThemeToggleElementAttributeOptions = {},
): OpenReceiveWrapperThemeToggleBinding {
  return {
    tagName: OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
    attributes: createOpenReceiveThemeToggleElementAttributes(options),
  };
}

/**
 * Storage stub for `deferThemeResolution`: reads nothing, writes nothing, so the theme
 * falls back to `defaultTheme` and the shell renders identically on server and client.
 */
const NO_THEME_STORAGE: Storage = {
  length: 0,
  clear() {},
  getItem: () => null,
  key: () => null,
  removeItem() {},
  setItem() {},
};

function toWrapperShellBinding(
  shell: CheckoutShellModel,
  listeners: CheckoutElementListeners,
): OpenReceiveWrapperCheckoutShellBinding {
  return {
    theme: shell.theme,
    rootAttributes: shell.rootAttributes,
    checkout: {
      tagName: shell.checkout.tagName,
      attributes: shell.checkout.attributes,
      listeners,
    },
    themeToggle:
      shell.themeToggle === null
        ? null
        : {
            tagName: shell.themeToggle.tagName,
            attributes: shell.themeToggle.attributes,
          },
  };
}

export function createOpenReceiveWrapperCheckoutShellBinding(
  snapshot: CheckoutSnapshot | null,
  options: OpenReceiveWrapperCheckoutShellOptions = {},
): OpenReceiveWrapperCheckoutShellBinding {
  const { deferThemeResolution, ...shellOptions } = options;
  // A host-supplied storage stays in place: it is readable on the server too, and
  // reading it is the documented way to server-render a chosen theme
  // (docs/internal/wrapper-parity.md). Only the implicit browser localStorage is
  // stubbed out until mount.
  const shell = createCheckoutShellModel(
    snapshot,
    deferThemeResolution === true
      ? {
          ...shellOptions,
          ...(shellOptions.storage === undefined ? { storage: NO_THEME_STORAGE } : {}),
          systemDark: false,
        }
      : shellOptions,
  );
  return toWrapperShellBinding(shell, createCheckoutElementListeners(options));
}
