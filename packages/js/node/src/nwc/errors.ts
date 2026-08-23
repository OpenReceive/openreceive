/**
 * NWC failure normalization: the wallet-error alias table and the walk that
 * turns any client's thrown shape into a canonical `OpenReceiveError`.
 * Pure functions over already-thrown values — no transport, no wallet calls.
 */

import {
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  OpenReceiveError,
  type OpenReceiveErrorBody,
  type OpenReceiveErrorCode,
  type WalletCapabilitySummary,
} from "@openreceive/core";

export type WalletPreflightErrorCode =
  | "missing_required_method"
  | "spend_capability_advertised"
  | "unsupported_encryption"
  | "wallet_unavailable";

export class WalletPreflightError extends Error {
  readonly code: WalletPreflightErrorCode;
  readonly summary?: WalletCapabilitySummary;

  constructor(code: WalletPreflightErrorCode, message: string, summary?: WalletCapabilitySummary) {
    super(message);
    this.name = "WalletPreflightError";
    this.code = code;
    this.summary = summary;
  }
}

export class ReceiveCheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiveCheckoutValidationError";
  }
}

const NWC_ERROR_CODE_ALIASES: Readonly<Record<string, OpenReceiveErrorCode>> = {
  ABORT_ERROR: "TIMEOUT",
  BAD_REQUEST: "INVALID_REQUEST",
  CONNECTION_ERROR: "WALLET_UNAVAILABLE",
  EXPIRED: "INVOICE_EXPIRED",
  FETCH_ERROR: "WALLET_UNAVAILABLE",
  FORBIDDEN: "RESTRICTED",
  INVOICE_NOT_FOUND: "NOT_FOUND",
  INVALID_PARAMETER: "INVALID_REQUEST",
  INVALID_PARAMETERS: "INVALID_REQUEST",
  INVALID_PARAMS: "INVALID_REQUEST",
  METHOD_NOT_FOUND: "UNSUPPORTED_METHOD",
  NETWORK_ERROR: "WALLET_UNAVAILABLE",
  NIP47_NETWORK_ERROR: "WALLET_UNAVAILABLE",
  NOSTR_NETWORK_ERROR: "WALLET_UNAVAILABLE",
  NOT_AUTHORIZED: "UNAUTHORIZED",
  NOT_SUPPORTED: "UNSUPPORTED_METHOD",
  NOTFOUND: "NOT_FOUND",
  PERMISSION_DENIED: "RESTRICTED",
  RELAY_CONNECTION_ERROR: "WALLET_UNAVAILABLE",
  REQUEST_TIMEOUT: "TIMEOUT",
  SERVICE_UNAVAILABLE: "WALLET_UNAVAILABLE",
  TIMED_OUT: "TIMEOUT",
  TIMEOUT_ERROR: "TIMEOUT",
  UNKNOWN_METHOD: "UNSUPPORTED_METHOD",
  UNSUPPORTED: "UNSUPPORTED_METHOD",
  UNSUPPORTED_ENCRYPTION_MODE: "UNSUPPORTED_ENCRYPTION",
  WALLET_OFFLINE: "WALLET_UNAVAILABLE",
  WALLET_UNREACHABLE: "WALLET_UNAVAILABLE",
};

const OPENRECEIVE_ERROR_MESSAGES = {
  NOT_IMPLEMENTED: "NWC wallet service does not implement this method.",
  RESTRICTED: "NWC wallet service restricted this request.",
  UNAUTHORIZED: "NWC wallet service rejected authorization.",
  FORBIDDEN: "The host application did not authorize this request.",
  RATE_LIMITED: "NWC wallet service rate limited this request.",
  QUOTA_EXCEEDED: "NWC wallet service quota was exceeded.",
  INTERNAL: "NWC wallet service returned an internal error.",
  UNSUPPORTED_ENCRYPTION: "NWC wallet service does not support the required encryption mode.",
  OTHER: "NWC wallet service returned an unknown error.",
  NOT_FOUND: "NWC wallet service could not find the requested resource.",
  TIMEOUT: "NWC wallet service request timed out.",
  INVALID_REQUEST: "OpenReceive sent an invalid NWC wallet request.",
  WALLET_UNAVAILABLE: "NWC wallet service is unavailable.",
  INVOICE_EXPIRED: "NWC wallet reported that the invoice is expired.",
  UNSUPPORTED_METHOD: "NWC wallet service does not support the requested method.",
  CONFLICT: "NWC wallet service reported a conflicting request.",
} satisfies Record<OpenReceiveErrorCode, string>;

