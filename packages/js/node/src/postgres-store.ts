import {
  IdempotencyConflictError,
  InvoiceNotFoundError,
  InvoiceStorageConflictError,
  canonicalJson,
  idempotencyScopeKey,
  validateInvoiceStorageRow,
  type InvoiceCreateStorageResult,
  type InvoiceStorageRow,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveInvoiceStore,
  type OpenReceiveRecoverableInvoiceQuery
} from "@openreceive/core";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE
} from "./storage-schema.ts";

export interface OpenReceivePostgresQueryResult {
  rows: Record<string, unknown>[];
}

export interface OpenReceivePostgresQueryClient {
  query(
    sql: string,
    values?: readonly unknown[]
  ): Promise<OpenReceivePostgresQueryResult>;
}

export interface OpenReceivePostgresInvoiceStoreOptions {
  client: OpenReceivePostgresQueryClient;
  tableName?: string;
}

export interface OpenReceivePostgresPool {
  query(
    sql: string,
    values?: readonly unknown[]
  ): Promise<OpenReceivePostgresQueryResult>;
}

export interface OpenReceivePostgresInvoiceStoreFromPoolOptions {
  pool: OpenReceivePostgresPool;
  tableName?: string;
  onReady?: (schemaVersion: string) => void;
  onMigrationError?: (error: unknown) => void;
}

