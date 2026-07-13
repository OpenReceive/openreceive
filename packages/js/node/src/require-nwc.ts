import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  parseNwcUri,
} from "@openreceive/core";
import {
  readOpenReceiveConfigFile,
  type ReadOpenReceiveConfigFileOptions,
} from "./config.ts";

export interface RequireNwcFromConfigOptions extends ReadOpenReceiveConfigFileOptions {
  /** Subject phrase for the missing-NWC message. Default `"OpenReceive"`. */
  readonly subject?: string;
}

/**
 * Read and validate `nwc` from `openreceive.yml` (or the configured path).
 * Throws an `Error` with a host-facing message when missing or invalid.
 */
export function readNwcFromConfig(options: RequireNwcFromConfigOptions = {}): string {
  const subject = options.subject ?? "OpenReceive";
  const value = readOpenReceiveConfigFile(options)?.nwc?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(formatOpenReceiveMissingNwcMessage({ subject }));
  }

  try {
    parseNwcUri(value);
  } catch (error) {
    const reason =
      error instanceof NwcUriParseError ? error.description : "Invalid NWC URI.";
    throw new Error(formatOpenReceiveInvalidNwcMessage({ reason }));
  }

  return value;
}

/**
 * CLI/boot gate: require a valid NWC connection string from config, otherwise
 * print the error and `process.exit(1)`.
 */
export function requireNwcFromConfig(options: RequireNwcFromConfigOptions = {}): string {
  try {
    return readNwcFromConfig(options);
  } catch (error) {
    console.error(["", error instanceof Error ? error.message : String(error), ""].join("\n"));
    process.exit(1);
  }
}
