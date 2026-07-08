import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_THEME_STORAGE_KEY,
  createOpenReceiveThemeModel,
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

export function useTheme(options: UseThemeOptions = {}): UseThemeResult {
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
    setTheme,
    toggleTheme,
  };
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
    className: joinClassNames(
      "or-theme-toggle-button",
      `or-theme-toggle-${themeModel.resolvedTheme}`,
      buttonProps.className,
    ),
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

  const defaultChildren = React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "span",
      {
        "aria-hidden": true,
        className: "or-theme-toggle-track",
      },
      React.createElement("span", {
        className: "or-theme-toggle-icon or-theme-toggle-icon-light",
      }),
    ),
    React.createElement(
      "span",
      {
        className: "or-theme-toggle-label",
      },
      themeModel.toggleLabel,
    ),
  );

  return React.createElement(ButtonComponent, componentProps, children ?? defaultChildren);
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
  const theme = useTheme({
    defaultTheme,
    storageKey: themeStorageKey,
    storage,
  });
  const scopedChildren = typeof children === "function" ? children(theme) : children;

  return React.createElement(
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
  );
}
