import type {
  OpenReceiveTransactionState,
  OpenReceiveWorkflowState
} from "../nwc/client.ts";

export type MaybePromise<T> = T | Promise<T>;

export type OpenReceiveIdempotencyOperation =
  | "invoice.create"
  | "invoice.refresh";

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
  settlement_action_state: OpenReceiveSettlementActionState;
  created_at: number;
  expires_at: number;
  settled_at?: number;
  settlement_action_completed_at?: number;
  refreshed_from_invoice_id?: string;
  metadata: Record<string, unknown>;
  fiat_quote?: Record<string, unknown> | null;
}

export interface OpenReceiveRecoverableInvoiceQuery {
  now: number;
  grace_seconds?: number;
}

export interface OpenReceiveInvoiceStore {
  checkIdempotency(input: {
    scope: OpenReceiveIdempotencyScope;
    idempotency_request_hash: string;
  }): MaybePromise<InvoiceCreateStorageResult | undefined>;
  createInvoice(row: InvoiceStorageRow): MaybePromise<InvoiceCreateStorageResult>;
  getInvoice(invoiceId: string): MaybePromise<InvoiceStorageRow | undefined>;
  getInvoiceByPaymentHash(paymentHash: string): MaybePromise<InvoiceStorageRow | undefined>;
  getInvoiceByBolt11Invoice(invoice: string): MaybePromise<InvoiceStorageRow | undefined>;
  listRecoverableInvoices(input: OpenReceiveRecoverableInvoiceQuery): MaybePromise<InvoiceStorageRow[]>;
  markVerifying(invoiceId: string): MaybePromise<InvoiceStorageRow>;
  markExpiryPendingVerification(invoiceId: string): MaybePromise<InvoiceStorageRow>;
  markSettled(input: {
    invoice_id: string;
    settled_at?: number;
  }): MaybePromise<InvoiceStorageRow>;
  markExpiredClosed(invoiceId: string): MaybePromise<InvoiceStorageRow>;
  markFailedClosed(invoiceId: string): MaybePromise<InvoiceStorageRow>;
  markSettlementActionPending(invoiceId: string): MaybePromise<InvoiceStorageRow>;
  markSettlementActionCompleted(input: {
    invoice_id: string;
    settlement_action_completed_at: number;
  }): MaybePromise<InvoiceStorageRow>;
  markSettlementActionFailed(invoiceId: string): MaybePromise<InvoiceStorageRow>;
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

  listRecoverableInvoices(
    input: OpenReceiveRecoverableInvoiceQuery
  ): InvoiceStorageRow[] {
    assertUnixSeconds(input.now, "now");
    const graceSeconds = input.grace_seconds ?? 15;
    if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) {
      throw new TypeError("grace_seconds must be a non-negative safe integer");
    }

    return [...this.#byInvoiceId.values()]
      .filter((row) => isRecoverableInvoice(row))
      .map((row) => cloneInvoiceStorageRow(row));
  }

  markVerifying(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    if (
      row.transaction_state !== "settled" &&
      (row.workflow_state === "invoice_created" ||
        row.workflow_state === "expiry_pending_verification")
    ) {
      row.workflow_state = "verifying";
    }

    return cloneInvoiceStorageRow(row);
  }

  markExpiryPendingVerification(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    if (
      row.transaction_state !== "settled" &&
      row.transaction_state !== "expired" &&
      row.transaction_state !== "failed"
    ) {
      row.workflow_state = "expiry_pending_verification";
    }

    return cloneInvoiceStorageRow(row);
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
      row.workflow_state = "settlement_action_pending";
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

  markSettlementActionPending(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    row.workflow_state = "settlement_action_pending";

    return cloneInvoiceStorageRow(row);
  }

  markSettlementActionCompleted(input: {
    invoice_id: string;
    settlement_action_completed_at: number;
  }): InvoiceStorageRow {
    assertUnixSeconds(input.settlement_action_completed_at, "settlement_action_completed_at");

    const row = this.requireStoredInvoice(input.invoice_id);
    row.workflow_state = "settlement_action_completed";
    row.settlement_action_state = "completed";

    if (row.settlement_action_completed_at === undefined) {
      row.settlement_action_completed_at = input.settlement_action_completed_at;
    }

    return cloneInvoiceStorageRow(row);
  }

  markSettlementActionFailed(invoiceId: string): InvoiceStorageRow {
    const row = this.requireStoredInvoice(invoiceId);

    row.workflow_state = "settlement_action_pending";
    row.settlement_action_state = "failed";

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
}

function isRecoverableInvoice(row: InvoiceStorageRow): boolean {
  if (
    row.workflow_state === "settlement_action_completed" ||
    row.workflow_state === "expired_closed" ||
    row.workflow_state === "failed_closed" ||
    row.workflow_state === "cancelled"
  ) {
    return false;
  }

  if (row.transaction_state === "settled") {
    return row.settlement_action_state !== "completed";
  }

  if (row.transaction_state === "expired" || row.transaction_state === "failed") {
    return false;
  }

  return true;
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
