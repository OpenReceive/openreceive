import { sha256 } from "./swap/hash.ts";

/** Postgres truncates identifiers at 63 bytes; longer ones silently collide. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Generation of the `openreceive_payments` / `openreceive_meta` schema this
 * library writes and reads. Stamped into `openreceive_meta` by the canonical
 * DDL; the SQL repository refuses to run against a strictly newer generation.
 */
export const OPENRECEIVE_PAYMENTS_SCHEMA_VERSION = 1 as const;

export type PaymentsDialect = "postgres" | "sqlite" | "mysql";

/**
 * MySQL and MariaDB table options. InnoDB gives the row locks the repository
 * relies on, and a binary collation compares references exactly, as postgres
 * and sqlite do, instead of ignoring case and accents.
 */
const MYSQL_TABLE_OPTIONS = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";

/** Every status an attempt row may hold, as a SQL list for the CHECK constraint. */
const ATTEMPT_STATUS_SQL_LIST = "'pending', 'settled', 'expired', 'failed', 'attention'";

export interface PaymentsDdlOptions {
  readonly dialect: PaymentsDialect;
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  /** Durable reconcile-gate key/value table name. Default `openreceive_meta`. */
  readonly metaTableName?: string;
}

/** The `status IN (...)` predicate every rendering of the schema must enforce. */
export function paymentsStatusCheckSql(): string {
  return `status IN (${ATTEMPT_STATUS_SQL_LIST})`;
}

/**
 * Dialect predicate for "64 lowercase hexadecimal characters". On MySQL and
 * MariaDB, `(?-i)` keeps the match case-sensitive even in a table an ORM made
 * with a case-insensitive collation.
 */
export function paymentsHashCheckSql(dialect: PaymentsDialect): string {
  if (dialect === "postgres") return "payment_hash ~ '^[0-9a-f]{64}$'";
  if (dialect === "mysql") return "payment_hash REGEXP '(?-i)^[0-9a-f]{64}$'";
  return "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'";
}

/**
 * The meta table's `key` column as a statement must name it: `key` is a
 * reserved word in MySQL and MariaDB, and a plain identifier elsewhere.
 */
export function paymentsMetaKeyColumn(dialect: PaymentsDialect): string {
  return dialect === "mysql" ? "`key`" : "key";
}

/**
 * Index (or constraint) name for a table, kept inside the 63-byte postgres
 * identifier limit: a long custom table name is truncated and given a short
 * digest of the full name, so two long names cannot collapse onto one index.
 */
export function paymentsIndexName(tableName: string, suffix: string): string {
  const full = `${tableName}_${suffix}`;
  // `.length` (UTF-16 units) is exact here: every caller has passed the name
  // through an ASCII-only identifier check (assertDdlIdentifier below; the
  // scaffold's assertPaymentsTableName), so units and UTF-8 bytes agree.
  if (full.length <= MAX_IDENTIFIER_BYTES) return full;
  const digest = hexDigest(full).slice(0, 8);
  const room = MAX_IDENTIFIER_BYTES - suffix.length - digest.length - 2;
  return `${tableName.slice(0, Math.max(1, room))}_${digest}_${suffix}`;
}

/**
 * The `openreceive_meta` seed row recording which schema generation is
 * installed, as one idempotent INSERT. Every migration path must run it: the
 * repository's newer-schema refusal probe only engages when it exists.
 */
export function paymentsSeedSql(
  dialect: PaymentsDialect,
  metaTableName = "openreceive_meta",
): string {
  assertDdlIdentifier(metaTableName);
  const values = `(${paymentsMetaKeyColumn(dialect)}, value, rev) VALUES ('schema_version', '${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}', 0)`;
  if (dialect === "postgres") {
    return `INSERT INTO ${metaTableName} ${values} ON CONFLICT (key) DO NOTHING`;
  }
  if (dialect === "mysql") return `INSERT IGNORE INTO ${metaTableName} ${values}`;
  return `INSERT OR IGNORE INTO ${metaTableName} ${values}`;
}

interface PaymentsColumn {
  readonly name: string;
  readonly definition: string;
}

