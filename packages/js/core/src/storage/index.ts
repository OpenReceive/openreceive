import type {
  OpenReceiveTransactionState,
  OpenReceiveWorkflowState
} from "../nwc/client.ts";

export type MaybePromise<T> = T | Promise<T>;

export type OpenReceiveIdempotencyOperation =
  | "invoice.create"
  | "invoice.renew";

export type OpenReceiveSettlementActionState =
  | "pending"
  | "completed"
  | "failed";

const TRANSACTION_STATES = new Set<string>([
  "pending",
  "settled",
  "expired",
  "failed",
  "accepted"
]);
const WORKFLOW_STATES = new Set<string>([
  "draft",
  "invoice_created",
  "verifying",
  "settlement_action_pending",
  "settlement_action_completed",
  "expiry_pending_verification",
  "expired_closed",
  "failed_closed",
  "cancelled"
]);
const SETTLEMENT_ACTION_STATES = new Set<string>([
  "pending",
  "completed",
  "failed"
]);

export interface OpenReceiveIdempotencyScope {
  namespace: string;
  operation: OpenReceiveIdempotencyOperation;
  idempotency_key: string;
}

export interface InvoiceStorageRow extends OpenReceiveIdempotencyScope {
  invoice_id: string;
  idempotency_request_hash: string;
  payment_hash: string;
  invoice: string;
  amount_msats: number;
  transaction_state: OpenReceiveTransactionState;
  workflow_state: OpenReceiveWorkflowState;
  settlement_action_state: OpenReceiveSettlementActionState;
  created_at: number;
  expires_at: number;
  settled_at?: number;
  settlement_action_completed_at?: number;
  refreshed_from_invoice_id?: string;
  metadata: Record<string, unknown>;
  fiat_quote?: Record<string, unknown> | null;
  last_transaction_scan_at?: number;
  action_claimed_at?: number;
}

export class IdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = "CONFLICT";
  readonly scope: OpenReceiveIdempotencyScope;

  constructor(scope: OpenReceiveIdempotencyScope) {
    super("Idempotency key was reused with a different request body.");
    this.name = "IdempotencyConflictError";
    this.scope = scope;
  }
}

export class InvoiceStorageConflictError extends Error {
  readonly status = 409;
  readonly code = "CONFLICT";
  readonly on?: "invoice_id" | "idempotency_scope" | "payment_hash" | "bolt11";

  constructor(
    message: string,
    on?: "invoice_id" | "idempotency_scope" | "payment_hash" | "bolt11"
  ) {
    super(message);
    this.name = "InvoiceStorageConflictError";
    this.on = on;
  }
}

export class InvoiceNotFoundError extends Error {
  readonly status = 404;
  readonly code = "NOT_FOUND";

  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

export function idempotencyScopeKey(
  scope: OpenReceiveIdempotencyScope
): string {
  assertNonEmptyString(scope.namespace, "namespace");
  assertNonEmptyString(scope.operation, "operation");
  assertNonEmptyString(scope.idempotency_key, "idempotency_key");

  return [
    encodeScopeSegment(scope.namespace),
    encodeScopeSegment(scope.operation),
    encodeScopeSegment(scope.idempotency_key)
  ].join(":");
}

export async function createIdempotencyRequestHash(
  request: unknown
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(request));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export function canonicalJson(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError("canonicalJson accepts JSON-compatible values only");
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  );

  return `{${entries.join(",")}}`;
}

export function validateInvoiceStorageRow(row: InvoiceStorageRow): void {
  assertNonEmptyString(row.invoice_id, "invoice_id");
  assertNonEmptyString(row.payment_hash, "payment_hash");
  assertNonEmptyString(row.invoice, "invoice");
  assertNonEmptyString(row.idempotency_request_hash, "idempotency_request_hash");
  assertNonEmptyString(row.idempotency_key, "idempotency_key");
  assertNonEmptyString(row.namespace, "namespace");
  assertNonEmptyString(row.operation, "operation");
  assertSetMember(row.transaction_state, TRANSACTION_STATES, "transaction_state");
  assertSetMember(row.workflow_state, WORKFLOW_STATES, "workflow_state");
  assertSetMember(row.settlement_action_state, SETTLEMENT_ACTION_STATES, "settlement_action_state");
  assertUnixSeconds(row.created_at, "created_at");
  assertUnixSeconds(row.expires_at, "expires_at");

  if (row.expires_at < row.created_at) {
    throw new RangeError("expires_at must be greater than or equal to created_at");
  }

  if (
    !Number.isSafeInteger(row.amount_msats) ||
    row.amount_msats < 1000 ||
    row.amount_msats > 9007199254740991
  ) {
    throw new RangeError("amount_msats must be within v0.1 safe integer bounds");
  }

  if (!row.idempotency_request_hash.match(/^sha256:[0-9a-f]{64}$/)) {
    throw new RangeError("idempotency_request_hash must be sha256:<64 hex>");
  }

  if (row.settled_at !== undefined) {
    assertUnixSeconds(row.settled_at, "settled_at");
  }

  if (row.settlement_action_completed_at !== undefined) {
    assertUnixSeconds(row.settlement_action_completed_at, "settlement_action_completed_at");
  }

  if (row.last_transaction_scan_at !== undefined) {
    assertUnixSeconds(row.last_transaction_scan_at, "last_transaction_scan_at");
  }

  if (row.action_claimed_at !== undefined) {
    assertUnixSeconds(row.action_claimed_at, "action_claimed_at");
  }
}

export function cloneInvoiceStorageRow(row: InvoiceStorageRow): InvoiceStorageRow {
  return {
    ...row,
    metadata: cloneRecord(row.metadata),
    fiat_quote: row.fiat_quote === undefined ? undefined : cloneNullableRecord(row.fiat_quote)
  };
}

export function isTerminalInvoiceStorageRow(row: InvoiceStorageRow): boolean {
  return (
    row.workflow_state === "settlement_action_completed" ||
    row.workflow_state === "expired_closed" ||
    row.workflow_state === "failed_closed" ||
    row.workflow_state === "cancelled"
  );
}

export function readInvoiceStorageOrderId(row: InvoiceStorageRow): string {
  const orderId = row.metadata.order_uuid;
  if (typeof orderId === "string" && orderId.length > 0) return orderId;
  throw new TypeError("metadata.order_uuid must be a non-empty string");
}

export function readInvoiceStorageCheckoutId(row: InvoiceStorageRow): string {
  const checkoutId = row.metadata.checkout_id;
  if (typeof checkoutId === "string" && checkoutId.length > 0) return checkoutId;
  throw new TypeError("metadata.checkout_id must be a non-empty string");
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(record);
}

function cloneNullableRecord(
  record: Record<string, unknown> | null
): Record<string, unknown> | null {
  return record === null ? null : structuredClone(record);
}

function encodeScopeSegment(value: string): string {
  return encodeURIComponent(value);
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
}

function assertUnixSeconds(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertSetMember(
  value: string,
  allowed: Set<string>,
  fieldName: string
): void {
  if (!allowed.has(value)) {
    throw new TypeError(`${fieldName} is not a valid OpenReceive state`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
