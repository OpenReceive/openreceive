import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_THEME_STORAGE_KEY,
  createOpenReceiveThemeModel,
  orClasses,
  readOpenReceiveThemePreference,
  writeOpenReceiveThemePreference,
  type OpenReceiveThemePreference,
} from "@openreceive/browser/internal";
import { joinClassNames } from "./utils.ts";
import type {
  ThemeScopeProps,
  ThemeToggleProps,
  UseThemeOptions,
  UseThemeResult,
} from "./types.ts";

const OpenReceiveThemeContext = React.createContext<UseThemeResult | null>(null);

function useLocalTheme(options: UseThemeOptions = {}): UseThemeResult {
  const storageKey = options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY;
  const [theme, setThemeState] = React.useState<OpenReceiveThemePreference>(() =>
    readOpenReceiveThemePreference({
      storage: options.storage,
      storageKey,
      defaultTheme: options.defaultTheme,
    }),
  );
  const [systemDark, setSystemDark] = React.useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  React.useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (media === undefined) return undefined;
    const update = () => setSystemDark(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  // Keep nested checkouts in sync when ThemeScope (or another tab) updates storage.
  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== storageKey ||
        event.storageArea !== (options.storage ?? globalThis.localStorage)
      ) {
        return;
      }
      setThemeState(
        readOpenReceiveThemePreference({
          storage: options.storage,
          storageKey,
          defaultTheme: options.defaultTheme,
        }),
      );
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => globalThis.removeEventListener?.("storage", onStorage);
  }, [options.defaultTheme, options.storage, storageKey]);

  const themeModel = createOpenReceiveThemeModel(theme, { systemDark });

  const setTheme = React.useCallback(
    (nextTheme: OpenReceiveThemePreference) => {
      setThemeState(nextTheme);
      writeOpenReceiveThemePreference(nextTheme, {
        storage: options.storage,
        storageKey,
      });
    },
    [options.storage, storageKey],
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
  const scoped = React.useContext(OpenReceiveThemeContext);
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
  const themeModel = createOpenReceiveThemeModel(activeTheme);

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

  return React.createElement(
    ButtonComponent,
    componentProps,
    children ?? themeModel.toggleLabel,
  );
}

export function ThemeScope(props: ThemeScopeProps): React.ReactElement {
  const {
    as: Element = "div",
    defaultTheme,
    themeStorageKey,
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
    storageKey: themeStorageKey,
    storage,
  });
  const scopedChildren = typeof children === "function" ? children(theme) : children;

  return React.createElement(
    OpenReceiveThemeContext.Provider,
    { value: theme },
    React.createElement(
      Element,
      {
        ...elementProps,
        ...theme.attributes,
      },
      [
        themeToggle
          ? React.createElement(
              "div",
              {
                className: topbarClassName,
                key: "openreceive-theme-scope-toggle",
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
      ],
    ),
  );
}