export function normalizeNwcWalletError(error: unknown): OpenReceiveError {
  if (error instanceof OpenReceiveError) return error;

  const records = collectErrorRecords(error);
  const code =
    knownOpenReceiveErrorCode(error) ??
    errorCodeFromRecords(records) ??
    (typeof error === "string" ? normalizeNwcErrorCode(error) : undefined) ??
    "OTHER";
  const message = errorMessageFromRecords(records, error, code);
  const retryable =
    firstBooleanField(records, ["retryable"]) ?? isRetryableOpenReceiveErrorCode(code);
  const requestId = firstStringField(records, ["request_id", "requestId"]);
  const details = firstRecordField(records, ["details"]);
  const body: OpenReceiveErrorBody = {
    code,
    message,
    retryable,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(details === undefined ? {} : { details }),
  };

  return new OpenReceiveError(body, { cause: error });
}

function knownOpenReceiveErrorCode(error: unknown): OpenReceiveErrorCode | undefined {
  if (error instanceof ReceiveCheckoutValidationError) {
    return "INVALID_REQUEST";
  }

  if (error instanceof WalletPreflightError) {
    if (error.code === "missing_required_method") return "UNSUPPORTED_METHOD";
    if (error.code === "spend_capability_advertised") return "RESTRICTED";
    if (error.code === "unsupported_encryption") return "UNSUPPORTED_ENCRYPTION";
    return "WALLET_UNAVAILABLE";
  }

  return undefined;
}

function errorCodeFromRecords(
  records: readonly Record<string, unknown>[],
): OpenReceiveErrorCode | undefined {
  for (const record of records) {
    const directCode =
      normalizeNwcErrorCode(record.code) ??
      normalizeNwcErrorCode(record.error_code) ??
      normalizeNwcErrorCode(record.errorCode) ??
      normalizeNwcErrorCode(record.type);
    if (directCode !== undefined && directCode !== "OTHER") return directCode;

    const nameCode = normalizeNwcErrorCode(record.name);
    if (nameCode !== undefined && nameCode !== "OTHER") return nameCode;
    if (directCode !== undefined) return directCode;
  }

  return undefined;
}

function normalizeNwcErrorCode(value: unknown): OpenReceiveErrorCode | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;

  const normalized = normalizeNwcErrorCodeText(value);
  // Aliases first: a wallet's own "FORBIDDEN" is a wallet restriction
  // (RESTRICTED), never the host application's FORBIDDEN.
  return (
    NWC_ERROR_CODE_ALIASES[normalized] ??
    (isOpenReceiveErrorCode(normalized) ? normalized : undefined)
  );
}

function normalizeNwcErrorCodeText(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function errorMessageFromRecords(
  records: readonly Record<string, unknown>[],
  error: unknown,
  code: OpenReceiveErrorCode,
): string {
  const message = firstStringField(records, ["message", "description", "reason"]);
  if (message !== undefined && normalizeNwcErrorCode(message) !== code) {
    return message;
  }

  if (typeof error === "string" && normalizeNwcErrorCode(error) === undefined) {
    const trimmed = error.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return OPENRECEIVE_ERROR_MESSAGES[code];
}

function collectErrorRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  collectErrorRecordsInto(value, records, new Set<object>());
  return records;
}

function collectErrorRecordsInto(
  value: unknown,
  records: Record<string, unknown>[],
  seen: Set<object>,
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;

  seen.add(value);
  const record = value as Record<string, unknown>;
  records.push(record);

  for (const key of ["error", "result", "cause", "data"]) {
    collectErrorRecordsInto(record[key], records, seen);
  }
}

function firstStringField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): string | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }

  return undefined;
}

function firstBooleanField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): boolean | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "boolean") return value;
    }
  }

  return undefined;
}

function firstRecordField(
  records: readonly Record<string, unknown>[],
  fields: readonly string[],
): Record<string, unknown> | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }

  return undefined;
}
