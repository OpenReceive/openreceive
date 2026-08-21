import {
  openReceiveBrowserLogLevelOrder,
  readOpenReceiveBrowserLogLevelFromEnvironment,
  resolveOpenReceiveBrowserLogLevel,
} from "./log-level.ts";
import type {
  OpenReceiveBrowserLogEntry,
  OpenReceiveBrowserLogLevel,
  OpenReceiveBrowserLogger,
  OpenReceiveBrowserLoggerOption,
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
    sink.call(
      target,
      `[${now().toISOString()}] ${level.toUpperCase()} [${prefix}] ${event}: ${message}`,
      fields,
    );
  };
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
