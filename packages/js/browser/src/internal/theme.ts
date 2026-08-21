import {
  OPENRECEIVE_THEME_STORAGE_KEY,
  type OpenReceiveReadThemePreferenceOptions,
  type OpenReceiveResolvedTheme,
  type OpenReceiveStoredThemeModelOptions,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeControlTargets,
  type OpenReceiveThemeModel,
  type OpenReceiveThemeModelOptions,
  type OpenReceiveThemePreference,
  type OpenReceiveThemeStorageOptions,
} from "./ui.ts";

export function readOpenReceiveThemePreference(
  options: OpenReceiveReadThemePreferenceOptions = {},
): OpenReceiveThemePreference {
  const value = readStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
  );
  return value === "light" || value === "dark" || value === "system"
    ? value
    : (options.defaultTheme ?? "system");
}

export function writeOpenReceiveThemePreference(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeStorageOptions = {},
): void {
  writeStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
    theme,
  );
}

export function resolveOpenReceiveTheme(
  theme: OpenReceiveThemePreference,
  options: {
    readonly systemDark?: boolean;
  } = {},
): OpenReceiveResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (options.systemDark !== undefined) return options.systemDark ? "dark" : "light";
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getOpenReceiveNextThemePreference(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {},
): OpenReceiveThemePreference {
  return resolveOpenReceiveTheme(theme, options) === "dark" ? "light" : "dark";
}

export function getOpenReceiveThemeToggleLabel(resolvedTheme: OpenReceiveResolvedTheme): string {
  return `${resolvedTheme} mode`;
}

export function createOpenReceiveThemeModel(
  theme: OpenReceiveThemePreference,
  options: OpenReceiveThemeModelOptions = {},
): OpenReceiveThemeModel {
  const resolvedTheme = resolveOpenReceiveTheme(theme, options);
  return {
    theme,
    resolvedTheme,
    nextTheme: getOpenReceiveNextThemePreference(theme, options),
    toggleLabel: getOpenReceiveThemeToggleLabel(resolvedTheme),
    attributes: {
      "data-theme": resolvedTheme,
      "data-openreceive-theme": resolvedTheme,
    },
    checkoutElementAttributes: {
      theme: resolvedTheme,
    },
  };
}

export function createOpenReceiveStoredThemeModel(
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = readOpenReceiveThemePreference(options);
  return createOpenReceiveThemeModel(theme, { systemDark: options.systemDark });
}

export function toggleOpenReceiveStoredThemePreference(
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const currentTheme = createOpenReceiveStoredThemeModel(options);
  writeOpenReceiveThemePreference(currentTheme.nextTheme, options);
  return createOpenReceiveStoredThemeModel(options);
}

export function applyOpenReceiveThemeAttributes(
  target: OpenReceiveThemeAttributeTarget | null | undefined,
  theme: OpenReceiveThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.attributes)) {
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

export function applyCheckoutThemeAttributes(
  target: OpenReceiveThemeAttributeTarget | null | undefined,
  theme: OpenReceiveThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.checkoutElementAttributes)) {
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

export function applyOpenReceiveThemeControls(
  targets: OpenReceiveThemeControlTargets,
  theme: OpenReceiveThemeModel,
): void {
  applyOpenReceiveThemeAttributes(targets.root, theme);
  applyCheckoutThemeAttributes(targets.checkout, theme);
  if (targets.toggle !== null && targets.toggle !== undefined) {
    targets.toggle.textContent = theme.toggleLabel;
  }
}

export function syncOpenReceiveStoredThemeControls(
  targets: OpenReceiveThemeControlTargets,
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = createOpenReceiveStoredThemeModel(options);
  applyOpenReceiveThemeControls(targets, theme);
  return theme;
}

export function toggleOpenReceiveStoredThemeControls(
  targets: OpenReceiveThemeControlTargets,
  options: OpenReceiveStoredThemeModelOptions = {},
): OpenReceiveThemeModel {
  const theme = toggleOpenReceiveStoredThemePreference(options);
  applyOpenReceiveThemeControls(targets, theme);
  return theme;
}

function readStorageValue(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageValue(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Browser storage is convenience only; checkout must keep working without it.
  }
}

function getBrowserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
