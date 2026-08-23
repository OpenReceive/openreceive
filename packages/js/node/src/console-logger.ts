import { compact } from "@openreceive/core";
import { logLevelOrder, readLogLevelFromEnvironment, resolveLogLevel } from "./log-level.ts";
import type { LogEvent, Logger, LogLevel } from "./service/types.ts";

export interface CreateOpenReceiveConsoleLoggerOptions {
  /** Prefix before the event, e.g. `openreceive:my-app`. Default `openreceive`. */
  readonly prefix?: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   * Accepts the same values as `LOG_LEVEL` (`DEBUG` | `INFO` | `WARN` | `ERROR`).
   */
  readonly minLevel?: LogLevel | string;
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
  /** Clock for the leading ISO timestamp. Default `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Logger that writes OpenReceive {@link LogEvent} values to the console.
 * Pair with the auto-attached file logger, or pass as `createOpenReceive({ logger })`.
 *
 * Format: `[ISO8601] LEVEL [prefix] event: message { fields }`
 */
export function createConsoleLogger(options: CreateOpenReceiveConsoleLoggerOptions = {}): Logger {
  const prefix = options.prefix ?? "openreceive";
  const target = options.console ?? console;
  const now = options.now ?? (() => new Date());

  return (entry: LogEvent) => {
    const minLevel =
      options.minLevel === undefined
        ? readLogLevelFromEnvironment()
        : resolveLogLevel(options.minLevel);
    if (logLevelOrder(entry.level) < logLevelOrder(minLevel)) return;
    const { level, event, message, ...fields } = entry;
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
      formatConsoleLogLine({
        at: now().toISOString(),
        level,
        prefix,
        event,
        message,
      }),
      compact(fields),
    );
  };
}

export type HostConsoleLogger = (
  event: string,
  message: string,
  fields?: Record<string, unknown>,
  level?: LogLevel,
) => void;

export interface CreateHostConsoleLoggerOptions {
  /** Prefix before the event, e.g. `hello-fruit:node-express:server`. */
  readonly prefix: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   */
  readonly minLevel?: LogLevel | string;
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
  readonly now?: () => Date;
}

/** Ad-hoc `(event, message, fields?, level?)` console logger for host app routes. */
export function createHostConsoleLogger(
  options: CreateHostConsoleLoggerOptions,
): HostConsoleLogger {
  const target = options.console ?? console;
  const now = options.now ?? (() => new Date());

  return (event, message, fields = {}, level = "info") => {
    const minLevel =
      options.minLevel === undefined
        ? readLogLevelFromEnvironment()
        : resolveLogLevel(options.minLevel);
    if (logLevelOrder(level) < logLevelOrder(minLevel)) return;
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
      formatConsoleLogLine({
        at: now().toISOString(),
        level,
        prefix: options.prefix,
        event,
        message,
      }),
      compact(fields),
    );
  };
}

function formatConsoleLogLine(input: {
  readonly at: string;
  readonly level: LogLevel;
  readonly prefix: string;
  readonly event: string;
  readonly message: string;
}): string {
  return `[${input.at}] ${input.level.toUpperCase()} [${input.prefix}] ${input.event}: ${input.message}`;
}
