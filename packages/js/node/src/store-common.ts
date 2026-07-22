import {
  canonicalJson,
  validateInvoiceStorageRow,
  type MetaRow,
  type StoredRecord,
} from "@openreceive/core";

// Record/identifier/meta helpers shared by the SQLite and Postgres KV stores so
// serialization, namespacing, and validation stay identical across both backends.

export const DEFAULT_NAMESPACE = "default";
export const DEFAULT_TABLE_NAME = "openreceive_invoices";
export const DEFAULT_META_TABLE_NAME = "openreceive_meta";
export const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateStoredRecord(record: StoredRecord): void {
  if (!Number.isSafeInteger(record.rev) || record.rev < 0) {
    throw new TypeError("OpenReceive store record rev must be a non-negative safe integer");
  }
  validateInvoiceStorageRow(record.row);
}

export function serializeStoredRecord(record: StoredRecord): string {
  return canonicalJson(record);
}

export function parseStoredRecordField(value: unknown): StoredRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError("OpenReceive store data must be a stored record object");
  }
  const record = parsed as StoredRecord;
  validateStoredRecord(record);
  return structuredClone(record);
}

export function normalizeMetaRow(row: Record<string, unknown>): MetaRow {
  return {
    value: stringField(row.value, "value"),
    rev: integerField(row.rev, "rev"),
  };
}

export function quotedIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new TypeError("OpenReceive store identifier must be a simple SQL identifier");
  }
  return `"${identifier}"`;
}

export function unquoted(quoted: string): string {
  return quoted.replace(/^"|"$/g, "");
}

export function namespacedIdentifier(namespace: string, base: string): string {
  return namespace === DEFAULT_NAMESPACE ? base : `${namespace}_${base}`;
}

export function normalizeNamespace(namespace: string): string {
  if (!/^[a-z0-9_]{1,40}$/.test(namespace)) {
    throw new TypeError("`namespace` must match ^[a-z0-9_]{1,40}$");
  }
  return namespace;
}

export function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`OpenReceive store meta ${field} must be a string`);
  }
  return value;
}

export function integerField(value: unknown, field: string): number {
  const parsed: unknown = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`OpenReceive store meta ${field} must be a safe integer`);
  }
  return parsed as number;
}

export function assertListOpenInput(input: { now: number; limit: number }): void {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("OpenReceive store listOpen now must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("OpenReceive store listOpen limit must be a positive safe integer");
  }
}

export function assertOrderId(orderId: string): void {
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new TypeError("OpenReceive store orderId must be a non-empty string");
  }
}

export function assertCheckoutId(checkoutId: string): void {
  if (typeof checkoutId !== "string" || checkoutId.length === 0) {
    throw new TypeError("OpenReceive store checkoutId must be a non-empty string");
  }
}
