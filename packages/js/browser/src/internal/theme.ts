import {
  OPENRECEIVE_THEME_STORAGE_KEY,
  type ReadThemePreferenceOptions,
  type ResolvedTheme,
  type StoredThemeModelOptions,
  type ThemeAttributeTarget,
  type ThemeControlTargets,
  type ThemeModel,
  type ThemeModelOptions,
  type ThemePreference,
  type ThemeStorageOptions,
} from "./ui.ts";

export function readThemePreference(options: ReadThemePreferenceOptions = {}): ThemePreference {
  const value = readStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
  );
  return value === "light" || value === "dark" || value === "system"
    ? value
    : (options.defaultTheme ?? "system");
}

export function writeThemePreference(
  theme: ThemePreference,
  options: ThemeStorageOptions = {},
): void {
  writeStorageValue(
    options.storage ?? getBrowserStorage(),
    options.storageKey ?? OPENRECEIVE_THEME_STORAGE_KEY,
    theme,
  );
}

export function resolveTheme(
  theme: ThemePreference,
  options: {
    readonly systemDark?: boolean;
  } = {},
): ResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  if (options.systemDark !== undefined) return options.systemDark ? "dark" : "light";
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getNextThemePreference(
  theme: ThemePreference,
  options: ThemeModelOptions = {},
): ThemePreference {
  return resolveTheme(theme, options) === "dark" ? "light" : "dark";
}

export function getThemeToggleLabel(resolvedTheme: ResolvedTheme): string {
  // The label names the ACTION, not the state: a checkout stuck light on a dark
  // page must offer "switch to dark mode", not announce "light mode" at it.
  return `switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`;
}

export function createThemeModel(
  theme: ThemePreference,
  options: ThemeModelOptions = {},
): ThemeModel {
  const resolvedTheme = resolveTheme(theme, options);
  return {
    theme,
    resolvedTheme,
    nextTheme: getNextThemePreference(theme, options),
    toggleLabel: getThemeToggleLabel(resolvedTheme),
    attributes: {
      "data-theme": resolvedTheme,
      "data-openreceive-theme": resolvedTheme,
    },
    checkoutElementAttributes: {
      theme: resolvedTheme,
    },
  };
}

export function createStoredThemeModel(options: StoredThemeModelOptions = {}): ThemeModel {
  const theme = readThemePreference(options);
  return createThemeModel(theme, { systemDark: options.systemDark });
}

export function toggleStoredThemePreference(options: StoredThemeModelOptions = {}): ThemeModel {
  const currentTheme = createStoredThemeModel(options);
  writeThemePreference(currentTheme.nextTheme, options);
  return createStoredThemeModel(options);
}

export function applyThemeAttributes(
  target: ThemeAttributeTarget | null | undefined,
  theme: ThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.attributes)) {
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

export function applyCheckoutThemeAttributes(
  target: ThemeAttributeTarget | null | undefined,
  theme: ThemeModel,
): void {
  if (target === null || target === undefined) return;
  for (const [name, value] of Object.entries(theme.checkoutElementAttributes)) {
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

export function applyThemeControls(targets: ThemeControlTargets, theme: ThemeModel): void {
  applyThemeAttributes(targets.root, theme);
  applyCheckoutThemeAttributes(targets.checkout, theme);
  if (targets.toggle !== null && targets.toggle !== undefined) {
    targets.toggle.textContent = theme.toggleLabel;
  }
}

export function syncStoredThemeControls(
  targets: ThemeControlTargets,
  options: StoredThemeModelOptions = {},
): ThemeModel {
  const theme = createStoredThemeModel(options);
  applyThemeControls(targets, theme);
  return theme;
}

export function toggleStoredThemeControls(
  targets: ThemeControlTargets,
  options: StoredThemeModelOptions = {},
): ThemeModel {
  const theme = toggleStoredThemePreference(options);
  applyThemeControls(targets, theme);
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
