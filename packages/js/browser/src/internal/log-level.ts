import type { BrowserLogLevel } from "./ui.ts";

const BROWSER_LOG_LEVEL_ORDER: Record<BrowserLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const BROWSER_LOG_LEVEL_ALIASES: Record<string, BrowserLogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
};

/** Compare browser log levels (`debug` < `info` < `warn` < `error`). */
export function browserLogLevelOrder(level: BrowserLogLevel): number {
  return BROWSER_LOG_LEVEL_ORDER[level];
}

/**
 * Parse `LOG_LEVEL` values such as `DEBUG`, `info`, or `Warning`.
 * Returns `undefined` when the value is missing or unrecognized.
 */
export function parseBrowserLogLevel(
  value: string | undefined | null,
): BrowserLogLevel | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return BROWSER_LOG_LEVEL_ALIASES[normalized];
}

/** Resolve a log level string, falling back to `info` when unset/invalid. */
export function resolveBrowserLogLevel(
  value?: string | null,
  fallback: BrowserLogLevel = "info",
): BrowserLogLevel {
  return parseBrowserLogLevel(value) ?? fallback;
}

type BrowserEnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Read `LOG_LEVEL` for browser/checkout consoles.
 *
 * Checks, in order:
 * 1. explicit source map
 * 2. `globalThis.__OPENRECEIVE_LOG_LEVEL__` (runtime injection from the host HTML)
 * 3. `import.meta.env.LOG_LEVEL` / `VITE_LOG_LEVEL` / `NEXT_PUBLIC_LOG_LEVEL`
 * 4. `process.env.LOG_LEVEL` when available (SSR / Vite)
 *
 * Default `info`.
 */
export function readBrowserLogLevelFromEnvironment(source?: BrowserEnvSource): BrowserLogLevel {
  if (source !== undefined) {
    return resolveBrowserLogLevel(
      source.LOG_LEVEL ?? source.VITE_LOG_LEVEL ?? source.NEXT_PUBLIC_LOG_LEVEL,
    );
  }

  const fromGlobal = parseBrowserLogLevel(readGlobalLogLevel());
  if (fromGlobal !== undefined) return fromGlobal;

  const metaEnv = readImportMetaEnv();
  const parsedMeta = parseBrowserLogLevel(
    metaEnv?.LOG_LEVEL ?? metaEnv?.VITE_LOG_LEVEL ?? metaEnv?.NEXT_PUBLIC_LOG_LEVEL,
  );
  if (parsedMeta !== undefined) return parsedMeta;

  const processEnv =
    typeof process !== "undefined" ? (process.env as BrowserEnvSource | undefined) : undefined;
  return resolveBrowserLogLevel(processEnv?.LOG_LEVEL);
}

function readGlobalLogLevel(): string | undefined {
  try {
    const value = (globalThis as { __OPENRECEIVE_LOG_LEVEL__?: unknown }).__OPENRECEIVE_LOG_LEVEL__;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readImportMetaEnv(): BrowserEnvSource | undefined {
  try {
    // Property access only — never a bare `import.meta` reference. Bundlers
    // (webpack) statically replace `import.meta.env`/`import.meta.url`, but a
    // bare reference forces a runtime import.meta mock that throws in
    // classic-script output (`__webpack_module__ is not defined`).
    return (import.meta as ImportMeta & { readonly env?: BrowserEnvSource }).env;
  } catch {
    return undefined;
  }
}
