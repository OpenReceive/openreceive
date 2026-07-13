import type { LogEntry, Logger, OpenReceiveLogLevel } from "./service/types.ts";

const LOG_LEVEL_ORDER: Record<OpenReceiveLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CreateOpenReceiveConsoleLoggerOptions {
  /** Prefix before the event, e.g. `openreceive:my-app`. Default `openreceive`. */
  readonly prefix?: string;
  /** Minimum level to emit. Default `info` (skips `debug`). */
  readonly minLevel?: OpenReceiveLogLevel;
  readonly console?: Pick<Console, "debug" | "info" | "warn" | "error" | "log">;
}

/**
 * Logger that writes OpenReceive {@link LogEntry} values to the console.
 * Pair with the auto-attached file logger, or pass as `createOpenReceive({ logger })`.
 */
export function createOpenReceiveConsoleLogger(
  options: CreateOpenReceiveConsoleLoggerOptions = {},
): Logger {
  const prefix = options.prefix ?? "openreceive";
  const minLevel = options.minLevel ?? "info";
  const minOrder = LOG_LEVEL_ORDER[minLevel];
  const target = options.console ?? console;

  return (entry: LogEntry) => {
    if (LOG_LEVEL_ORDER[entry.level] < minOrder) return;
    const { level, event, message, ...fields } = entry;
    const method =
      level === "error" ? "error" : level === "warn" ? "warn" : level === "debug" ? "debug" : "info";
    const sink = target[method] ?? target.log;
    sink.call(target, `[${prefix}] ${event}: ${message}`, stripUndefinedLogFields(fields));
  };
}

export type HostConsoleLogger = (
  event: string,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface CreateHostConsoleLoggerOptions {
  /** Prefix before the event, e.g. `hello-fruit:node-express:server`. */
  readonly prefix: string;
  readonly console?: Pick<Console, "log">;
}

/** Ad-hoc `(event, message, fields?)` console logger for host app routes. */
export function createHostConsoleLogger(
  options: CreateHostConsoleLoggerOptions,
): HostConsoleLogger {
  const target = options.console ?? console;
  return (event, message, fields = {}) => {
    target.log(`[${options.prefix}] ${event}: ${message}`, {
      at: new Date().toISOString(),
      ...stripUndefinedLogFields(fields),
    });
  };
}

function stripUndefinedLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      clean[key] = value.map((entry) =>
        isPlainLogRecord(entry) ? stripUndefinedLogFields(entry as Record<string, unknown>) : entry,
      );
      continue;
    }
    clean[key] = isPlainLogRecord(value)
      ? stripUndefinedLogFields(value as Record<string, unknown>)
      : value;
  }
  return clean;
}

function isPlainLogRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
