import {
  IdempotencyConflictError,
  InvoiceStorageConflictError,
  cloneInvoiceStorageRow,
  idempotencyScopeKey,
  validateInvoiceStorageRow,
  type InvoiceStorageRow,
  type MaybePromise,
  type OpenReceiveIdempotencyScope
} from "./index.ts";

export interface StoredRecord {
  rev: number;
  row: InvoiceStorageRow;
}

export interface MetaRow {
  value: string;
  rev: number;
}

export type OpenReceiveKvConflictKey =
  | "invoice_id"
  | "idempotency_scope"
  | "payment_hash"
  | "bolt11";

export type OpenReceivePutIfAbsentResult =
  | {
      status: "created";
      record: StoredRecord;
    }
  | {
      status: "conflict";
      on: OpenReceiveKvConflictKey;
      existing: StoredRecord;
    };

export interface OpenReceiveInvoiceKvStore {
  putIfAbsent(record: StoredRecord): MaybePromise<OpenReceivePutIfAbsentResult>;
  put(
    record: StoredRecord,
    expectedRev: number
  ): MaybePromise<{ status: "ok" | "conflict"; record: StoredRecord }>;
  get(invoiceId: string): MaybePromise<StoredRecord | undefined>;
  getByPaymentHash(paymentHash: string): MaybePromise<StoredRecord | undefined>;
  getByBolt11Invoice(invoice: string): MaybePromise<StoredRecord | undefined>;
  getByIdempotencyScope(scopeKey: string): MaybePromise<StoredRecord | undefined>;
  listByOrderId(orderId: string): MaybePromise<StoredRecord[]>;
  listByCheckoutId(checkoutId: string): MaybePromise<StoredRecord[]>;
  listOpen(input: { now: number; limit: number }): MaybePromise<StoredRecord[]>;
  getMeta(key: string): MaybePromise<MetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null
  ): MaybePromise<{ status: "ok" | "conflict"; row: MetaRow }>;
}

export interface PutCreatedInvoiceRecordOptions {
  store: OpenReceiveInvoiceKvStore;
  record: StoredRecord;
  createInvoiceId?: () => string;
  maxInvoiceIdRetries?: number;
}

export type PutCreatedInvoiceRecordResult =
  | {
      status: "created";
      record: StoredRecord;
    }
  | {
      status: "replayed";
      record: StoredRecord;
    };

export async function getIdempotentRecord(input: {
  store: OpenReceiveInvoiceKvStore;
  scope: OpenReceiveIdempotencyScope;
  idempotency_request_hash: string;
}): Promise<PutCreatedInvoiceRecordResult | undefined> {
  const existing = await input.store.getByIdempotencyScope(
    idempotencyScopeKey(input.scope)
  );
  if (existing === undefined) return undefined;
  assertIdempotencyRequestMatches(existing.row, input.idempotency_request_hash);
  return {
    status: "replayed",
    record: cloneStoredRecord(existing)
  };
}

export async function putCreatedInvoiceRecord(
  options: PutCreatedInvoiceRecordOptions
): Promise<PutCreatedInvoiceRecordResult> {
  validateStoredRecord(options.record);
  const replay = await getIdempotentRecord({
    store: options.store,
    scope: options.record.row,
    idempotency_request_hash: options.record.row.idempotency_request_hash
  });
  if (replay !== undefined) return replay;

  const maxRetries = options.maxInvoiceIdRetries ?? 5;
  let candidate = cloneStoredRecord(options.record);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const created = await options.store.putIfAbsent(candidate);
    if (created.status === "created") {
      return {
        status: "created",
        record: cloneStoredRecord(created.record)
      };
    }

    if (created.on === "idempotency_scope") {
      assertIdempotencyRequestMatches(
        created.existing.row,
        candidate.row.idempotency_request_hash
      );
      return {
        status: "replayed",
        record: cloneStoredRecord(created.existing)
      };
    }

    if (created.on === "invoice_id") {
      if (options.createInvoiceId === undefined || attempt === maxRetries) {
        throw new InvoiceStorageConflictError(
          "invoice_id must be unique",
          "invoice_id"
        );
      }
      candidate = {
        rev: 0,
        row: {
          ...candidate.row,
          invoice_id: options.createInvoiceId()
        }
      };
      continue;
    }

    throw new InvoiceStorageConflictError(
      created.on === "payment_hash"
        ? "payment_hash must be unique"
        : "invoice must be unique",
      created.on
    );
  }

  throw new InvoiceStorageConflictError(
    "invoice_id must be unique",
    "invoice_id"
  );
}

export function cloneStoredRecord(record: StoredRecord): StoredRecord {
  return {
    rev: record.rev,
    row: cloneInvoiceStorageRow(record.row)
  };
}

export function validateStoredRecord(record: StoredRecord): void {
  if (!Number.isSafeInteger(record.rev) || record.rev < 0) {
    throw new TypeError("stored record rev must be a non-negative safe integer");
  }
  validateInvoiceStorageRow(record.row);
}

function assertIdempotencyRequestMatches(
  row: InvoiceStorageRow,
  idempotencyRequestHash: string
): void {
  if (row.idempotency_request_hash !== idempotencyRequestHash) {
    throw new IdempotencyConflictError(row);
  }
}
