import {
  InvoiceStorageConflictError,
  cloneInvoiceStorageRow,
  idempotencyScopeKey,
  isTerminalInvoiceStorageRow,
  readInvoiceStorageCheckoutId,
  readInvoiceStorageOrderId,
  validateInvoiceStorageRow
} from "./index.ts";
import {
  cloneStoredRecord,
  validateStoredRecord,
  type MetaRow,
  type OpenReceiveKvConflictKey,
  type OpenReceiveInvoiceKvStore,
  type OpenReceivePutIfAbsentResult,
  type StoredRecord
} from "./kv.ts";

export class InMemoryInvoiceKvStore implements OpenReceiveInvoiceKvStore {
  #byInvoiceId = new Map<string, StoredRecord>();
  #byPaymentHash = new Map<string, string>();
  #byBolt11Invoice = new Map<string, string>();
  #byIdempotencyScope = new Map<string, string>();
  #byOrderId = new Map<string, Set<string>>();
  #byCheckoutId = new Map<string, Set<string>>();
  #meta = new Map<string, MetaRow>();

  putIfAbsent(record: StoredRecord): OpenReceivePutIfAbsentResult {
    validateStoredRecord(record);
    if (record.rev !== 0) {
      throw new TypeError("putIfAbsent requires rev 0");
    }

    const scopeKey = idempotencyScopeKey(record.row);
    const idempotencyInvoiceId = this.#byIdempotencyScope.get(scopeKey);
    if (idempotencyInvoiceId !== undefined) {
      return this.#conflict("idempotency_scope", idempotencyInvoiceId);
    }

    if (this.#byInvoiceId.has(record.row.invoice_id)) {
      return this.#conflict("invoice_id", record.row.invoice_id);
    }

    const paymentHashInvoiceId = this.#byPaymentHash.get(record.row.payment_hash);
    if (paymentHashInvoiceId !== undefined) {
      return this.#conflict("payment_hash", paymentHashInvoiceId);
    }

    const bolt11InvoiceId = this.#byBolt11Invoice.get(record.row.invoice);
    if (bolt11InvoiceId !== undefined) {
      return this.#conflict("bolt11", bolt11InvoiceId);
    }

    const stored = cloneStoredRecord(record);
    this.#byInvoiceId.set(stored.row.invoice_id, stored);
    this.#byPaymentHash.set(stored.row.payment_hash, stored.row.invoice_id);
    this.#byBolt11Invoice.set(stored.row.invoice, stored.row.invoice_id);
    this.#byIdempotencyScope.set(scopeKey, stored.row.invoice_id);
    this.#addOrderIndex(stored.row);
    this.#addCheckoutIndex(stored.row);

    return {
      status: "created",
      record: cloneStoredRecord(stored)
    };
  }

  put(
    record: StoredRecord,
    expectedRev: number
  ): { status: "ok" | "conflict"; record: StoredRecord } {
    validateStoredRecord(record);
    const current = this.#byInvoiceId.get(record.row.invoice_id);
    if (current === undefined) {
      throw new InvoiceStorageConflictError(
        "invoice_id does not exist",
        "invoice_id"
      );
    }
    if (current.rev !== expectedRev) {
      return {
        status: "conflict",
        record: cloneStoredRecord(current)
      };
    }
    if (record.rev !== expectedRev + 1) {
      throw new TypeError("put requires record.rev to equal expectedRev + 1");
    }

    this.#removeIndexes(current.row);
    this.#assertReplacementIndexesAvailable(record.row, current.row.invoice_id);
    const stored = cloneStoredRecord(record);
    this.#byInvoiceId.set(stored.row.invoice_id, stored);
    this.#byPaymentHash.set(stored.row.payment_hash, stored.row.invoice_id);
    this.#byBolt11Invoice.set(stored.row.invoice, stored.row.invoice_id);
    this.#byIdempotencyScope.set(idempotencyScopeKey(stored.row), stored.row.invoice_id);
    this.#addOrderIndex(stored.row);
    this.#addCheckoutIndex(stored.row);

    return {
      status: "ok",
      record: cloneStoredRecord(stored)
    };
  }

  get(invoiceId: string): StoredRecord | undefined {
    return this.#cloneByInvoiceId(invoiceId);
  }

  getByPaymentHash(paymentHash: string): StoredRecord | undefined {
    const invoiceId = this.#byPaymentHash.get(paymentHash);
    return invoiceId === undefined ? undefined : this.#cloneByInvoiceId(invoiceId);
  }

  getByBolt11Invoice(invoice: string): StoredRecord | undefined {
    const invoiceId = this.#byBolt11Invoice.get(invoice);
    return invoiceId === undefined ? undefined : this.#cloneByInvoiceId(invoiceId);
  }

  getByIdempotencyScope(scopeKey: string): StoredRecord | undefined {
    const invoiceId = this.#byIdempotencyScope.get(scopeKey);
    return invoiceId === undefined ? undefined : this.#cloneByInvoiceId(invoiceId);
  }

  listByOrderId(orderId: string): StoredRecord[] {
    assertOrderId(orderId);
    const invoiceIds = this.#byOrderId.get(orderId);
    return this.#listByInvoiceIdSet(invoiceIds);
  }

  listByCheckoutId(checkoutId: string): StoredRecord[] {
    assertCheckoutId(checkoutId);
    const invoiceIds = this.#byCheckoutId.get(checkoutId);
    return this.#listByInvoiceIdSet(invoiceIds);
  }

