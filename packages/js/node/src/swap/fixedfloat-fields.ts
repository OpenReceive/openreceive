/**
 * Scalar readers for FixedFloat's loosely typed JSON: strings that may arrive
 * as numbers, optional nested paths, string-or-array fields, unix-seconds
 * timestamps, and plain decimal amounts. Every FixedFloat response reader
 * (orders, currencies, the transport envelope) builds on these.
 */

import { recordOrEmpty } from "@openreceive/core";

export function optionalCoercedString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function optionalStringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  if (record === undefined) return undefined;
  return optionalCoercedString(record[field]);
}

export function optionalNestedString(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = recordOrEmpty(current)[key];
  }
  return optionalCoercedString(current);
}

export function optionalStringArrayField(
  record: Record<string, unknown> | undefined,
  field: string,
): readonly string[] {
  if (record === undefined) return [];
  const value = record[field];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const string = optionalCoercedString(item);
      return string === undefined ? [] : [string];
    });
  }
  const string = optionalCoercedString(value);
  return string === undefined ? [] : [string];
}

export function requiredString(value: unknown, field: string): string {
  const string = optionalCoercedString(value);
  if (string === undefined) {
    throw new Error(`FixedFloat response missing ${field}.`);
  }
  return string;
}

export function readUnixSeconds(value: unknown): number | undefined {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : undefined;
}

/**
 * A provider-reported decimal amount. Absent means absent; present-but-unparsable
 * is a provider contract break and throws rather than silently dropping the
 * amount out of the normalized order.
 */
export function readDecimalAmountString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new Error(`FixedFloat ${label} is not a decimal amount.`);
  }
  return value;
}
