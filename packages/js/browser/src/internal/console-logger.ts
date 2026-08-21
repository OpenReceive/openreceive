import {
  openReceiveBrowserLogLevelOrder,
  readOpenReceiveBrowserLogLevelFromEnvironment,
  resolveOpenReceiveBrowserLogLevel,
} from "./log-level.ts";
import type {
  OpenReceiveBrowserLogEntry,
  OpenReceiveBrowserLogger,
  OpenReceiveBrowserLoggerOption,
  OpenReceiveBrowserLogLevel,
} from "./ui.ts";

type ConsoleTarget = Pick<Console, "debug" | "info" | "warn" | "error" | "log">;

interface ConsoleWriterOptions {
  readonly minLevel?: OpenReceiveBrowserLogLevel | string;
  readonly console?: ConsoleTarget;
  readonly now?: () => Date;
}

/**
 * Shared body of both console loggers: level gate, level→method mapping, and the
 * `[ISO8601] LEVEL [prefix] event: message { fields }` line. Returns a writer that
 * drops entries below the resolved minimum level.
 */
function createConsoleWriter(
  options: ConsoleWriterOptions,
): (
  level: OpenReceiveBrowserLogLevel,
  prefix: string,
  event: string,
  message: string,
  fields: Record<string, unknown>,
) => void {
  const target = options.console ?? console;
  const now = options.now ?? (() => new Date());

  return (level, prefix, event, message, fields) => {
    // Re-resolve when unset so runtime `LOG_LEVEL` / `__OPENRECEIVE_LOG_LEVEL__`
    // changes are honored without rebuilding the client bundle.
    const minLevel =
      options.minLevel === undefined
        ? readOpenReceiveBrowserLogLevelFromEnvironment()
        : resolveOpenReceiveBrowserLogLevel(options.minLevel);
    if (openReceiveBrowserLogLevelOrder(level) < openReceiveBrowserLogLevelOrder(minLevel)) {
      return;
    }
    const method =
      level === "error"
        ? "error"
        : level === "warn"
          ? "warn"
          : level === "debug"
            ? "debug"
            : "info";
    const sink = target[method] ?? target.log;
    const {
      level: _level,
      event: _event,
      message: cleanMessage,
      ...cleanFields
    } = sanitizeBrowserLogEntry({ level, event, message, ...fields });
    sink.call(
      target,
      `[${now().toISOString()}] ${level.toUpperCase()} [${prefix}] ${event}: ${cleanMessage}`,
      cleanFields,
    );
  };
}

/**
 * Redact secrets from a browser log entry before it reaches a logger. Any field whose key
 * looks like a secret (`secret`/`token`/`authorization`/`cookie`/`nwc`), at any nesting
 * depth, is replaced with `[REDACTED]`; string values are additionally scrubbed of NWC URIs
 * and `token=`/`secret=` query params. Exported so callers that log a request (including its
 * headers) can guarantee ordinary application secrets never leak.
 */
export function sanitizeBrowserLogEntry(
  entry: OpenReceiveBrowserLogEntry,
): OpenReceiveBrowserLogEntry {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(value);
    }
  }
  return clean as OpenReceiveBrowserLogEntry;
}

function sanitizeBrowserLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactBrowserSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeBrowserLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(nested);
    }
  }
  return clean;
}

function redactBrowserSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

export interface CreateOpenReceiveBrowserConsoleLoggerOptions {
  /** Prefix before the event, e.g. `openreceive:my-app:client`. Default `openreceive`. */
  readonly prefix?: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   * Accepts the same values as `LOG_LEVEL` (`DEBUG` | `INFO` | `WARN` | `ERROR`).
   */
  readonly minLevel?: OpenReceiveBrowserLogLevel | string;
  readonly console?: ConsoleTarget;
  /** Clock for the leading ISO timestamp. Default `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Browser logger that writes OpenReceive checkout log entries to the console.
 * Checkout helpers attach this automatically when `logger` is omitted; pass
 * `logger={false}` / `logger: false` to disable, or a custom sink to override.
 *
 * Format: `[ISO8601] LEVEL [prefix] event: message { fields }`
 */
export function createOpenReceiveBrowserConsoleLogger(
  options: CreateOpenReceiveBrowserConsoleLoggerOptions = {},
): OpenReceiveBrowserLogger {
  const prefix = options.prefix ?? "openreceive";
  const write = createConsoleWriter(options);

  return (entry: OpenReceiveBrowserLogEntry) => {
    const { level, event, message, ...fields } = entry;
    write(level, prefix, event, message, fields);
  };
}

export type HostBrowserConsoleLogger = (
  event: string,
  message: string,
  fields?: Record<string, unknown>,
  level?: OpenReceiveBrowserLogLevel,
) => void;

export interface CreateHostBrowserConsoleLoggerOptions {
  readonly prefix: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   */
  readonly minLevel?: OpenReceiveBrowserLogLevel | string;
  readonly console?: ConsoleTarget;
  readonly now?: () => Date;
}

/** Ad-hoc `(event, message, fields?, level?)` console logger for host browser apps. */
export function createHostBrowserConsoleLogger(
  options: CreateHostBrowserConsoleLoggerOptions,
): HostBrowserConsoleLogger {
  const write = createConsoleWriter(options);

  return (event, message, fields = {}, level = "info") => {
    write(level, options.prefix, event, message, fields);
  };
}

let defaultBrowserConsoleLogger: OpenReceiveBrowserLogger | undefined;

/**
 * Built-in console logger used when hosts omit `logger`.
 * Honors `LOG_LEVEL` / `globalThis.__OPENRECEIVE_LOG_LEVEL__` on each emit.
 */
export function getDefaultOpenReceiveBrowserConsoleLogger(): OpenReceiveBrowserLogger {
  defaultBrowserConsoleLogger ??= createOpenReceiveBrowserConsoleLogger();
  return defaultBrowserConsoleLogger;
}

/**
 * Resolve a browser logger option:
 * - `false` disables logging
 * - a function uses that sink
 * - `undefined` attaches the built-in console logger
 */
export function resolveOpenReceiveBrowserLogger(
  logger?: OpenReceiveBrowserLoggerOption,
): OpenReceiveBrowserLogger | undefined {
  if (logger === false) return undefined;
  if (logger !== undefined) return logger;
  return getDefaultOpenReceiveBrowserConsoleLogger();
}

export {
  openReceiveBrowserLogLevelOrder,
  parseOpenReceiveBrowserLogLevel,
  readOpenReceiveBrowserLogLevelFromEnvironment,
  resolveOpenReceiveBrowserLogLevel,
} from "./log-level.ts";