  #listByInvoiceIdSet(invoiceIds: Set<string> | undefined): StoredRecord[] {
    if (invoiceIds === undefined) return [];
    return [...invoiceIds]
      .map((invoiceId) => this.#byInvoiceId.get(invoiceId))
      .filter((record): record is StoredRecord => record !== undefined)
      .sort((left, right) =>
        left.row.created_at === right.row.created_at
          ? right.row.invoice_id.localeCompare(left.row.invoice_id)
          : right.row.created_at - left.row.created_at
      )
      .map((record) => cloneStoredRecord(record));
  }

  listOpen(input: { now: number; limit: number }): StoredRecord[] {
    assertListOpenInput(input);
    return [...this.#byInvoiceId.values()]
      .filter((record) => !isTerminalInvoiceStorageRow(record.row))
      .sort((left, right) =>
        left.row.created_at === right.row.created_at
          ? left.row.invoice_id.localeCompare(right.row.invoice_id)
          : left.row.created_at - right.row.created_at
      )
      .slice(0, input.limit)
      .map((record) => cloneStoredRecord(record));
  }

  getMeta(key: string): MetaRow | undefined {
    const row = this.#meta.get(key);
    return row === undefined ? undefined : { ...row };
  }

  casMeta(
    key: string,
    value: string,
    expectedRev: number | null
  ): { status: "ok" | "conflict"; row: MetaRow } {
    assertMetaKey(key);
    const current = this.#meta.get(key);
    if (expectedRev === null) {
      if (current !== undefined) {
        return {
          status: "conflict",
          row: { ...current }
        };
      }
      const row = { value, rev: 0 };
      this.#meta.set(key, row);
      return {
        status: "ok",
        row: { ...row }
      };
    }

    if (current === undefined || current.rev !== expectedRev) {
      return {
        status: "conflict",
        row: current === undefined ? { value: "", rev: -1 } : { ...current }
      };
    }

    const row = { value, rev: expectedRev + 1 };
    this.#meta.set(key, row);
    return {
      status: "ok",
      row: { ...row }
    };
  }

  #cloneByInvoiceId(invoiceId: string): StoredRecord | undefined {
    const record = this.#byInvoiceId.get(invoiceId);
    return record === undefined ? undefined : cloneStoredRecord(record);
  }

  #conflict(
    on: OpenReceiveKvConflictKey,
    invoiceId: string
  ): OpenReceivePutIfAbsentResult {
    const existing = this.#byInvoiceId.get(invoiceId);
    if (existing === undefined) {
      throw new Error("OpenReceive in-memory store secondary index is stale");
    }
    return {
      status: "conflict",
      on,
      existing: cloneStoredRecord(existing)
    };
  }

  #removeIndexes(row: StoredRecord["row"]): void {
    this.#byPaymentHash.delete(row.payment_hash);
    this.#byBolt11Invoice.delete(row.invoice);
    this.#byIdempotencyScope.delete(idempotencyScopeKey(row));
    const orderId = readInvoiceStorageOrderId(row);
    const invoiceIds = this.#byOrderId.get(orderId);
    if (invoiceIds !== undefined) {
      invoiceIds.delete(row.invoice_id);
    }
    if (invoiceIds?.size === 0) {
      this.#byOrderId.delete(orderId);
    }
    const checkoutId = readInvoiceStorageCheckoutId(row);
    const checkoutInvoiceIds = this.#byCheckoutId.get(checkoutId);
    if (checkoutInvoiceIds !== undefined) {
      checkoutInvoiceIds.delete(row.invoice_id);
    }
    if (checkoutInvoiceIds?.size === 0) {
      this.#byCheckoutId.delete(checkoutId);
    }
  }

  #assertReplacementIndexesAvailable(row: StoredRecord["row"], invoiceId: string): void {
    validateInvoiceStorageRow(cloneInvoiceStorageRow(row));
    const paymentHashOwner = this.#byPaymentHash.get(row.payment_hash);
    if (paymentHashOwner !== undefined && paymentHashOwner !== invoiceId) {
      throw new InvoiceStorageConflictError(
        "payment_hash must be unique",
        "payment_hash"
      );
    }
    const bolt11Owner = this.#byBolt11Invoice.get(row.invoice);
    if (bolt11Owner !== undefined && bolt11Owner !== invoiceId) {
      throw new InvoiceStorageConflictError("invoice must be unique", "bolt11");
    }
    const scopeOwner = this.#byIdempotencyScope.get(idempotencyScopeKey(row));
    if (scopeOwner !== undefined && scopeOwner !== invoiceId) {
      throw new InvoiceStorageConflictError(
        "idempotency scope must be unique",
        "idempotency_scope"
      );
    }
  }

  #addOrderIndex(row: StoredRecord["row"]): void {
    const orderId = readInvoiceStorageOrderId(row);
    const invoiceIds = this.#byOrderId.get(orderId) ?? new Set<string>();
    invoiceIds.add(row.invoice_id);
    this.#byOrderId.set(orderId, invoiceIds);
  }

  #addCheckoutIndex(row: StoredRecord["row"]): void {
    const checkoutId = readInvoiceStorageCheckoutId(row);
    const invoiceIds = this.#byCheckoutId.get(checkoutId) ?? new Set<string>();
    invoiceIds.add(row.invoice_id);
    this.#byCheckoutId.set(checkoutId, invoiceIds);
  }
}

function assertListOpenInput(input: { now: number; limit: number }): void {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("listOpen now must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("listOpen limit must be a positive safe integer");
  }
}

function assertMetaKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("meta key must be a non-empty string");
  }
}

function assertOrderId(orderId: string): void {
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new TypeError("orderId must be a non-empty string");
  }
}

function assertCheckoutId(checkoutId: string): void {
  if (typeof checkoutId !== "string" || checkoutId.length === 0) {
    throw new TypeError("checkoutId must be a non-empty string");
  }
}
