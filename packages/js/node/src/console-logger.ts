import { compact } from "@openreceive/core";
import {
  openReceiveLogLevelOrder,
  readOpenReceiveLogLevelFromEnvironment,
  resolveOpenReceiveLogLevel,
} from "./log-level.ts";
import type { OpenReceiveLogEvent, Logger, OpenReceiveLogLevel } from "./service/types.ts";

export interface CreateOpenReceiveConsoleLoggerOptions {
  /** Prefix before the event, e.g. `openreceive:my-app`. Default `openreceive`. */
  readonly prefix?: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   * Accepts the same values as `LOG_LEVEL` (`DEBUG` | `INFO` | `WARN` | `ERROR`).
   */
  readonly minLevel?: OpenReceiveLogLevel | string;
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
  /** Clock for the leading ISO timestamp. Default `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Logger that writes OpenReceive {@link OpenReceiveLogEvent} values to the console.
 * Pair with the auto-attached file logger, or pass as `createOpenReceive({ logger })`.
 *
 * Format: `[ISO8601] LEVEL [prefix] event: message { fields }`
 */
export function createOpenReceiveConsoleLogger(
  options: CreateOpenReceiveConsoleLoggerOptions = {},
): Logger {
  const prefix = options.prefix ?? "openreceive";
  const target = options.console ?? console;
  const now = options.now ?? (() => new Date());

  return (entry: OpenReceiveLogEvent) => {
    const minLevel =
      options.minLevel === undefined
        ? readOpenReceiveLogLevelFromEnvironment()
        : resolveOpenReceiveLogLevel(options.minLevel);
    if (openReceiveLogLevelOrder(entry.level) < openReceiveLogLevelOrder(minLevel)) return;
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
  level?: OpenReceiveLogLevel,
) => void;

export interface CreateHostConsoleLoggerOptions {
  /** Prefix before the event, e.g. `hello-fruit:node-express:server`. */
  readonly prefix: string;
  /**
   * Minimum level to emit. Default: `LOG_LEVEL` from the environment, or `info`.
   */
  readonly minLevel?: OpenReceiveLogLevel | string;
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
        ? readOpenReceiveLogLevelFromEnvironment()
        : resolveOpenReceiveLogLevel(options.minLevel);
    if (openReceiveLogLevelOrder(level) < openReceiveLogLevelOrder(minLevel)) return;
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
  readonly level: OpenReceiveLogLevel;
  readonly prefix: string;
  readonly event: string;
  readonly message: string;
}): string {
  return `[${input.at}] ${input.level.toUpperCase()} [${input.prefix}] ${input.event}: ${input.message}`;
}
