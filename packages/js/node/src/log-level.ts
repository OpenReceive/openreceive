import type { LogLevel } from "./service/types.ts";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
};

/** Compare OpenReceive log levels (`debug` < `info` < `warn` < `error`). */
export function logLevelOrder(level: LogLevel): number {
  return LOG_LEVEL_ORDER[level];
}

/**
 * Parse `LOG_LEVEL` values such as `DEBUG`, `info`, or `Warning`.
 * Returns `undefined` when the value is missing or unrecognized.
 */
export function parseLogLevel(value: string | undefined | null): LogLevel | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return LOG_LEVEL_ALIASES[normalized];
}

/** Resolve a log level string, falling back to `info` when unset/invalid. */
export function resolveLogLevel(value?: string | null, fallback: LogLevel = "info"): LogLevel {
  return parseLogLevel(value) ?? fallback;
}

/**
 * Read `LOG_LEVEL` from an environment map (default `process.env`).
 * Accepts `DEBUG` | `INFO` | `WARN` | `ERROR` (case-insensitive). Default `info`.
 */
export function readLogLevelFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LogLevel {
  return resolveLogLevel(env.LOG_LEVEL);
}
