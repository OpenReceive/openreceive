import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import type {
  CreateOpenReceiveOptions,
  OpenReceiveLogEntry,
  OpenReceiveLogLevel,
  OpenReceiveLogger,
  OpenReceiveLoggingOptions,
} from "./types.ts";

const LOG_LEVEL_ORDER: Record<OpenReceiveLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Default rotating-file logging configuration. Mirrored in `openreceive.yml.example`
 * under the `logging:` block. Writes every emitted event (down to `debug`) as a
 * timestamped JSON line to `./logs/openreceive.log`, keeping 5 files of up to 10 MB.
 */
export const OPENRECEIVE_LOGGING_DEFAULTS = {
  enabled: true,
  directory: "./logs",
  filename: "openreceive.log",
  maxFileSizeMb: 10,
  maxFiles: 5,
  level: "debug" as OpenReceiveLogLevel,
} as const;

interface ResolvedFileLoggerConfig {
  readonly directory: string;
  readonly filename: string;
  readonly maxFileSizeBytes: number;
  readonly maxFiles: number;
  readonly minLevel: OpenReceiveLogLevel;
}

function normalizeLogLevel(value: string | undefined): OpenReceiveLogLevel | undefined {
  if (value === undefined) return undefined;
  return value in LOG_LEVEL_ORDER ? (value as OpenReceiveLogLevel) : undefined;
}

/**
 * Build a logger that appends each entry as a single timestamped JSON line to a log
 * file, rotating by size. Entries arrive already sanitized (secrets redacted) from
 * `emitOpenReceiveEvent`, so no further redaction happens here. Every filesystem
 * interaction is wrapped so logging can never throw into payment/settlement code.
 */
export function createOpenReceiveFileLogger(config: ResolvedFileLoggerConfig): OpenReceiveLogger {
  const logPath = path.join(config.directory, config.filename);
  let initialized = false;
  let currentBytes = 0;

  const ensureReady = () => {
    if (initialized) return;
    initialized = true;
    mkdirSync(config.directory, { recursive: true });
    currentBytes = existsSync(logPath) ? statSync(logPath).size : 0;
  };

  // Size-based rotation with numbered backups: openreceive.log -> .1 -> .2 ...,
  // keeping `maxFiles` files total (the active file plus `maxFiles - 1` archives).
  const rotate = () => {
    if (config.maxFiles <= 1) {
      // No archives retained: drop the full file and start fresh.
      if (existsSync(logPath)) unlinkSync(logPath);
      currentBytes = 0;
      return;
    }
    const oldest = `${logPath}.${config.maxFiles - 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = config.maxFiles - 2; index >= 1; index--) {
      const from = `${logPath}.${index}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${index + 1}`);
    }
    if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
    currentBytes = 0;
  };

  return (entry: OpenReceiveLogEntry) => {
    const level = LOG_LEVEL_ORDER[entry.level] ?? LOG_LEVEL_ORDER.info;
    if (level < LOG_LEVEL_ORDER[config.minLevel]) return;
    try {
      ensureReady();
      const { level: entryLevel, event, message, ...rest } = entry;
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: entryLevel,
        event,
        message,
        ...rest,
      })}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (currentBytes > 0 && currentBytes + lineBytes > config.maxFileSizeBytes) rotate();
      appendFileSync(logPath, line);
      currentBytes += lineBytes;
    } catch {
      // Diagnostics must never change payment, settlement, or settlement-action behavior.
    }
  };
}

/**
 * Resolve a `logging:` config block (with defaults) into a file logger, or `undefined`
 * when file logging is explicitly disabled (`enabled: false`).
 */
export function createOpenReceiveFileLoggerFromConfig(
  config: OpenReceiveLoggingOptions | undefined,
): OpenReceiveLogger | undefined {
  if (config?.enabled === false) return undefined;
  const defaults = OPENRECEIVE_LOGGING_DEFAULTS;
  const maxFileSizeMb = config?.maxFileSizeMb ?? defaults.maxFileSizeMb;
  const maxFiles = config?.maxFiles ?? defaults.maxFiles;
  return createOpenReceiveFileLogger({
    directory: config?.directory ?? defaults.directory,
    filename: config?.filename ?? defaults.filename,
    maxFileSizeBytes: Math.max(1024, Math.round(maxFileSizeMb * 1024 * 1024)),
    maxFiles: Math.max(1, Math.floor(maxFiles)),
    minLevel: normalizeLogLevel(config?.level) ?? defaults.level,
  });
}

/**
 * Combine multiple loggers into one so that a caller-supplied logger and the built-in
 * file logger both receive every entry. Each sink is isolated: one throwing never stops
 * the others.
 */
export function composeOpenReceiveLoggers(
  ...loggers: readonly (OpenReceiveLogger | undefined)[]
): OpenReceiveLogger | undefined {
  const active = loggers.filter((logger): logger is OpenReceiveLogger => logger !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return (entry) => {
    for (const logger of active) {
      try {
        logger(entry);
      } catch {
        // A failing sink must not prevent the others from recording the entry.
      }
    }
  };
}

/**
 * Attach the rotating file logger (unless disabled) to the resolved options so every
 * downstream sink — the NWC endpoint bridge and all service events — writes to the log
 * files in addition to any caller-supplied logger.
 */
export function attachOpenReceiveFileLogging(
  options: CreateOpenReceiveOptions,
): CreateOpenReceiveOptions {
  const fileLogger = createOpenReceiveFileLoggerFromConfig(options.logging);
  if (fileLogger === undefined) return options;
  const logger = composeOpenReceiveLoggers(options.logger, fileLogger);
  return logger === undefined ? options : { ...options, logger };
}
