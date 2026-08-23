import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { compact } from "@openreceive/core";
import { createConsoleLogger } from "../console-logger.ts";
import { logLevelOrder, parseLogLevel, readLogLevelFromEnvironment } from "../log-level.ts";
import type {
  CreateOpenReceiveOptions,
  LogEvent,
  LogLevel,
  Logger,
  LoggingOptions,
} from "./types.ts";

/**
 * Rotating-file logging configuration. File logging is OFF unless the host asks
 * for it (`logging: { enabled: true }`): a library must not start writing into
 * whatever directory the host process happens to run from. Once enabled it
 * writes emitted events at/above `LOG_LEVEL` (default `info`) as timestamped
 * JSON lines to `./logs/openreceive.log`, keeping 5 files of up to 10 MB.
 * Applications may override these non-secret settings in their normal Node
 * configuration module.
 */
export const OPENRECEIVE_LOGGING_DEFAULTS = {
  enabled: false,
  directory: "./logs",
  filename: "openreceive.log",
  maxFileSizeMb: 10,
  maxFiles: 5,
  level: "info" as LogLevel,
} as const;

interface ResolvedFileLoggerConfig {
  readonly directory: string;
  readonly filename: string;
  readonly maxFileSizeBytes: number;
  readonly maxFiles: number;
  readonly minLevel: LogLevel;
}

/** A file logger plus the handle needed to await its buffered lines reaching disk. */
export interface FileLogger extends Logger {
  /** Resolves once every entry emitted so far has been written. */
  flush(): Promise<void>;
}

/**
 * Build a logger that appends each entry as a single timestamped JSON line to a log
 * file, rotating by size. Writes are buffered and flushed asynchronously so a log
 * line never blocks the event loop on disk; `flush()` awaits the buffer, and a
 * process-exit hook drains it synchronously so the final lines are never lost.
 * Entries arrive already sanitized (secrets redacted) from `emitEvent`,
 * so no further redaction happens here. Every filesystem interaction is wrapped so
 * logging can never throw into payment/settlement code.
 */
export function createFileLogger(config: ResolvedFileLoggerConfig): FileLogger {
  const logPath = path.join(config.directory, config.filename);
  let initialized = false;
  let currentBytes = 0;
  let buffered: string[] = [];
  let draining: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let exitHooked = false;

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

  // Writes the buffer in batches, rotating between batches so one oversized run
  // still respects maxFileSizeBytes. Re-checks the buffer before finishing, so a
  // line emitted mid-write is covered by the flush already in flight.
  const write = async (): Promise<void> => {
    while (buffered.length > 0) {
      const lines = buffered;
      buffered = [];
      try {
        ensureReady();
        let batch = "";
        for (const line of lines) {
          const lineBytes = Buffer.byteLength(line);
          if (currentBytes > 0 && currentBytes + lineBytes > config.maxFileSizeBytes) {
            if (batch.length > 0) await appendFile(logPath, batch);
            batch = "";
            rotate();
          }
          batch += line;
          currentBytes += lineBytes;
        }
        if (batch.length > 0) await appendFile(logPath, batch);
      } catch {
        // Diagnostics must never change payment, settlement, or settlement-action behavior.
      }
    }
  };

  const drain = (): Promise<void> => {
    draining ??= write().finally(() => {
      draining = undefined;
    });
    return draining;
  };

  // Last-gasp drain when the process is already exiting: only synchronous work
  // runs there, so this skips rotation and appends whatever is still buffered.
  const drainSync = () => {
    if (buffered.length === 0) return;
    const lines = buffered;
    buffered = [];
    try {
      ensureReady();
      appendFileSync(logPath, lines.join(""));
    } catch {
      // Diagnostics must never change payment, settlement, or settlement-action behavior.
    }
  };

  const schedule = () => {
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", drainSync);
    }
    if (scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void drain();
    }, 0);
    // Buffered diagnostics must never hold a process open.
    scheduled.unref();
  };

  const logger = (entry: LogEvent) => {
    if (logLevelOrder(entry.level) < logLevelOrder(config.minLevel)) return;
    const { level: entryLevel, event, message, ...rest } = entry;
    buffered.push(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: entryLevel,
        event,
        message,
        ...rest,
      })}\n`,
    );
    schedule();
  };
  logger.flush = async (): Promise<void> => {
    while (buffered.length > 0 || draining !== undefined) {
      await drain();
    }
  };
  return logger;
}

/**
 * Resolve the tracked `logging` options into a file logger, or `undefined` when the
 * host has not opted in (`logging: { enabled: true }`). Writing files is a host
 * decision: the library does not create directories in someone else's process.
 */
export function createFileLoggerFromConfig(
  config: LoggingOptions | undefined,
): FileLogger | undefined {
  if ((config?.enabled ?? OPENRECEIVE_LOGGING_DEFAULTS.enabled) !== true) return undefined;
  const defaults = OPENRECEIVE_LOGGING_DEFAULTS;
  const maxFileSizeMb = config?.maxFileSizeMb ?? defaults.maxFileSizeMb;
  const maxFiles = config?.maxFiles ?? defaults.maxFiles;
  return createFileLogger({
    directory: config?.directory ?? defaults.directory,
    filename: config?.filename ?? defaults.filename,
    maxFileSizeBytes: Math.max(1024, Math.round(maxFileSizeMb * 1024 * 1024)),
    maxFiles: Math.max(1, Math.floor(maxFiles)),
    minLevel: parseLogLevel(config?.level) ?? readLogLevelFromEnvironment(),
  });
}

/**
 * Combine multiple loggers into one so that a caller-supplied logger and the built-in
 * file logger both receive every entry. Each sink is isolated: one throwing never stops
 * the others.
 */
export function composeLoggers(...loggers: readonly (Logger | undefined)[]): Logger | undefined {
  const active = loggers.filter((logger): logger is Logger => logger !== undefined);
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
 * Attach the built-in console logger (and the rotating file logger when the host
 * opted in) to the resolved options so every downstream sink — the NWC endpoint
 * bridge and all service events — records without the host wiring a logger.
 * Console defaults on when no custom `logger` is supplied; file logging is off
 * until `logging.enabled === true`.
 */
export function attachLogging(options: CreateOpenReceiveOptions): CreateOpenReceiveOptions {
  const fileLogger = createFileLoggerFromConfig(options.logging);
  const consoleEnabled = options.logging?.console ?? options.logger === undefined;
  const consoleLogger = consoleEnabled
    ? createConsoleLogger(
        compact({
          prefix: options.logging?.prefix ?? "openreceive",
          minLevel: options.logging?.level,
        }),
      )
    : undefined;
  const logger = composeLoggers(options.logger, consoleLogger, fileLogger);
  return logger === undefined ? options : { ...options, logger };
}
