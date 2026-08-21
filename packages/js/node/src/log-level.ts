import type { OpenReceiveLogLevel } from "./service/types.ts";

const LOG_LEVEL_ORDER: Record<OpenReceiveLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_LEVEL_ALIASES: Record<string, OpenReceiveLogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
};

/** Compare OpenReceive log levels (`debug` < `info` < `warn` < `error`). */
export function openReceiveLogLevelOrder(level: OpenReceiveLogLevel): number {
  return LOG_LEVEL_ORDER[level];
}

/**
 * Parse `LOG_LEVEL` values such as `DEBUG`, `info`, or `Warning`.
 * Returns `undefined` when the value is missing or unrecognized.
 */
export function parseOpenReceiveLogLevel(
  value: string | undefined | null,
): OpenReceiveLogLevel | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return LOG_LEVEL_ALIASES[normalized];
}

/** Resolve a log level string, falling back to `info` when unset/invalid. */
export function resolveOpenReceiveLogLevel(
  value?: string | null,
  fallback: OpenReceiveLogLevel = "info",
): OpenReceiveLogLevel {
  return parseOpenReceiveLogLevel(value) ?? fallback;
}

/**
 * Read `LOG_LEVEL` from an environment map (default `process.env`).
 * Accepts `DEBUG` | `INFO` | `WARN` | `ERROR` (case-insensitive). Default `info`.
 */
export function readOpenReceiveLogLevelFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenReceiveLogLevel {
  return resolveOpenReceiveLogLevel(env.LOG_LEVEL);
}
