// Readers for untrusted checkout payloads — the server response, a prepare
// body, a status poll. Each returns a value or a domain error; none of them
// trusts the shape it was handed.

import { nonEmptyString } from "@openreceive/core";
import type { CheckoutInvoiceSnapshot } from "./ui.ts";

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenReceive metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

export function requiredInvoiceRail(value: unknown): CheckoutInvoiceSnapshot["rail"] {
  if (value === "lightning" || value === "swap" || value === "checkout_lock") return value;
  throw new TypeError("OpenReceive invoice rail must be lightning, swap, or checkout_lock.");
}

/**
 * ARRAY-PERMITTING on purpose: this is the untrusted checkout-response reader,
 * and an array reaching it must fall through to the per-field readers (which
 * then find nothing) rather than being replaced by `{}`. Core's
 * `recordOrEmpty` excludes arrays, so it deliberately does NOT serve this
 * boundary — see the note on `recordOrEmpty` in @openreceive/core.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, fieldName: string): string {
  const text = nonEmptyString(value);
  if (text === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return text;
}

export function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" ? value : undefined;
}

export function requiredSafeInteger(value: unknown, fieldName: string): number {
  const integer = optionalSafeInteger(value);
  if (integer === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return integer;
}