function paymentsColumns(options: PaymentsDdlOptions): readonly PaymentsColumn[] {
  if (options.dialect === "mysql") return MYSQL_PAYMENTS_COLUMNS;
  const bigint = options.dialect === "postgres" ? "BIGINT" : "INTEGER";
  return [
    {
      name: "id",
      definition:
        options.dialect === "postgres"
          ? "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
          : "INTEGER PRIMARY KEY AUTOINCREMENT",
    },
    { name: "reference", definition: "TEXT NOT NULL" },
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
 * MySQL can neither index nor default a TEXT column, so the indexed and
 * defaulted columns are VARCHARs: 255 characters holds the HTTP layer's
 * 200-character reference. The JSON columns are MEDIUMTEXT, so a large
 * snapshot is never cut at TEXT's 64 KB.
 */
const MYSQL_PAYMENTS_COLUMNS: readonly PaymentsColumn[] = [
  { name: "id", definition: "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY" },
  { name: "reference", definition: "VARCHAR(255) NOT NULL" },
  { name: "payment_hash", definition: "VARCHAR(64) NOT NULL UNIQUE" },
  { name: "status", definition: "VARCHAR(32) NOT NULL DEFAULT 'pending'" },
  { name: "status_reason", definition: "VARCHAR(255)" },
  { name: "paid_at", definition: "BIGINT" },
  { name: "expires_at", definition: "BIGINT NOT NULL" },
  { name: "created_at", definition: "BIGINT NOT NULL" },
  { name: "updated_at", definition: "BIGINT NOT NULL" },
  { name: "inserted_at", definition: "BIGINT NOT NULL" },
  { name: "checkout_data", definition: "MEDIUMTEXT NOT NULL" },
  { name: "swap_data", definition: "MEDIUMTEXT" },
  { name: "client_ip", definition: "VARCHAR(255)" },
];

/**
 * Every column of the canonical `openreceive_payments` table, in DDL order.
 * Derived from the same source the DDL renders from, so documentation built on
 * it (the scaffold wiring guide) cannot drift from the schema.
 */
export function paymentsColumnNames(): readonly string[] {
  return paymentsColumns({ dialect: "sqlite" }).map((column) => column.name);
}

/**
 * The one canonical payment-attempts DDL, as bare statements (no trailing
 * semicolons). `@openreceive/http` renders it for its migration helper and the
 * scaffold CLI renders it into ORM migrations — both from here, so the two can
 * never drift. Every column and constraint must be kept as rendered; there is
 * nothing here to tune per host. The sibling `openreceive_meta` key/value/rev table
 * backs the durable reconcile gate shared by every worker on this database —
 * same host database, never a second one — and records the installed schema
 * version.
 *
 * There is deliberately NO unique index for "one active attempt per rail": a
 * replaced attempt stays `pending` with a future `expires_at`, and an expired
 * attempt stays `pending` until a wallet scan closes it, so any DB-level
 * uniqueness over pending rows would reject legitimate reminting. The
 * repository enforces the time-dependent predicate inside the per-reference commit
 * lock, which no index can express.
 */
export function paymentsDdlStatements(options: PaymentsDdlOptions): readonly string[] {
  const tableName = options.tableName ?? "openreceive_payments";
  const metaTableName = options.metaTableName ?? "openreceive_meta";
  assertDdlIdentifier(tableName);
  assertDdlIdentifier(metaTableName);
  if (options.dialect === "mysql") return mysqlDdlStatements(tableName, metaTableName);
  const bigint = options.dialect === "postgres" ? "BIGINT" : "INTEGER";
  const columns = paymentsColumns(options).map(
    (column) => `  ${column.name} ${column.definition},`,
  );
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      ...columns,
      `  CHECK (${paymentsStatusCheckSql()}),`,
      `  CHECK (${paymentsHashCheckSql(options.dialect)})`,
      ")",
    ].join("\n"),
    `CREATE INDEX IF NOT EXISTS ${paymentsIndexName(tableName, "reference_created_idx")} ON ${tableName} (reference, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${paymentsIndexName(tableName, "status_created_idx")} ON ${tableName} (status, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${paymentsIndexName(tableName, "client_ip_inserted_idx")} ON ${tableName} (client_ip, inserted_at)`,
    [
      `CREATE TABLE IF NOT EXISTS ${metaTableName} (`,
      "  key TEXT PRIMARY KEY,",
      "  value TEXT NOT NULL,",
      `  rev ${bigint} NOT NULL DEFAULT 0`,
      ")",
    ].join("\n"),
    paymentsSeedSql(options.dialect, metaTableName),
  ];
}

/**
 * MySQL has no CREATE INDEX IF NOT EXISTS (MariaDB does), so the indexes sit
 * inside CREATE TABLE IF NOT EXISTS and the script stays re-runnable on both.
 * MySQL enforces the CHECK constraints from 8.0.16, MariaDB from 10.2.
 */
function mysqlDdlStatements(tableName: string, metaTableName: string): readonly string[] {
  const columns = MYSQL_PAYMENTS_COLUMNS.map((column) => `  ${column.name} ${column.definition},`);
  const index = (suffix: string, columnList: string): string =>
    `  INDEX ${paymentsIndexName(tableName, suffix)} (${columnList}),`;
  return [
    [
      `CREATE TABLE IF NOT EXISTS ${tableName} (`,
      ...columns,
      index("reference_created_idx", "reference, created_at"),
      index("status_created_idx", "status, created_at"),
      index("client_ip_inserted_idx", "client_ip, inserted_at"),
      `  CHECK (${paymentsStatusCheckSql()}),`,
      `  CHECK (${paymentsHashCheckSql("mysql")})`,
      `) ${MYSQL_TABLE_OPTIONS}`,
    ].join("\n"),
    [
      `CREATE TABLE IF NOT EXISTS ${metaTableName} (`,
      `  ${paymentsMetaKeyColumn("mysql")} VARCHAR(191) NOT NULL PRIMARY KEY,`,
      "  value MEDIUMTEXT NOT NULL,",
      "  rev BIGINT NOT NULL DEFAULT 0",
      `) ${MYSQL_TABLE_OPTIONS}`,
    ].join("\n"),
    paymentsSeedSql("mysql", metaTableName),
  ];
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
