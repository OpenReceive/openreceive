import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_THEME_STORAGE_KEY,
  createThemeModel,
  orClasses,
  readThemePreference,
  writeThemePreference,
  type ThemePreference,
} from "@openreceive/browser/headless";
import { joinClassNames } from "./utils.ts";
import type {
  ThemeScopeProps,
  ThemeToggleProps,
  UseThemeOptions,
  UseThemeResult,
} from "./types.ts";

const ThemeContext = React.createContext<UseThemeResult | null>(null);

/**
 * Local theme writes are not observable through `storage` events (those only fire in other
 * documents), so every hook instance subscribes here and re-reads storage on change.
 */
const storedThemeListeners = new Set<() => void>();
/** Last explicit choice per storage key, so the toggle still works without usable storage. */
const lastSetTheme = new Map<string, ThemePreference>();

function notifyStoredThemeChange(): void {
  for (const listener of storedThemeListeners) listener();
}

function getSystemDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function getServerSystemDark(): boolean {
  return false;
}

function subscribeStoredTheme(onStoreChange: () => void): () => void {
  storedThemeListeners.add(onStoreChange);
  globalThis.addEventListener?.("storage", onStoreChange);
  return () => {
    storedThemeListeners.delete(onStoreChange);
    globalThis.removeEventListener?.("storage", onStoreChange);
  };
}

function subscribeSystemDark(onStoreChange: () => void): () => void {
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener?.("change", onStoreChange);
  return () => media?.removeEventListener?.("change", onStoreChange);
}

function useLocalTheme(options: UseThemeOptions = {}): UseThemeResult {
  const storageKey = options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY;
  const storage = options.storage;
  const defaultTheme = options.defaultTheme;
  // Storage and matchMedia only exist in the browser. Reading them during the first
  // render made every SSR host (the repo's own Next demo included) hydrate a different
  // `data-theme` than it served; useSyncExternalStore renders the deterministic default
  // through hydration and swaps in the stored preference right after mount.
  const theme = React.useSyncExternalStore(
    subscribeStoredTheme,
    React.useCallback(
      () =>
        readThemePreference({
          storage,
          storageKey,
          defaultTheme: lastSetTheme.get(storageKey) ?? defaultTheme,
        }),
      [storage, storageKey, defaultTheme],
    ),
    React.useCallback(
      () =>
        // A host-supplied storage is readable on the server (that is how SSR theming is
        // wired); the implicit browser localStorage is not, so fall back to the default.
        storage === undefined
          ? (defaultTheme ?? "system")
          : readThemePreference({ storage, storageKey, defaultTheme }),
      [storage, storageKey, defaultTheme],
    ),
  );
  const systemDark = React.useSyncExternalStore(
    subscribeSystemDark,
    getSystemDark,
    getServerSystemDark,
  );

  const themeModel = createThemeModel(theme, { systemDark });

  const setTheme = React.useCallback(
    (nextTheme: ThemePreference) => {
      lastSetTheme.set(storageKey, nextTheme);
      writeThemePreference(nextTheme, {
        storage,
        storageKey,
      });
      notifyStoredThemeChange();
    },
    [storage, storageKey],
  );

  const toggleTheme = React.useCallback(() => {
    setTheme(themeModel.nextTheme);
  }, [setTheme, themeModel.nextTheme]);

  return {
    theme,
    resolvedTheme: themeModel.resolvedTheme,
    model: themeModel,
    nextTheme: themeModel.nextTheme,
    toggleLabel: themeModel.toggleLabel,
    attributes: themeModel.attributes,
    checkoutElementAttributes: themeModel.checkoutElementAttributes,
    fromScope: false,
    setTheme,
    toggleTheme,
  };
}

export function useTheme(options: UseThemeOptions = {}): UseThemeResult {
  const scoped = React.useContext(ThemeContext);
  const local = useLocalTheme(options);
  const storageKey = options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY;
  // Prefer an ancestor ThemeScope so nested Checkout stays in sync with the page toggle.
  if (
    scoped !== null &&
    options.storage === undefined &&
    (options.storageKey === undefined || options.storageKey === storageKey) &&
    options.defaultTheme === undefined
  ) {
    return { ...scoped, fromScope: true };
  }
  return local;
}

export function ThemeToggle(props: ThemeToggleProps): React.ReactElement {
  const {
    theme,
    resolvedTheme,
    onThemeChange,
    ButtonComponent = "button",
    children,
    type = "button",
    onClick,
    ...buttonProps
  } = props;
  const fallback = useTheme({
    defaultTheme: theme,
  });
  const activeTheme = resolvedTheme ?? fallback.resolvedTheme;
  const themeModel = createThemeModel(activeTheme);

  const componentProps: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown> = {
    ...buttonProps,
    "aria-label": themeModel.toggleLabel,
    className: joinClassNames(orClasses.themeToggle, buttonProps.className),
    title: themeModel.toggleLabel,
    type,
    [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.themeToggle]: "",
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      onThemeChange?.(themeModel.nextTheme);
      if (onThemeChange === undefined) fallback.setTheme(themeModel.nextTheme);
    },
  };

  return React.createElement(ButtonComponent, componentProps, children ?? themeModel.toggleLabel);
}

export function ThemeScope(props: ThemeScopeProps): React.ReactElement {
  const {
    as: Element = "div",
    defaultTheme,
    storageKey,
    storage,
    themeToggle = false,
    topbarClassName,
    themeToggleClassName,
    ButtonComponent,
    children,
    ...elementProps
  } = props;
  const theme = useLocalTheme({
    defaultTheme,
    storageKey,
    storage,
  });
  const scopedChildren = typeof children === "function" ? children(theme) : children;

  return React.createElement(
    ThemeContext.Provider,
    { value: theme },
    // Variadic children, not an array: an array child needs a key on every entry.
    React.createElement(
      Element,
      {
        ...elementProps,
        ...theme.attributes,
      },
      themeToggle
        ? React.createElement(
            "div",
            {
              className: topbarClassName,
            },
            React.createElement(ThemeToggle, {
              className: themeToggleClassName,
              theme: theme.theme,
              resolvedTheme: theme.resolvedTheme,
              onThemeChange: theme.setTheme,
              ButtonComponent,
            }),
          )
        : null,
      scopedChildren,
    ),
  );
}
