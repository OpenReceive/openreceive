import {
  idempotencyScopeKey,
  isTerminalInvoiceStorageRow,
  readInvoiceStorageCheckoutId,
  readInvoiceStorageOrderId,
  type OpenReceiveInvoiceKvStore,
  type OpenReceivePutIfAbsentResult,
  type StoredRecord,
  type MetaRow
} from "@openreceive/core";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION
} from "./storage-schema.ts";
import {
  DEFAULT_META_TABLE_NAME,
  DEFAULT_NAMESPACE,
  DEFAULT_TABLE_NAME,
  assertCheckoutId,
  assertListOpenInput,
  assertOrderId,
  namespacedIdentifier,
  normalizeMetaRow,
  normalizeNamespace,
  parseStoredRecordField,
  quotedIdentifier,
  serializeStoredRecord,
  unquoted,
  validateStoredRecord,
} from "./store-common.ts";

export interface OpenReceivePostgresQueryResult {
  rows: Record<string, unknown>[];
}

export interface OpenReceivePostgresQueryClient {
  query(
    sql: string,
    values?: readonly unknown[]
  ): Promise<OpenReceivePostgresQueryResult>;
}

export interface OpenReceivePostgresKvStoreOptions {
  client: OpenReceivePostgresQueryClient;
  tableName?: string;
  metaTableName?: string;
  namespace?: string;
}

export interface OpenReceivePostgresPool {
  query(
    sql: string,
    values?: readonly unknown[]
  ): Promise<OpenReceivePostgresQueryResult>;
}

export interface OpenReceivePostgresKvStoreFromPoolOptions {
  pool: OpenReceivePostgresPool;
  tableName?: string;
  metaTableName?: string;
  namespace?: string;
  onReady?: (schemaVersion: string) => void;
  onMigrationError?: (error: unknown) => void;
}

