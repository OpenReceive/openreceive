import type {
  OpenReceiveBrowserLogEntry,
  OpenReceiveBrowserLogLevel,
  OpenReceiveBrowserLogger,
} from "./ui.ts";

export interface CreateOpenReceiveBrowserConsoleLoggerOptions {
  /** Prefix before the event, e.g. `openreceive:my-app:client`. Default `openreceive`. */
  readonly prefix?: string;
  readonly minLevel?: OpenReceiveBrowserLogLevel;
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
}

/**
 * Browser logger that writes OpenReceive checkout log entries to the console.
 * Without a logger, browser helpers silently drop checkout logs — pass this to
 * `<Checkout logger={…} />` / `createCheckoutController({ logger })`.
 */
export function createOpenReceiveBrowserConsoleLogger(
  options: CreateOpenReceiveBrowserConsoleLoggerOptions = {},
): OpenReceiveBrowserLogger {
  const prefix = options.prefix ?? "openreceive";
  const minLevel = options.minLevel ?? "debug";
  const minOrder = BROWSER_LOG_LEVEL_ORDER[minLevel];
  const target = options.console ?? console;

  return (entry: OpenReceiveBrowserLogEntry) => {
    if (BROWSER_LOG_LEVEL_ORDER[entry.level] < minOrder) return;
    const { level, event, message, ...fields } = entry;
    const method =
      level === "error" ? "error" : level === "warn" ? "warn" : level === "debug" ? "debug" : "info";
    const sink = target[method] ?? target.log;
    sink.call(target, `[${prefix}] ${event}: ${message}`, fields);
  };
}

export type HostBrowserConsoleLogger = (
  event: string,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface CreateHostBrowserConsoleLoggerOptions {
  readonly prefix: string;
  readonly console?: Pick<Console, "log">;
}

/** Ad-hoc `(event, message, fields?)` console logger for host browser apps. */
export function createHostBrowserConsoleLogger(
  options: CreateHostBrowserConsoleLoggerOptions,
): HostBrowserConsoleLogger {
  const target = options.console ?? console;
  return (event, message, fields = {}) => {
    target.log(`[${options.prefix}] ${event}: ${message}`, {
      at: new Date().toISOString(),
      ...fields,
    });
  };
}

const BROWSER_LOG_LEVEL_ORDER: Record<OpenReceiveBrowserLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
