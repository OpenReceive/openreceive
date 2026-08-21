import { sha256 } from "./swap/hash.ts";

/** Postgres truncates identifiers at 63 bytes; longer ones silently collide. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Generation of the `openreceive_payments` / `openreceive_meta` schema this
 * library writes and reads. Stamped into `openreceive_meta` by the canonical
 * DDL; the SQL repository refuses to run against a strictly newer generation.
 */
export const OPENRECEIVE_PAYMENTS_SCHEMA_VERSION = 1 as const;

export type OpenReceivePaymentsDialect = "postgres" | "sqlite";

/** Every status an attempt row may hold, as a SQL list for the CHECK constraint. */
const ATTEMPT_STATUS_SQL_LIST = "'pending', 'settled', 'expired', 'failed', 'attention'";

export interface OpenReceivePaymentsDdlOptions {
  readonly dialect: OpenReceivePaymentsDialect;
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  /** Durable reconcile-gate key/value table name. Default `openreceive_meta`. */
  readonly metaTableName?: string;
  /** Raw SQL type for `order_id`, matching the host order key. Default `TEXT`. */
  readonly orderIdSqlType?: string;
  /**
   * SQL appended to the `order_id` column definition, typically a foreign key
   * such as ` REFERENCES orders (id)`. Default: none.
   */
  readonly orderIdReferencesSql?: string;
}

/** The `status IN (...)` predicate every rendering of the schema must enforce. */
export function openReceivePaymentsStatusCheckSql(): string {
  return `status IN (${ATTEMPT_STATUS_SQL_LIST})`;
}

/** Dialect predicate for "64 lowercase hexadecimal characters". */
export function openReceivePaymentsHashCheckSql(dialect: OpenReceivePaymentsDialect): string {
  return dialect === "postgres"
    ? "payment_hash ~ '^[0-9a-f]{64}$'"
    : "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'";
}

/**
 * Index (or constraint) name for a table, kept inside the 63-byte postgres
 * identifier limit: a long custom table name is truncated and given a short
 * digest of the full name, so two long names cannot collapse onto one index.
 */
export function openReceivePaymentsIndexName(tableName: string, suffix: string): string {
  const full = `${tableName}_${suffix}`;
  if (utf8ByteLength(full) <= MAX_IDENTIFIER_BYTES) return full;
  const digest = hexDigest(full).slice(0, 8);
  const room = MAX_IDENTIFIER_BYTES - suffix.length - digest.length - 2;
  return `${tableName.slice(0, Math.max(1, room))}_${digest}_${suffix}`;
}

/**
 * The `openreceive_meta` seed row recording which schema generation is
 * installed, as one idempotent INSERT. Every migration path must run it: the
 * repository's newer-schema refusal probe only engages when it exists.
 */
export function openReceivePaymentsSeedSql(
  dialect: OpenReceivePaymentsDialect,
  metaTableName = "openreceive_meta",
): string {
  assertDdlIdentifier(metaTableName);
  const values = `(key, value, rev) VALUES ('schema_version', '${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}', 0)`;
  return dialect === "postgres"
    ? `INSERT INTO ${metaTableName} ${values} ON CONFLICT (key) DO NOTHING`
    : `INSERT OR IGNORE INTO ${metaTableName} ${values}`;
}

interface PaymentsColumn {
  readonly name: string;
  readonly definition: string;
}

function paymentsColumns(options: OpenReceivePaymentsDdlOptions): readonly PaymentsColumn[] {
  const bigint = options.dialect === "postgres" ? "BIGINT" : "INTEGER";
  return [
    {
      name: "id",
      definition:
        options.dialect === "postgres"
          ? "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
          : "INTEGER PRIMARY KEY AUTOINCREMENT",
    },
    {
      name: "order_id",
      definition: `${options.orderIdSqlType ?? "TEXT"} NOT NULL${options.orderIdReferencesSql ?? ""}`,
    },
    { name: "payment_hash", definition: "TEXT NOT NULL UNIQUE" },
    { name: "status", definition: "TEXT NOT NULL DEFAULT 'pending'" },
    { name: "status_reason", definition: "TEXT" },
    { name: "paid_at", definition: bigint },
    { name: "expires_at", definition: `${bigint} NOT NULL` },
    { name: "created_at", definition: `${bigint} NOT NULL` },
    { name: "updated_at", definition: `${bigint} NOT NULL` },
    { name: "inserted_at", definition: `${bigint} NOT NULL` },
    { name: "checkout_data", definition: "TEXT NOT NULL" },
    { name: "swap_data", definition: "TEXT" },
    { name: "client_ip", definition: "TEXT" },
  ];
}

/**
 * Every column of the canonical `openreceive_payments` table, in DDL order.
 * Derived from the same source the DDL renders from, so documentation built on
 * it (the scaffold wiring guide) cannot drift from the schema.
 */
export function openReceivePaymentsColumnNames(): readonly string[] {
  return paymentsColumns({ dialect: "sqlite" }).map((column) => column.name);
}

/**
 * The one canonical payment-attempts DDL, as bare statements (no trailing
 * semicolons). `@openreceive/http` renders it for its migration helper and the
 * scaffold CLI renders it into ORM migrations — both from here, so the two can
 * never drift. Hosts may adjust `order_id` typing or add a foreign key (the
 * `orderIdSqlType` / `orderIdReferencesSql` options), but must keep every
 * column and constraint. The sibling `openreceive_meta` key/value/rev table
 * backs the durable reconcile gate shared by every worker on this database —
 * same host database, never a second one — and records the installed schema
 * version.
 *
 * There is deliberately NO unique index for "one active attempt per rail": a
 * replaced attempt stays `pending` with a future `expires_at`, and an expired
 * attempt stays `pending` until a wallet scan closes it, so any DB-level
 * uniqueness over pending rows would reject legitimate reminting. The
 * repository enforces the time-dependent predicate inside the per-order commit
 * lock, which no index can express.
 */
export function openReceivePaymentsDdlStatements(
  options: OpenReceivePaymentsDdlOptions,
): readonly string[] {
  const tableName = options.tableName ?? "openreceive_payments";
  const metaTableName = options.metaTableName ?? "openreceive_meta";
  assertDdlIdentifier(tableName);
  assertDdlIdentifier(metaTableName);
  const bigint = options.dialect === "postgres" ? "BIGINT" : "INTEGER";
  const columns = paymentsColumns(options).map(
    (column) => `  ${column.name} ${column.definition},`,
  );
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      ...columns,
      `  CHECK (${openReceivePaymentsStatusCheckSql()}),`,
      `  CHECK (${openReceivePaymentsHashCheckSql(options.dialect)})`,
      ")",
    ].join("\n"),
    `CREATE INDEX IF NOT EXISTS ${openReceivePaymentsIndexName(tableName, "order_created_idx")} ON ${tableName} (order_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${openReceivePaymentsIndexName(tableName, "status_created_idx")} ON ${tableName} (status, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${openReceivePaymentsIndexName(tableName, "client_ip_inserted_idx")} ON ${tableName} (client_ip, inserted_at)`,
    [
      `CREATE TABLE IF NOT EXISTS ${metaTableName} (`,
      "  key TEXT PRIMARY KEY,",
      "  value TEXT NOT NULL,",
      `  rev ${bigint} NOT NULL DEFAULT 0`,
      ")",
    ].join("\n"),
    openReceivePaymentsSeedSql(options.dialect, metaTableName),
  ];
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hexDigest(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertDdlIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
}