const DEFAULT_TABLE_NAME = "openreceive_invoices";
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const OPENRECEIVE_POSTGRES_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS openreceive_invoices (
  invoice_id TEXT PRIMARY KEY,
  merchant_scope TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_request_hash TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  invoice TEXT NOT NULL UNIQUE,
  amount_msats BIGINT NOT NULL,
  transaction_state TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  settlement_action_state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  settled_at BIGINT,
  settlement_action_completed_at BIGINT,
  refreshed_from_invoice_id TEXT REFERENCES openreceive_invoices(invoice_id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  fiat_quote JSONB,
  created_row_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_row_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT openreceive_invoices_idempotency_hash
    CHECK (idempotency_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT openreceive_invoices_amount_msats_bounds
    CHECK (amount_msats >= 1000 AND amount_msats <= 9007199254740991),
  CONSTRAINT openreceive_invoices_time_order
    CHECK (expires_at >= created_at),
  CONSTRAINT openreceive_invoices_transaction_state
    CHECK (transaction_state IN ('pending', 'settled', 'expired', 'failed', 'accepted')),
  CONSTRAINT openreceive_invoices_workflow_state
    CHECK (workflow_state IN (
      'draft',
      'invoice_created',
      'verifying',
      'settlement_action_pending',
      'settlement_action_completed',
      'expiry_pending_verification',
      'expired_closed',
      'failed_closed',
      'cancelled'
    )),
  CONSTRAINT openreceive_invoices_settlement_action_state
    CHECK (settlement_action_state IN ('pending', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS openreceive_invoices_idempotency_scope_idx
  ON openreceive_invoices (merchant_scope, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS openreceive_invoices_recovery_idx
  ON openreceive_invoices (workflow_state, transaction_state, expires_at);

CREATE TABLE IF NOT EXISTS ${OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE} (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ${OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE} (version)
  VALUES ('${OPENRECEIVE_DATABASE_SCHEMA_VERSION}')
  ON CONFLICT (version) DO NOTHING;
`.trim();

export function createOpenReceivePostgresInvoiceStore(
  options: OpenReceivePostgresInvoiceStoreOptions
): OpenReceivePostgresInvoiceStore {
  return new OpenReceivePostgresInvoiceStore(options);
}

export function createOpenReceivePostgresInvoiceStoreFromPool(
  options: OpenReceivePostgresInvoiceStoreFromPoolOptions
): OpenReceivePostgresInvoiceStore {
  const migration = options.pool.query(OPENRECEIVE_POSTGRES_MIGRATION_SQL)
    .then(() => {
      options.onReady?.(OPENRECEIVE_DATABASE_SCHEMA_VERSION);
    });

  void migration.catch((error) => {
    options.onMigrationError?.(error);
  });

  const client: OpenReceivePostgresQueryClient = {
    async query(sql, values) {
      await migration;
      return await options.pool.query(
        sql,
        values === undefined ? undefined : [...values]
      );
    }
  };

  return createOpenReceivePostgresInvoiceStore({
    client,
    ...(options.tableName === undefined ? {} : { tableName: options.tableName })
  });
}

export class OpenReceivePostgresInvoiceStore implements OpenReceiveInvoiceStore {
  readonly #client: OpenReceivePostgresQueryClient;
  readonly #tableName: string;

  constructor(options: OpenReceivePostgresInvoiceStoreOptions) {
    this.#client = options.client;
    this.#tableName = quotedIdentifier(options.tableName ?? DEFAULT_TABLE_NAME);
  }

  async checkIdempotency(input: {
    scope: OpenReceiveIdempotencyScope;
    idempotency_request_hash: string;
  }): Promise<InvoiceCreateStorageResult | undefined> {
    idempotencyScopeKey(input.scope);
    const row = await this.#findOne(
      `SELECT * FROM ${this.#tableName}
       WHERE merchant_scope = $1 AND operation = $2 AND idempotency_key = $3
       LIMIT 1`,
      [
        input.scope.merchant_scope,
        input.scope.operation,
        input.scope.idempotency_key
      ]
    );

    if (row === undefined) return undefined;
    if (row.idempotency_request_hash !== input.idempotency_request_hash) {
      throw new IdempotencyConflictError(input.scope);
    }

    return {
      status: "replayed",
      row
    };
  }

  async createInvoice(row: InvoiceStorageRow): Promise<InvoiceCreateStorageResult> {
    validateInvoiceStorageRow(row);
    const replay = await this.checkIdempotency({
      scope: row,
      idempotency_request_hash: row.idempotency_request_hash
    });
    if (replay !== undefined) return replay;

    try {
      const result = await this.#client.query(
        `INSERT INTO ${this.#tableName} (
          invoice_id,
          merchant_scope,
          operation,
          idempotency_key,
          idempotency_request_hash,
          payment_hash,
          invoice,
          amount_msats,
          transaction_state,
          workflow_state,
          settlement_action_state,
          created_at,
          expires_at,
          settled_at,
          settlement_action_completed_at,
          refreshed_from_invoice_id,
          metadata,
          fiat_quote
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17::jsonb, $18::jsonb
        )
        RETURNING *`,
        [
          row.invoice_id,
          row.merchant_scope,
          row.operation,
          row.idempotency_key,
          row.idempotency_request_hash,
          row.payment_hash,
          row.invoice,
          row.amount_msats,
          row.transaction_state,
          row.workflow_state,
          row.settlement_action_state,
          row.created_at,
          row.expires_at,
          row.settled_at ?? null,
          row.settlement_action_completed_at ?? null,
          row.refreshed_from_invoice_id ?? null,
          canonicalJson(row.metadata),
          row.fiat_quote === undefined || row.fiat_quote === null
            ? null
            : canonicalJson(row.fiat_quote)
        ]
      );

      return {
        status: "created",
        row: normalizePostgresInvoiceRow(requiredRow(result))
      };
    } catch (error) {
      const replayAfterRace = await this.checkIdempotency({
        scope: row,
        idempotency_request_hash: row.idempotency_request_hash
      });
      if (replayAfterRace !== undefined) return replayAfterRace;

      if (isPostgresUniqueViolation(error)) {
        throw new InvoiceStorageConflictError("invoice_id, payment_hash, and invoice must be unique");
      }
      throw error;
    }
  }

  async getInvoice(invoiceId: string): Promise<InvoiceStorageRow | undefined> {
    return this.#findOne(
      `SELECT * FROM ${this.#tableName} WHERE invoice_id = $1 LIMIT 1`,
      [invoiceId]
    );
  }

  async getInvoiceByPaymentHash(
    paymentHash: string
  ): Promise<InvoiceStorageRow | undefined> {
    return this.#findOne(
      `SELECT * FROM ${this.#tableName} WHERE payment_hash = $1 LIMIT 1`,
      [paymentHash]
    );
  }

  async getInvoiceByBolt11Invoice(
    invoice: string
  ): Promise<InvoiceStorageRow | undefined> {
    return this.#findOne(
      `SELECT * FROM ${this.#tableName} WHERE invoice = $1 LIMIT 1`,
      [invoice]
    );
  }

  async listRecoverableInvoices(
    input: OpenReceiveRecoverableInvoiceQuery
  ): Promise<InvoiceStorageRow[]> {
    const graceSeconds = input.grace_seconds ?? 15;
    const result = await this.#client.query(
      `SELECT * FROM ${this.#tableName}
       WHERE workflow_state NOT IN (
          'settlement_action_completed',
          'expired_closed',
          'failed_closed',
          'cancelled'
        )
        AND (
          (transaction_state = 'settled' AND settlement_action_state <> 'completed')
          OR (
            transaction_state NOT IN ('settled', 'expired', 'failed')
            AND expires_at + $1 >= $2
          )
        )
       ORDER BY created_at ASC, invoice_id ASC`,
      [graceSeconds, input.now]
    );

    return result.rows.map((row) => normalizePostgresInvoiceRow(row));
  }

  async markVerifying(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET workflow_state = CASE
            WHEN transaction_state <> 'settled'
             AND workflow_state IN ('invoice_created', 'expiry_pending_verification')
            THEN 'verifying'
            ELSE workflow_state
          END,
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async markExpiryPendingVerification(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET workflow_state = CASE
            WHEN transaction_state NOT IN ('settled', 'expired', 'failed')
            THEN 'expiry_pending_verification'
            ELSE workflow_state
          END,
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async markSettled(input: {
    invoice_id: string;
    settled_at?: number;
  }): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET transaction_state = 'settled',
          workflow_state = CASE
            WHEN workflow_state = 'settlement_action_completed'
            THEN workflow_state
            ELSE 'settlement_action_pending'
          END,
          settled_at = COALESCE(settled_at, $2),
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [input.invoice_id, input.settled_at ?? null],
      input.invoice_id
    );
  }

  async markExpiredClosed(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET transaction_state = CASE
            WHEN transaction_state = 'settled' THEN transaction_state
            ELSE 'expired'
          END,
          workflow_state = CASE
            WHEN transaction_state = 'settled' THEN workflow_state
            ELSE 'expired_closed'
          END,
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async markFailedClosed(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET transaction_state = CASE
            WHEN transaction_state = 'settled' THEN transaction_state
            ELSE 'failed'
          END,
          workflow_state = CASE
            WHEN transaction_state = 'settled' THEN workflow_state
            ELSE 'failed_closed'
          END,
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async markSettlementActionPending(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET workflow_state = 'settlement_action_pending',
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async markSettlementActionCompleted(input: {
    invoice_id: string;
    settlement_action_completed_at: number;
  }): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET workflow_state = 'settlement_action_completed',
          settlement_action_state = 'completed',
          settlement_action_completed_at = COALESCE(settlement_action_completed_at, $2),
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [input.invoice_id, input.settlement_action_completed_at],
      input.invoice_id
    );
  }

  async markSettlementActionFailed(invoiceId: string): Promise<InvoiceStorageRow> {
    return this.#updateOne(
      `UPDATE ${this.#tableName}
       SET workflow_state = 'settlement_action_pending',
          settlement_action_state = 'failed',
          updated_row_at = now()
       WHERE invoice_id = $1
       RETURNING *`,
      [invoiceId],
      invoiceId
    );
  }

  async #findOne(
    sql: string,
    values: readonly unknown[]
  ): Promise<InvoiceStorageRow | undefined> {
    const result = await this.#client.query(sql, values);
    const row = result.rows[0];
    return row === undefined ? undefined : normalizePostgresInvoiceRow(row);
  }

  async #updateOne(
    sql: string,
    values: readonly unknown[],
    invoiceId: string
  ): Promise<InvoiceStorageRow> {
    const result = await this.#client.query(sql, values);
    const row = result.rows[0];
    if (row === undefined) throw new InvoiceNotFoundError(invoiceId);
    return normalizePostgresInvoiceRow(row);
  }
}

function normalizePostgresInvoiceRow(
  row: Record<string, unknown>
): InvoiceStorageRow {
  return {
    invoice_id: stringField(row.invoice_id, "invoice_id"),
    merchant_scope: stringField(row.merchant_scope, "merchant_scope"),
    operation: operationField(row.operation),
    idempotency_key: stringField(row.idempotency_key, "idempotency_key"),
    idempotency_request_hash: stringField(row.idempotency_request_hash, "idempotency_request_hash"),
    payment_hash: stringField(row.payment_hash, "payment_hash"),
    invoice: stringField(row.invoice, "invoice"),
    amount_msats: integerField(row.amount_msats, "amount_msats"),
    transaction_state: transactionStateField(row.transaction_state),
    workflow_state: workflowStateField(row.workflow_state),
    settlement_action_state: settlementActionStateField(row.settlement_action_state),
    created_at: integerField(row.created_at, "created_at"),
    expires_at: integerField(row.expires_at, "expires_at"),
    ...(row.settled_at === null || row.settled_at === undefined
      ? {}
      : { settled_at: integerField(row.settled_at, "settled_at") }),
    ...(row.settlement_action_completed_at === null ||
    row.settlement_action_completed_at === undefined
      ? {}
      : {
        settlement_action_completed_at: integerField(
          row.settlement_action_completed_at,
          "settlement_action_completed_at"
        )
      }),
    ...(row.refreshed_from_invoice_id === null ||
    row.refreshed_from_invoice_id === undefined
      ? {}
      : {
        refreshed_from_invoice_id: stringField(
          row.refreshed_from_invoice_id,
          "refreshed_from_invoice_id"
        )
      }),
    metadata: jsonRecordField(row.metadata, "metadata"),
    fiat_quote:
      row.fiat_quote === undefined || row.fiat_quote === null
        ? null
        : jsonRecordField(row.fiat_quote, "fiat_quote")
  };
}

function requiredRow(result: OpenReceivePostgresQueryResult): Record<string, unknown> {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("OpenReceive Postgres insert did not return a row");
  }
  return row;
}

function quotedIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new TypeError("OpenReceive Postgres tableName must be a simple SQL identifier");
  }
  return `"${identifier}"`;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`OpenReceive Postgres row ${field} must be a non-empty string`);
  }
  return value;
}

function integerField(value: unknown, field: string): number {
  const parsed: unknown = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`OpenReceive Postgres row ${field} must be a safe integer`);
  }
  return parsed as number;
}

function jsonRecordField(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`OpenReceive Postgres row ${field} must be a JSON object`);
  }
  return structuredClone(parsed) as Record<string, unknown>;
}

function operationField(value: unknown): InvoiceStorageRow["operation"] {
  if (value === "invoice.create" || value === "invoice.refresh") return value;
  throw new TypeError("OpenReceive Postgres row operation is invalid");
}

function transactionStateField(
  value: unknown
): InvoiceStorageRow["transaction_state"] {
  if (
    value === "pending" ||
    value === "settled" ||
    value === "expired" ||
    value === "failed" ||
    value === "accepted"
  ) {
    return value;
  }
  throw new TypeError("OpenReceive Postgres row transaction_state is invalid");
}

function workflowStateField(value: unknown): InvoiceStorageRow["workflow_state"] {
  if (
    value === "draft" ||
    value === "invoice_created" ||
    value === "verifying" ||
    value === "settlement_action_pending" ||
    value === "settlement_action_completed" ||
    value === "expiry_pending_verification" ||
    value === "expired_closed" ||
    value === "failed_closed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new TypeError("OpenReceive Postgres row workflow_state is invalid");
}

function settlementActionStateField(
  value: unknown
): InvoiceStorageRow["settlement_action_state"] {
  if (value === "pending" || value === "completed" || value === "failed") {
    return value;
  }
  throw new TypeError("OpenReceive Postgres row settlement_action_state is invalid");
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
