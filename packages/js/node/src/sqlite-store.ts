import {
  canonicalJson,
  idempotencyScopeKey,
  isTerminalInvoiceStorageRow,
  readInvoiceStorageOrderId,
  validateInvoiceStorageRow,
  type MetaRow,
  type MaybePromise,
  type OpenReceiveInvoiceKvStore,
  type OpenReceivePutIfAbsentResult,
  type StoredRecord
} from "@openreceive/core";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION
} from "./storage-schema.ts";

export interface OpenReceiveSqliteQueryResult {
  rows: Record<string, unknown>[];
}

export interface OpenReceiveSqliteQueryClient {
  execute(
    sql: string,
    values?: readonly unknown[]
  ): MaybePromise<OpenReceiveSqliteQueryResult>;
}

export interface OpenReceiveSqliteStatement {
  get?: (...values: unknown[]) => MaybePromise<Record<string, unknown> | undefined>;
  all?: (...values: unknown[]) => MaybePromise<Record<string, unknown>[]>;
  run?: (...values: unknown[]) => MaybePromise<unknown>;
}

export interface OpenReceiveSqliteDatabase {
  prepare(sql: string): OpenReceiveSqliteStatement;
  exec?(sql: string): unknown;
}

export interface OpenReceiveSqliteKvStoreOptions {
  client: OpenReceiveSqliteQueryClient;
  tableName?: string;
  metaTableName?: string;
  namespace?: string;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_TABLE_NAME = "openreceive_invoices";
const DEFAULT_META_TABLE_NAME = "openreceive_meta";
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const OPENRECEIVE_SQLITE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS openreceive_invoices (
  invoice_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  bolt11 TEXT NOT NULL UNIQUE,
  idempotency_scope TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS openreceive_invoices_order_idx
  ON openreceive_invoices (order_id);

CREATE INDEX IF NOT EXISTS openreceive_invoices_open_idx
  ON openreceive_invoices (terminal, expires_at);

CREATE TABLE IF NOT EXISTS openreceive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);
`.trim();

export function createOpenReceiveSqliteQueryClient(
  database: OpenReceiveSqliteDatabase
): OpenReceiveSqliteQueryClient {
  return {
    async execute(sql, values = []) {
      const statement = database.prepare(sql);
      const boundValues = values.map((value) => value ?? null);
      if (returnsRows(sql)) {
        if (statement.all !== undefined) {
          return {
            rows: await statement.all(...boundValues)
          };
        }
        if (statement.get !== undefined) {
          const row = await statement.get(...boundValues);
          return {
            rows: row === undefined ? [] : [row]
          };
        }
      }
      await statement.run?.(...boundValues);
      return {
        rows: []
      };
    }
  };
}

export async function migrateOpenReceiveSqlite(
  client: OpenReceiveSqliteQueryClient
): Promise<void> {
  for (const statement of splitSqlStatements(OPENRECEIVE_SQLITE_MIGRATION_SQL)) {
    await client.execute(statement);
  }
}

export function createOpenReceiveSqliteKvStore(
  options: OpenReceiveSqliteKvStoreOptions
): OpenReceiveSqliteKvStore {
  return new OpenReceiveSqliteKvStore(options);
}

export class OpenReceiveSqliteKvStore implements OpenReceiveInvoiceKvStore {
  readonly #client: OpenReceiveSqliteQueryClient;
  readonly #tableName: string;
  readonly #metaTableName: string;
  readonly #namespace: string;

  constructor(options: OpenReceiveSqliteKvStoreOptions) {
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
    await this.#client.execute("PRAGMA journal_mode=WAL");
    for (const statement of splitSqlStatements(this.#migrationSql())) {
      await this.#client.execute(statement);
    }
    await this.#claimMeta("owner", "openreceive");
    await this.#claimMeta("schema_version", OPENRECEIVE_DATABASE_SCHEMA_VERSION);
    await this.#claimMeta("namespace", this.#namespace);
  }

  async putIfAbsent(record: StoredRecord): Promise<OpenReceivePutIfAbsentResult> {
    validateStoredRecord(record);
    const result = await this.#client.execute(
      `INSERT OR IGNORE INTO ${this.#tableName} (
        invoice_id, rev, payment_hash, bolt11, idempotency_scope, order_id, terminal, expires_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING data`,
      [
        record.row.invoice_id,
        record.rev,
        record.row.payment_hash,
        record.row.invoice,
        idempotencyScopeKey(record.row),
        readInvoiceStorageOrderId(record.row),
        isTerminalInvoiceStorageRow(record.row) ? 1 : 0,
        record.row.expires_at,
        serializeStoredRecord(record)
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
    const result = await this.#client.execute(
      `UPDATE ${this.#tableName}
       SET rev = ?,
           payment_hash = ?,
           bolt11 = ?,
           idempotency_scope = ?,
           order_id = ?,
           terminal = ?,
           expires_at = ?,
           data = ?
       WHERE invoice_id = ? AND rev = ?
       RETURNING data`,
      [
        record.rev,
        record.row.payment_hash,
        record.row.invoice,
        idempotencyScopeKey(record.row),
        readInvoiceStorageOrderId(record.row),
        isTerminalInvoiceStorageRow(record.row) ? 1 : 0,
        record.row.expires_at,
        serializeStoredRecord(record),
        record.row.invoice_id,
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
      throw new Error(`OpenReceive SQLite record disappeared: ${record.row.invoice_id}`);
    }
    return {
      status: "conflict",
      record: current
    };
  }

  async get(invoiceId: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE invoice_id = ? LIMIT 1`,
      [invoiceId]
    );
  }

