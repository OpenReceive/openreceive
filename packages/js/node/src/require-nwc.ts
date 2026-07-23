import {
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  parseNwcUri,
} from "@openreceive/core";

export interface RequireNwcFromEnvironmentOptions {
  /** Environment object to read. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Subject phrase for the missing-NWC message. Default `"OpenReceive"`. */
  readonly subject?: string;
}

/**
 * Read and validate the receive-only connection string in `NWC_URI`.
 * Throws an `Error` with a host-facing message when missing or invalid.
 */
export function readNwcFromEnvironment(options: RequireNwcFromEnvironmentOptions = {}): string {
  const subject = options.subject ?? "OpenReceive";
  const value = (options.env ?? process.env).NWC_URI?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(formatOpenReceiveMissingNwcMessage({ subject }));
  }

  try {
    parseNwcUri(value);
  } catch (error) {
    const reason = error instanceof NwcUriParseError ? error.description : "Invalid NWC URI.";
    throw new Error(formatOpenReceiveInvalidNwcMessage({ reason }));
  }

  return value;
}

/**
 * CLI/boot gate: require a valid NWC connection string from the environment, otherwise
 * print the error and `process.exit(1)`.
 */
export function requireNwcFromEnvironment(options: RequireNwcFromEnvironmentOptions = {}): string {
  try {
    return readNwcFromEnvironment(options);
  } catch (error) {
    console.error(["", error instanceof Error ? error.message : String(error), ""].join("\n"));
    process.exit(1);
  }
}
