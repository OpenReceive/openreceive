// Readers that parse our own checkout responses — a create body, a prepare
// body, a status poll — into the typed checkout shape. A required field that
// is missing or mistyped is a bug in our own API, and throws.

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

export function requiredString(value: unknown, fieldName: string): string {
  const text = nonEmptyString(value);
  if (text === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return text;
}

/**
 * An optional integer field from our own server. ABSENT means absent; PRESENT
 * but not a safe integer throws, exactly like the required reader below.
 * Returning undefined for a mistyped value made real fields vanish silently —
 * a dropped `paid_at` hid the settlement timestamp, a dropped
 * `provider_expires_at` kept a stale swap deadline on screen.
 */
export function optionalSafeInteger(value: unknown, fieldName = "integer"): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`OpenReceive checkout response ${fieldName} must be a safe integer.`);
  }
  return value;
}

export function requiredSafeInteger(value: unknown, fieldName: string): number {
  const integer = optionalSafeInteger(value, fieldName);
  if (integer === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return integer;
}