export const OPENRECEIVE_POSTGRES_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS openreceive_invoices (
  invoice_id TEXT PRIMARY KEY,
  rev BIGINT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  bolt11 TEXT NOT NULL UNIQUE,
  idempotency_scope TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS openreceive_invoices_order_idx
  ON openreceive_invoices (order_id);

CREATE INDEX IF NOT EXISTS openreceive_invoices_checkout_idx
  ON openreceive_invoices (checkout_id);

CREATE INDEX IF NOT EXISTS openreceive_invoices_open_idx
  ON openreceive_invoices (terminal, expires_at);

CREATE TABLE IF NOT EXISTS openreceive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev BIGINT NOT NULL DEFAULT 0
);
`.trim();

export function createOpenReceivePostgresKvStore(
  options: OpenReceivePostgresKvStoreOptions
): OpenReceivePostgresKvStore {
  return new OpenReceivePostgresKvStore(options);
}

export function createOpenReceivePostgresKvStoreFromPool(
  options: OpenReceivePostgresKvStoreFromPoolOptions
): OpenReceivePostgresKvStore {
  const store = createOpenReceivePostgresKvStore({
    client: options.pool,
    ...(options.tableName === undefined ? {} : { tableName: options.tableName }),
    ...(options.metaTableName === undefined ? {} : { metaTableName: options.metaTableName }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace })
  });
  const ready = store.ensureSchema()
    .then(() => {
      options.onReady?.(OPENRECEIVE_DATABASE_SCHEMA_VERSION);
    });

  void ready.catch((error) => {
    options.onMigrationError?.(error);
  });

  return new OpenReceivePostgresKvStore({
    client: {
      async query(sql, values) {
        await ready;
        return await options.pool.query(sql, values);
      }
    },
    ...(options.tableName === undefined ? {} : { tableName: options.tableName }),
    ...(options.metaTableName === undefined ? {} : { metaTableName: options.metaTableName }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace })
  });
}

export class OpenReceivePostgresKvStore implements OpenReceiveInvoiceKvStore {
  readonly #client: OpenReceivePostgresQueryClient;
  readonly #tableName: string;
  readonly #metaTableName: string;
  readonly #namespace: string;

  constructor(options: OpenReceivePostgresKvStoreOptions) {
    this.#client = options.client;
    this.#namespace = normalizeNamespace(options.namespace ?? DEFAULT_NAMESPACE);
    this.#tableName = quotedIdentifier(
      options.tableName ?? namespacedIdentifier(this.#namespace, DEFAULT_TABLE_NAME)
    );
    this.#metaTableName = quotedIdentifier(
      options.metaTableName ?? namespacedIdentifier(this.#namespace, DEFAULT_META_TABLE_NAME)
    );
  }

  async ensureSchema(): Promise<void> {
    await this.#client.query(this.#migrationSql());
    await this.#claimMeta("owner", "openreceive");
    await this.#claimMeta("schema_version", OPENRECEIVE_DATABASE_SCHEMA_VERSION);
    await this.#claimMeta("namespace", this.#namespace);
  }

  async putIfAbsent(record: StoredRecord): Promise<OpenReceivePutIfAbsentResult> {
    validateStoredRecord(record);
    const data = serializeStoredRecord(record);
    const result = await this.#client.query(
      `INSERT INTO ${this.#tableName} (
        invoice_id, rev, payment_hash, bolt11, idempotency_scope, order_id, checkout_id, terminal, expires_at, data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING data`,
      [
        record.row.invoice_id,
        record.rev,
        record.row.payment_hash,
        record.row.invoice,
        idempotencyScopeKey(record.row),
        readInvoiceStorageOrderId(record.row),
        readInvoiceStorageCheckoutId(record.row),
        isTerminalInvoiceStorageRow(record.row),
        record.row.expires_at,
        data
      ]
    );
    const created = result.rows[0];
    if (created !== undefined) {
      return {
        status: "created",
        record: parseStoredRecordField(created.data)
      };
    }

    return await this.#detectPutIfAbsentConflict(record);
  }

  async put(
    record: StoredRecord,
    expectedRev: number
  ): Promise<{ status: "ok" | "conflict"; record: StoredRecord }> {
    validateStoredRecord(record);
    const result = await this.#client.query(
      `UPDATE ${this.#tableName}
       SET rev = $2,
           payment_hash = $3,
           bolt11 = $4,
           idempotency_scope = $5,
           order_id = $6,
           checkout_id = $7,
           terminal = $8,
           expires_at = $9,
           data = $10::jsonb
       WHERE invoice_id = $1 AND rev = $11
       RETURNING data`,
      [
        record.row.invoice_id,
        record.rev,
        record.row.payment_hash,
        record.row.invoice,
        idempotencyScopeKey(record.row),
        readInvoiceStorageOrderId(record.row),
        readInvoiceStorageCheckoutId(record.row),
        isTerminalInvoiceStorageRow(record.row),
        record.row.expires_at,
        serializeStoredRecord(record),
        expectedRev
      ]
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return {
        status: "ok",
        record: parseStoredRecordField(row.data)
      };
    }

    const current = await this.get(record.row.invoice_id);
    if (current === undefined) {
      throw new Error(`OpenReceive Postgres record disappeared: ${record.row.invoice_id}`);
    }
    return {
      status: "conflict",
      record: current
    };
  }

  async get(invoiceId: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE invoice_id = $1 LIMIT 1`,
      [invoiceId]
    );
  }

  async getByPaymentHash(paymentHash: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE payment_hash = $1 LIMIT 1`,
      [paymentHash]
    );
  }

  async getByBolt11Invoice(invoice: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE bolt11 = $1 LIMIT 1`,
      [invoice]
    );
  }

  async getByIdempotencyScope(scopeKey: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE idempotency_scope = $1 LIMIT 1`,
      [scopeKey]
    );
  }

  async listByOrderId(orderId: string): Promise<StoredRecord[]> {
    assertOrderId(orderId);
    const result = await this.#client.query(
      `SELECT data FROM ${this.#tableName}
       WHERE order_id = $1`,
      [orderId]
    );
    return result.rows
      .map((row) => parseStoredRecordField(row.data))
      .sort((left, right) =>
        left.row.created_at === right.row.created_at
          ? right.row.invoice_id.localeCompare(left.row.invoice_id)
          : right.row.created_at - left.row.created_at
      );
  }

  async listByCheckoutId(checkoutId: string): Promise<StoredRecord[]> {
    assertCheckoutId(checkoutId);
    const result = await this.#client.query(
      `SELECT data FROM ${this.#tableName}
       WHERE checkout_id = $1`,
      [checkoutId]
    );
    return result.rows
      .map((row) => parseStoredRecordField(row.data))
      .sort((left, right) =>
        left.row.created_at === right.row.created_at
          ? right.row.invoice_id.localeCompare(left.row.invoice_id)
          : right.row.created_at - left.row.created_at
      );
  }

  async listOpen(input: { now: number; limit: number }): Promise<StoredRecord[]> {
    assertListOpenInput(input);
    const result = await this.#client.query(
      `SELECT data FROM ${this.#tableName}
       WHERE terminal = false AND expires_at > $1
       ORDER BY expires_at ASC, invoice_id ASC
       LIMIT $2`,
      [input.now, input.limit]
    );
    return result.rows.map((row) => parseStoredRecordField(row.data));
  }

  async getMeta(key: string): Promise<MetaRow | undefined> {
    const result = await this.#client.query(
      `SELECT value, rev FROM ${this.#metaTableName} WHERE key = $1 LIMIT 1`,
      [key]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : normalizeMetaRow(row);
  }

  async casMeta(
    key: string,
    value: string,
    expectedRev: number | null
  ): Promise<{ status: "ok" | "conflict"; row: MetaRow }> {
    if (expectedRev === null) {
      const result = await this.#client.query(
        `INSERT INTO ${this.#metaTableName} (key, value, rev)
         VALUES ($1, $2, 0)
         ON CONFLICT DO NOTHING
         RETURNING value, rev`,
        [key, value]
      );
      const row = result.rows[0];
      if (row !== undefined) {
        return {
          status: "ok",
          row: normalizeMetaRow(row)
        };
      }
      return {
        status: "conflict",
        row: await this.#requireMeta(key)
      };
    }

    const result = await this.#client.query(
      `UPDATE ${this.#metaTableName}
       SET value = $2, rev = rev + 1
       WHERE key = $1 AND rev = $3
       RETURNING value, rev`,
      [key, value, expectedRev]
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return {
        status: "ok",
        row: normalizeMetaRow(row)
      };
    }
    return {
      status: "conflict",
      row: await this.#requireMeta(key)
    };
  }

  async #detectPutIfAbsentConflict(
    record: StoredRecord
  ): Promise<OpenReceivePutIfAbsentResult> {
    const scopeExisting = await this.getByIdempotencyScope(idempotencyScopeKey(record.row));
    if (scopeExisting !== undefined) {
      return {
        status: "conflict",
        on: "idempotency_scope",
        existing: scopeExisting
      };
    }

    const invoiceExisting = await this.get(record.row.invoice_id);
    if (invoiceExisting !== undefined) {
      return {
        status: "conflict",
        on: "invoice_id",
        existing: invoiceExisting
      };
    }

    const paymentHashExisting = await this.getByPaymentHash(record.row.payment_hash);
    if (paymentHashExisting !== undefined) {
      return {
        status: "conflict",
        on: "payment_hash",
        existing: paymentHashExisting
      };
    }

    const bolt11Existing = await this.getByBolt11Invoice(record.row.invoice);
    if (bolt11Existing !== undefined) {
      return {
        status: "conflict",
        on: "bolt11",
        existing: bolt11Existing
      };
    }

    throw new Error("OpenReceive Postgres insert conflicted but no conflicting key was readable");
  }

  async #findOne(
    sql: string,
    values: readonly unknown[]
  ): Promise<StoredRecord | undefined> {
    const result = await this.#client.query(sql, values);
    const row = result.rows[0];
    return row === undefined ? undefined : parseStoredRecordField(row.data);
  }

  async #requireMeta(key: string): Promise<MetaRow> {
    const row = await this.getMeta(key);
    if (row === undefined) {
      return {
        value: "",
        rev: -1
      };
    }
    return row;
  }

  async #claimMeta(key: string, value: string): Promise<void> {
    const existing = await this.getMeta(key);
    if (existing === undefined) {
      const claimed = await this.casMeta(key, value, null);
      if (claimed.status === "ok") return;
      if (claimed.row.value !== value) throw metaMismatchError(key);
      return;
    }
    if (key === "schema_version") {
      if (existing.value > OPENRECEIVE_DATABASE_SCHEMA_VERSION) {
        throw new Error("OpenReceive store schema is newer than this package.");
      }
      if (existing.value !== OPENRECEIVE_DATABASE_SCHEMA_VERSION) {
        throw new Error("OpenReceive store schema is older than this package.");
      }
      return;
    }
    if (existing.value !== value) throw metaMismatchError(key);
  }

  #migrationSql(): string {
    return `
CREATE TABLE IF NOT EXISTS ${this.#tableName} (
  invoice_id TEXT PRIMARY KEY,
  rev BIGINT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  bolt11 TEXT NOT NULL UNIQUE,
  idempotency_scope TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  checkout_id TEXT NOT NULL,
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS ${unquoted(this.#tableName)}_order_idx
  ON ${this.#tableName} (order_id);

CREATE INDEX IF NOT EXISTS ${unquoted(this.#tableName)}_checkout_idx
  ON ${this.#tableName} (checkout_id);

CREATE INDEX IF NOT EXISTS ${unquoted(this.#tableName)}_open_idx
  ON ${this.#tableName} (terminal, expires_at);

CREATE TABLE IF NOT EXISTS ${this.#metaTableName} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev BIGINT NOT NULL DEFAULT 0
);
`.trim();
  }
}

export const createOpenReceivePostgresInvoiceStore = createOpenReceivePostgresKvStore;
export const createOpenReceivePostgresInvoiceStoreFromPool = createOpenReceivePostgresKvStoreFromPool;
export const OpenReceivePostgresInvoiceStore = OpenReceivePostgresKvStore;

function metaMismatchError(key: string): Error {
  return new Error(
    `OpenReceive store metadata ${key} does not belong to this OpenReceive namespace.`
  );
}