  async getByPaymentHash(paymentHash: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE payment_hash = ? LIMIT 1`,
      [paymentHash]
    );
  }

  async getByBolt11Invoice(invoice: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE bolt11 = ? LIMIT 1`,
      [invoice]
    );
  }

  async getByIdempotencyScope(scopeKey: string): Promise<StoredRecord | undefined> {
    return await this.#findOne(
      `SELECT data FROM ${this.#tableName} WHERE idempotency_scope = ? LIMIT 1`,
      [scopeKey]
    );
  }

  async listByOrderId(orderId: string): Promise<StoredRecord[]> {
    assertOrderId(orderId);
    const result = await this.#client.execute(
      `SELECT data FROM ${this.#tableName} WHERE order_id = ?`,
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

  async listOpen(input: { now: number; limit: number }): Promise<StoredRecord[]> {
    assertListOpenInput(input);
    const result = await this.#client.execute(
      `SELECT data FROM ${this.#tableName}
       WHERE terminal = 0
       ORDER BY expires_at ASC, invoice_id ASC
       LIMIT ?`,
      [input.limit]
    );
    return result.rows.map((row) => parseStoredRecordField(row.data));
  }

  async getMeta(key: string): Promise<MetaRow | undefined> {
    const result = await this.#client.execute(
      `SELECT value, rev FROM ${this.#metaTableName} WHERE key = ? LIMIT 1`,
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
      const result = await this.#client.execute(
        `INSERT OR IGNORE INTO ${this.#metaTableName} (key, value, rev)
         VALUES (?, ?, 0)
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

    const result = await this.#client.execute(
      `UPDATE ${this.#metaTableName}
       SET value = ?, rev = rev + 1
       WHERE key = ? AND rev = ?
       RETURNING value, rev`,
      [value, key, expectedRev]
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

    throw new Error("OpenReceive SQLite insert conflicted but no conflicting key was readable");
  }

  async #findOne(
    sql: string,
    values: readonly unknown[]
  ): Promise<StoredRecord | undefined> {
    const result = await this.#client.execute(sql, values);
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
      return;
    }
    if (existing.value !== value) throw metaMismatchError(key);
  }

  #migrationSql(): string {
    return `
CREATE TABLE IF NOT EXISTS ${this.#tableName} (
  invoice_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  bolt11 TEXT NOT NULL UNIQUE,
  idempotency_scope TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ${unquoted(this.#tableName)}_order_idx
  ON ${this.#tableName} (order_id);

CREATE INDEX IF NOT EXISTS ${unquoted(this.#tableName)}_open_idx
  ON ${this.#tableName} (terminal, expires_at);

CREATE TABLE IF NOT EXISTS ${this.#metaTableName} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);
`.trim();
  }
}

export const createOpenReceiveSqliteInvoiceStore = createOpenReceiveSqliteKvStore;
export const OpenReceiveSqliteInvoiceStore = OpenReceiveSqliteKvStore;

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function returnsRows(sql: string): boolean {
  return /^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

function validateStoredRecord(record: StoredRecord): void {
  if (!Number.isSafeInteger(record.rev) || record.rev < 0) {
    throw new TypeError("OpenReceive SQLite record rev must be a non-negative safe integer");
  }
  validateInvoiceStorageRow(record.row);
}

function serializeStoredRecord(record: StoredRecord): string {
  return canonicalJson(record);
}

function parseStoredRecordField(value: unknown): StoredRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError("OpenReceive SQLite data must be a stored record object");
  }
  const record = parsed as StoredRecord;
  validateStoredRecord(record);
  return structuredClone(record);
}

function normalizeMetaRow(row: Record<string, unknown>): MetaRow {
  return {
    value: stringField(row.value, "value"),
    rev: integerField(row.rev, "rev")
  };
}

function quotedIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new TypeError("OpenReceive SQLite identifier must be a simple SQL identifier");
  }
  return `"${identifier}"`;
}

function unquoted(quoted: string): string {
  return quoted.replace(/^"|"$/g, "");
}

function namespacedIdentifier(namespace: string, base: string): string {
  return namespace === DEFAULT_NAMESPACE ? base : `${namespace}_${base}`;
}

function normalizeNamespace(namespace: string): string {
  if (!/^[a-z0-9_]{1,40}$/.test(namespace)) {
    throw new TypeError("OPENRECEIVE_NAMESPACE must match ^[a-z0-9_]{1,40}$");
  }
  return namespace;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`OpenReceive SQLite meta ${field} must be a string`);
  }
  return value;
}

function integerField(value: unknown, field: string): number {
  const parsed: unknown = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`OpenReceive SQLite meta ${field} must be a safe integer`);
  }
  return parsed as number;
}

function assertListOpenInput(input: { now: number; limit: number }): void {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("OpenReceive SQLite listOpen now must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("OpenReceive SQLite listOpen limit must be a positive safe integer");
  }
}

function metaMismatchError(key: string): Error {
  return new Error(
    `OpenReceive store metadata ${key} does not belong to this OpenReceive namespace.`
  );
}
