import type {
  OpenReceiveTransactionState,
  OpenReceiveWorkflowState
} from "../nwc/client.ts";

export type OpenReceiveIdempotencyOperation =
  | "invoice.create"
  | "invoice.refresh";

export type OpenReceiveFulfillmentState =
  | "pending"
  | "ready"
  | "delivered"
  | "delivery_failed";

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
  "awaiting_fulfillment",
  "fulfilled",
  "expiry_pending_verification",
  "expired_closed",
  "failed_closed",
  "cancelled"
]);
const FULFILLMENT_STATES = new Set<string>([
  "pending",
  "ready",
  "delivered",
  "delivery_failed"
]);

export interface OpenReceiveIdempotencyScope {
  merchant_scope: string;
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
  fulfillment_state: OpenReceiveFulfillmentState;
  created_at: number;
  expires_at: number;
  settled_at?: number;
  fulfilled_at?: number;
  refreshed_from_invoice_id?: string;
  metadata: Record<string, unknown>;
  fiat_quote?: Record<string, unknown> | null;
}

export type InvoiceCreateStorageResult =
  | {
      status: "created";
      row: InvoiceStorageRow;
    }
  | {
      status: "replayed";
      row: InvoiceStorageRow;
    };

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

  constructor(message: string) {
    super(message);
    this.name = "InvoiceStorageConflictError";
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

export class InMemoryInvoiceStore {
  #byInvoiceId = new Map<string, InvoiceStorageRow>();
  #byPaymentHash = new Map<string, string>();
  #byBolt11Invoice = new Map<string, string>();
  #byIdempotencyScope = new Map<string, string>();

  checkIdempotency(input: {
    scope: OpenReceiveIdempotencyScope;
    idempotency_request_hash: string;
  }): InvoiceCreateStorageResult | undefined {
    const existingInvoiceId = this.#byIdempotencyScope.get(
      idempotencyScopeKey(input.scope)
    );

    if (existingInvoiceId === undefined) return undefined;

    const existing = this.requireStoredInvoice(existingInvoiceId);
    if (existing.idempotency_request_hash !== input.idempotency_request_hash) {
      throw new IdempotencyConflictError(input.scope);
    }

    return {
      status: "replayed",
      row: cloneInvoiceStorageRow(existing)
    };
  }

  createInvoice(row: InvoiceStorageRow): InvoiceCreateStorageResult {
    validateInvoiceStorageRow(row);

    const scopeKey = idempotencyScopeKey(row);
    const existingInvoiceId = this.#byIdempotencyScope.get(scopeKey);

    if (existingInvoiceId !== undefined) {
      const existing = this.requireStoredInvoice(existingInvoiceId);
      if (existing.idempotency_request_hash !== row.idempotency_request_hash) {
        throw new IdempotencyConflictError(row);
      }

      return {
        status: "replayed",
        row: cloneInvoiceStorageRow(existing)
      };
    }

    if (this.#byInvoiceId.has(row.invoice_id)) {
      throw new InvoiceStorageConflictError("invoice_id must be unique");
    }

    if (this.#byPaymentHash.has(row.payment_hash)) {
      throw new InvoiceStorageConflictError("payment_hash must be unique");
    }

    if (this.#byBolt11Invoice.has(row.invoice)) {
      throw new InvoiceStorageConflictError("invoice must be unique");
    }

    const stored = cloneInvoiceStorageRow(row);
    this.#byInvoiceId.set(stored.invoice_id, stored);
    this.#byPaymentHash.set(stored.payment_hash, stored.invoice_id);
    this.#byBolt11Invoice.set(stored.invoice, stored.invoice_id);
    this.#byIdempotencyScope.set(scopeKey, stored.invoice_id);

    return {
      status: "created",
      row: cloneInvoiceStorageRow(stored)
    };
  }

  getInvoice(invoiceId: string): InvoiceStorageRow | undefined {
    const row = this.#byInvoiceId.get(invoiceId);
    return row === undefined ? undefined : cloneInvoiceStorageRow(row);
  }

  getInvoiceByPaymentHash(paymentHash: string): InvoiceStorageRow | undefined {
    const invoiceId = this.#byPaymentHash.get(paymentHash);
    return invoiceId === undefined ? undefined : this.getInvoice(invoiceId);
  }

  getInvoiceByBolt11Invoice(invoice: string): InvoiceStorageRow | undefined {
    const invoiceId = this.#byBolt11Invoice.get(invoice);
    return invoiceId === undefined ? undefined : this.getInvoice(invoiceId);
  }

  markSettled(input: {
    invoice_id: string;
    settled_at?: number;
  }): InvoiceStorageRow {
    const row = this.requireStoredInvoice(input.invoice_id);

    if (input.settled_at !== undefined) {
      assertUnixSeconds(input.settled_at, "settled_at");
    }

    if (row.transaction_state !== "settled") {
      row.transaction_state = "settled";
      row.workflow_state = "awaiting_fulfillment";
    }

    if (row.settled_at === undefined && input.settled_at !== undefined) {
      row.settled_at = input.settled_at;
    }

    return cloneInvoiceStorageRow(row);
  }

  markExpiredClosed(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    if (row.transaction_state !== "settled") {
      row.transaction_state = "expired";
      row.workflow_state = "expired_closed";
    }

    return cloneInvoiceStorageRow(row);
  }

  markFailedClosed(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    if (row.transaction_state !== "settled") {
      row.transaction_state = "failed";
      row.workflow_state = "failed_closed";
    }

    return cloneInvoiceStorageRow(row);
  }

  markFulfillmentReady(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    if (row.fulfillment_state === "pending") {
      row.fulfillment_state = "ready";
    }

    return cloneInvoiceStorageRow(row);
  }

  markFulfilled(input: {
    invoice_id: string;
    fulfilled_at: number;
  }): InvoiceStorageRow {
    assertUnixSeconds(input.fulfilled_at, "fulfilled_at");

    const row = this.requireStoredInvoice(input.invoice_id);
    row.workflow_state = "fulfilled";
    row.fulfillment_state = "delivered";

    if (row.fulfilled_at === undefined) {
      row.fulfilled_at = input.fulfilled_at;
    }

    return cloneInvoiceStorageRow(row);
  }

  private requireStoredInvoice(invoiceId: string): InvoiceStorageRow {
    const row = this.#byInvoiceId.get(invoiceId);
    if (row === undefined) throw new InvoiceNotFoundError(invoiceId);
    return row;
  }
}

export function idempotencyScopeKey(
  scope: OpenReceiveIdempotencyScope
): string {
  assertNonEmptyString(scope.merchant_scope, "merchant_scope");
  assertNonEmptyString(scope.operation, "operation");
  assertNonEmptyString(scope.idempotency_key, "idempotency_key");

  return [
    encodeScopeSegment(scope.merchant_scope),
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
  assertNonEmptyString(row.merchant_scope, "merchant_scope");
  assertNonEmptyString(row.operation, "operation");
  assertSetMember(row.transaction_state, TRANSACTION_STATES, "transaction_state");
  assertSetMember(row.workflow_state, WORKFLOW_STATES, "workflow_state");
  assertSetMember(row.fulfillment_state, FULFILLMENT_STATES, "fulfillment_state");
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

  if (row.fulfilled_at !== undefined) {
    assertUnixSeconds(row.fulfilled_at, "fulfilled_at");
  }
}

function cloneInvoiceStorageRow(row: InvoiceStorageRow): InvoiceStorageRow {
  return {
    ...row,
    metadata: cloneRecord(row.metadata),
    fiat_quote: row.fiat_quote === undefined ? undefined : cloneNullableRecord(row.fiat_quote)
  };
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
