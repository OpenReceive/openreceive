import { createHash, randomUUID } from "node:crypto";
import type { PaymentDetails } from "@openreceive/core";
import type { CheckoutInvoice, SwapData } from "@openreceive/node";
import type { CheckoutCreatedInput } from "./handler.ts";
import { hostError } from "./errors.ts";
import {
  liveAttemptCommitDecision,
  openReceivePaymentInsert,
  type OpenReceiveAttemptStatus,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
  type OpenReceiveReconcilableAttempt,
  type OpenReceiveReconciliationTransition,
} from "./host-payments.ts";

/** Namespacing seed for the postgres per-order advisory lock. */
const ADVISORY_LOCK_SEED = 8_210_223;

/** The one durable reconcile-gate row every worker shares. */
const RECONCILE_GATE_META_KEY = "transaction_scan_gate";
/** CAS retries under contention before reporting the gate busy. */
const RECONCILE_GATE_CAS_RETRIES = 6;
/**
 * Tolerance when reading a timestamp another worker wrote. Beyond it a claim
 * stamped in the future is a backwards clock step, not a fresh claim: without
 * this clamp the gate would read as busy until wall-clock time caught up.
 */
const META_CLOCK_SKEW_SECONDS = 60;
/** The `openreceive_meta` row recording which schema generation is installed. */
const SCHEMA_VERSION_META_KEY = "schema_version";
/** Postgres truncates identifiers at 63 bytes; longer ones silently collide. */
const MAX_IDENTIFIER_BYTES = 63;
/**
 * How long SQLite waits for another connection's write lock before reporting
 * SQLITE_BUSY. The library's transactions are short (one order's rows), so a
 * few seconds covers ordinary contention with the host's own writes.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Generation of the `openreceive_payments` / `openreceive_meta` schema this
 * library writes and reads. Stamped into `openreceive_meta` by the canonical
 * DDL; the repository refuses to run against a strictly newer generation.
 */
export const OPENRECEIVE_PAYMENTS_SCHEMA_VERSION = 1 as const;

/**
 * Oldest-first page size for one reconciliation pass. A backlog of pending
 * attempts is drained over several passes instead of loading every row (and
 * scanning every invoice's window) in one unbounded query.
 */
export const OPENRECEIVE_RECONCILE_BATCH_SIZE = 200 as const;

function parseClaimedAt(value: unknown): number | undefined {
  try {
    const parsed = JSON.parse(String(value)) as { claimed_at?: unknown };
    return typeof parsed.claimed_at === "number" && Number.isFinite(parsed.claimed_at)
      ? parsed.claimed_at
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs one SQL statement and returns SELECT rows (`[]` otherwise). The SQL
 * arrives written for the adapter's own dialect — `?` placeholders on sqlite,
 * `$1`-style on postgres — so pass it to the driver verbatim. Nothing rewrites
 * it: a `?` inside a string literal, a comment, or a postgres JSON operator
 * (`data ? 'field'`) must survive untouched.
 */
export type OpenReceiveSqlQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface OpenReceiveSqlClient {
  readonly query: OpenReceiveSqlQuery;
}

/**
 * The escape-hatch database boundary: a dialect, a query function, and a
 * transaction wrapper. The built-in bindings cover `pg` pools/clients and
 * SQLite (`node:sqlite` or better-sqlite3) without adding dependencies.
 */
export interface OpenReceiveSqlAdapter extends OpenReceiveSqlClient {
  readonly dialect: "postgres" | "sqlite";
  transaction<T>(run: (tx: OpenReceiveSqlClient) => Promise<T>): Promise<T>;
}

/**
 * Structural view of a `pg` Pool or Client. A Pool's `connect()` checks out a
 * per-transaction client; a Client's `connect()` opens its one socket and
 * resolves nothing, so it must be called at most once. A handle with only
 * `query` is treated as a single connection and transactions serialize on it.
 */
interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  // A Pool resolves a pooled client; a pg Client resolves nothing (void).
  connect?(): Promise<unknown>;
}

interface PgPooledClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Structural view of `node:sqlite` DatabaseSync or a better-sqlite3 Database. */
interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

/** Any database handle `createOpenReceiveSqlPayments` accepts. */
export type OpenReceiveSqlDatabase = OpenReceiveSqlAdapter | PgLike | SqliteLike;

export interface OpenReceiveSqlPaymentsOptions {
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  /** Durable reconcile-gate key/value table name. Default `openreceive_meta`. */
  readonly metaTableName?: string;
  readonly clock?: () => number;
}

/** Settlement context passed to the host's `onPaid` in library-persistence mode. */
export interface OpenReceiveOrderSettlement {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly paidAt: number;
  readonly details?: PaymentDetails;
  /**
   * Runs statements inside the settlement transaction. Use it to update the
   * host order or insert a transactional outbox row. Write the placeholders
   * your database uses (`?` on sqlite, `$1`-style on postgres) — this SQL is
   * yours and reaches the driver exactly as written.
   */
  readonly query: OpenReceiveSqlQuery;
}

export type OpenReceiveOrderSettlementHook = (
  settlement: OpenReceiveOrderSettlement,
) => void | Promise<void>;

export interface OpenReceiveSqlPaymentRepository extends OpenReceivePaymentRepository {
  /**
   * Replay-safe settlement transaction: set the attempt's `paid_at`/`settled`
   * status once, and run `fulfill` inside the same transaction only for the
   * order's first settled attempt. A later sibling settlement is recorded with
   * reason `duplicate_settlement` and never fulfills again. Returns whether
   * this call won the order's first-settlement claim (and therefore ran
   * `fulfill`).
   */
  markPaidOnce(
    input: { paymentHash: string; paidAt: number; details?: PaymentDetails },
    fulfill: OpenReceiveOrderSettlementHook,
  ): Promise<boolean>;
}

/** Every status an attempt row may hold, as a SQL list for the CHECK constraint. */
const ATTEMPT_STATUS_SQL_LIST = "'pending', 'settled', 'expired', 'failed', 'attention'";

/** Dialect predicate for "64 lowercase hexadecimal characters". */
function paymentHashCheckSql(dialect: "postgres" | "sqlite"): string {
  return dialect === "postgres"
    ? "payment_hash ~ '^[0-9a-f]{64}$'"
    : "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'";
}

/**
 * Index name for a table, kept inside the 63-byte postgres identifier limit: a
 * long custom table name is truncated and given a short digest of the full
 * name, so two long names cannot collapse onto one index.
 */
function schemaIndexName(tableName: string, suffix: string): string {
  const full = `${tableName}_${suffix}`;
  if (Buffer.byteLength(full, "utf8") <= MAX_IDENTIFIER_BYTES) return full;
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 8);
  const room = MAX_IDENTIFIER_BYTES - suffix.length - digest.length - 2;
  return `${tableName.slice(0, Math.max(1, room))}_${digest}_${suffix}`;
}

/**
 * The canonical payment-attempts DDL. The scaffold CLI emits this for the host's
 * migration workflow; hosts may adjust `order_id` typing or add a foreign key,
 * but must keep every column and constraint. The sibling `openreceive_meta`
 * key/value/rev table backs the durable reconcile gate shared by every worker on
 * this database — same host database, never a second one — and records the
 * installed schema version.
 *
 * There is deliberately NO unique index for "one live attempt per rail": a
 * superseded attempt stays `pending` with a future `expires_at`, and an expired
 * attempt stays `pending` until a wallet scan closes it, so any DB-level
 * uniqueness over pending rows would reject legitimate reminting. Liveness is
 * a time-dependent predicate, which no index can express; the repository
 * enforces it inside the per-order commit lock.
 */
export function openReceivePaymentsSchemaSql(
  dialect: "postgres" | "sqlite",
  tableName = "openreceive_payments",
  metaTableName = "openreceive_meta",
): string {
  assertSafeIdentifier(tableName);
  assertSafeIdentifier(metaTableName);
  const primaryKey =
    dialect === "postgres"
      ? "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
      : "id INTEGER PRIMARY KEY AUTOINCREMENT";
  const bigint = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const insertMeta =
    dialect === "postgres"
      ? `INSERT INTO ${metaTableName} (key, value, rev) VALUES ('${SCHEMA_VERSION_META_KEY}', '${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}', 0) ON CONFLICT (key) DO NOTHING;`
      : `INSERT OR IGNORE INTO ${metaTableName} (key, value, rev) VALUES ('${SCHEMA_VERSION_META_KEY}', '${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}', 0);`;
  return [
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    `  ${primaryKey},`,
    "  order_id TEXT NOT NULL,",
    "  payment_hash TEXT NOT NULL UNIQUE,",
    "  status TEXT NOT NULL DEFAULT 'pending',",
    "  status_reason TEXT,",
    `  paid_at ${bigint},`,
    `  expires_at ${bigint} NOT NULL,`,
    `  created_at ${bigint} NOT NULL,`,
    `  updated_at ${bigint} NOT NULL,`,
    `  inserted_at ${bigint} NOT NULL,`,
    "  checkout_data TEXT NOT NULL,",
    "  swap_data TEXT,",
    "  client_ip TEXT,",
    `  CHECK (status IN (${ATTEMPT_STATUS_SQL_LIST})),`,
    `  CHECK (${paymentHashCheckSql(dialect)})`,
    ");",
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(tableName, "order_created_idx")} ON ${tableName} (order_id, created_at);`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(tableName, "status_created_idx")} ON ${tableName} (status, created_at);`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(tableName, "client_ip_inserted_idx")} ON ${tableName} (client_ip, inserted_at);`,
    `CREATE TABLE IF NOT EXISTS ${metaTableName} (`,
    "  key TEXT PRIMARY KEY,",
    "  value TEXT NOT NULL,",
    `  rev ${bigint} NOT NULL DEFAULT 0`,
    ");",
    insertMeta,
  ].join("\n");
}

/**
 * Library-owned payment-attempt repository over the host application's existing
 * database. Owns the commit locking, settlement write-once, and reconciliation
 * state transitions so host applications never implement them.
 */
export function createOpenReceiveSqlPayments(
  db: OpenReceiveSqlDatabase,
  options: OpenReceiveSqlPaymentsOptions = {},
): OpenReceiveSqlPaymentRepository {
  const adapter = resolveSqlAdapter(db);
  const table = options.tableName ?? "openreceive_payments";
  assertSafeIdentifier(table);
  const metaTable = options.metaTableName ?? "openreceive_meta";
  assertSafeIdentifier(metaTable);
  const clock = options.clock ?? currentUnixSeconds;
  // Library-authored SQL is rendered for this dialect here, at authoring time.
  // Host SQL (notably the settlement hook's `query`) is never rewritten: a `?`
  // in a literal, a comment, or a postgres JSON operator must survive.
  const statement = (sql: string): string =>
    adapter.dialect === "postgres" ? toPgPlaceholders(sql) : sql;

  const lockOrder = async (tx: OpenReceiveSqlClient, orderId: string): Promise<void> => {
    // SQLite transactions are single-writer (BEGIN IMMEDIATE); postgres needs a
    // per-order serialization boundary that does not assume an orders table.
    if (adapter.dialect === "postgres") {
      await tx.query(statement("SELECT pg_advisory_xact_lock(hashtextextended(?, ?))"), [
        orderId,
        ADVISORY_LOCK_SEED,
      ]);
    }
  };

  const rowsForOrder = async (
    tx: OpenReceiveSqlClient,
    orderId: string,
  ): Promise<readonly OpenReceivePaymentRecord[]> => {
    const rows = await tx.query(
      statement(
        `SELECT * FROM ${table} WHERE order_id = ? ORDER BY created_at DESC, payment_hash DESC`,
      ),
      [orderId],
    );
    return rows.map(recordFromRow);
  };

  // One probe per repository, on first use: a database written by a NEWER
  // library must not be operated by this one (columns or state transitions it
  // does not know about). An unreadable or absent marker means "not versioned"
  // — the pre-versioned migrations could not seed a row — and is not a refusal.
  let schemaVersionChecked: Promise<void> | undefined;
  const assertSupportedSchema = (): Promise<void> => {
    schemaVersionChecked ??= (async () => {
      let stored: number | undefined;
      try {
        const rows = await adapter.query(
          statement(`SELECT value FROM ${metaTable} WHERE key = ? LIMIT 1`),
          [SCHEMA_VERSION_META_KEY],
        );
        const value = rows[0]?.value;
        stored = value === undefined ? undefined : Number(asString(value, "value"));
      } catch {
        return;
      }
      if (stored === undefined || !Number.isInteger(stored)) return;
      if (stored > OPENRECEIVE_PAYMENTS_SCHEMA_VERSION) {
        throw new TypeError(
          `${metaTable} reports openreceive schema version ${stored}, newer than this library's ` +
            `${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}. Upgrade @openreceive/http before serving this database.`,
        );
      }
    })();
    return schemaVersionChecked;
  };

  return {
    async listForOrder(orderId) {
      await assertSupportedSchema();
      return rowsForOrder(adapter, orderId);
    },

    async listReconcilableAttempts() {
      await assertSupportedSchema();
      // Oldest first, one batch per pass: the attempts closest to their closure
      // deadline are always covered, and a backlog drains over several passes
      // instead of widening one wallet scan window without bound.
      const rows = await adapter.query(
        statement(
          `SELECT payment_hash, created_at, expires_at FROM ${table} WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
        ),
        [OPENRECEIVE_RECONCILE_BATCH_SIZE],
      );
      return rows.map(
        (row): OpenReceiveReconcilableAttempt => ({
          paymentHash: asString(row.payment_hash, "payment_hash"),
          createdAt: asInteger(row.created_at, "created_at"),
          expiresAt: asInteger(row.expires_at, "expires_at"),
        }),
      );
    },

    async claimReconcileGate({ now, intervalSeconds }) {
      await assertSupportedSchema();
      // Optimistic CAS over the shared openreceive_meta row: every worker on
      // this database (Node instances, Puma workers via the Rails engine) races
      // on ONE gate row, so rapid calls collapse to one real wallet scan per
      // interval. The winner is identified by reading back its own token — the
      // portable equivalent of an affected-row count across both adapters.
      const token = randomUUID();
      const claimValue = JSON.stringify({ claimed_at: now, token });
      const insertIfAbsent =
        adapter.dialect === "postgres"
          ? `INSERT INTO ${metaTable} (key, value, rev) VALUES (?, ?, 0) ON CONFLICT (key) DO NOTHING`
          : `INSERT OR IGNORE INTO ${metaTable} (key, value, rev) VALUES (?, ?, 0)`;
      for (let attempt = 0; attempt < RECONCILE_GATE_CAS_RETRIES; attempt += 1) {
        const rows = await adapter.query(
          statement(`SELECT value, rev FROM ${metaTable} WHERE key = ? LIMIT 1`),
          [RECONCILE_GATE_META_KEY],
        );
        const current = rows[0];
        if (current === undefined) {
          await adapter.query(statement(insertIfAbsent), [RECONCILE_GATE_META_KEY, claimValue]);
        } else {
          const claimedAt = parseClaimedAt(current.value);
          if (claimedAt !== undefined && isFreshTimestamp(now, claimedAt, intervalSeconds)) {
            return false;
          }
          await adapter.query(
            statement(`UPDATE ${metaTable} SET value = ?, rev = rev + 1 WHERE key = ? AND rev = ?`),
            [claimValue, RECONCILE_GATE_META_KEY, asInteger(current.rev, "rev")],
          );
        }
        const readback = await adapter.query(
          statement(`SELECT value FROM ${metaTable} WHERE key = ? LIMIT 1`),
          [RECONCILE_GATE_META_KEY],
        );
        if (readback[0] !== undefined && String(readback[0].value) === claimValue) return true;
      }
      return false;
    },

    async commitAttempt(input: CheckoutCreatedInput) {
      await assertSupportedSchema();
      const insert = openReceivePaymentInsert(input);
      const now = clock();
      await adapter.transaction(async (tx) => {
        await lockOrder(tx, insert.orderId);
        const existing = await rowsForOrder(tx, insert.orderId);
        if (existing.some((row) => row.paymentHash === insert.paymentHash)) return;
        if (existing.some((row) => row.status === "settled")) {
          throw hostError("This order is already paid.", 409, "CONFLICT");
        }
        // A superseded row stays 'pending' so the wallet scan keeps covering it
        // (see below), but it must never block or be superseded again: only a
        // row still offered to a payer counts as live.
        const live = existing.filter(
          (row) =>
            row.status === "pending" && row.expiresAt > now && row.statusReason !== "superseded",
        );
        for (const row of live) {
          const decision = liveAttemptCommitDecision(row, insert, now);
          if (decision === "conflict") {
            throw hostError(
              "This order already has a live payment attempt for the same method.",
              409,
              "CONFLICT",
            );
          }
          if (decision === "supersede") {
            // Marked, not closed. The invoice is still payable until it expires
            // wallet-side, and closing it here on the local clock alone would
            // drop it out of the reconcile scan set and the notification path,
            // so a payer who pays it delivers funds nothing can ever match.
            // A wallet scan at or after expiry plus grace closes it, like any
            // other pending row.
            await tx.query(
              statement(
                `UPDATE ${table} SET status_reason = 'superseded', updated_at = ? WHERE payment_hash = ? AND status = 'pending'`,
              ),
              [now, row.paymentHash],
            );
          }
        }
        await tx.query(
          statement(
            `INSERT INTO ${table} (order_id, payment_hash, status, paid_at, expires_at, created_at, updated_at, inserted_at, checkout_data, swap_data, client_ip)
           VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)`,
          ),
          [
            insert.orderId,
            insert.paymentHash,
            insert.expiresAt,
            insert.createdAt,
            now,
            now,
            JSON.stringify(insert.checkout),
            insert.swapData === undefined ? null : JSON.stringify(insert.swapData),
            insert.clientIp ?? null,
          ],
        );
      });
    },

    async countAttemptsFromIp(clientIp: string, sinceUnixSeconds: number) {
      // inserted_at is stamped once, from the local clock, and never changes.
      // created_at is the wallet-reported invoice time (a skewed wallet clock
      // would move the budget window), and updated_at moves on every later
      // status transition — which would re-enter an old attempt into the
      // current window and throttle a payer for activity they did not cause.
      const rows = await adapter.query(
        statement(`SELECT COUNT(*) AS n FROM ${table} WHERE client_ip = ? AND inserted_at >= ?`),
        [clientIp, sinceUnixSeconds],
      );
      return asInteger(rows[0]?.n ?? 0, "n");
    },

    async recordReconciliation(transition: OpenReceiveReconciliationTransition) {
      await assertSupportedSchema();
      await adapter.transaction(async (tx) => {
        // Guarding on status = 'pending' makes the transition idempotent and
        // guarantees a settled attempt is never overwritten.
        await tx.query(
          statement(
            `UPDATE ${table} SET status = ?, status_reason = ?, updated_at = ? WHERE payment_hash = ? AND status = 'pending'`,
          ),
          [
            transition.status,
            transition.reason,
            transition.observedAt,
            transition.paymentHash.toLowerCase(),
          ],
        );
      });
    },

    // Same write-once claim as markPaidOnce, without a fulfillment hook: in
    // custom-repository mode the host's own handler runs outside this
    // transaction, so it is handed no transactional query.
    recordSettlement: (settlement) => markPaidOnce(settlement, () => undefined),

    markPaidOnce,
  };

  async function markPaidOnce(
    input: { paymentHash: string; paidAt: number; details?: PaymentDetails },
    fulfill: OpenReceiveOrderSettlementHook,
  ): Promise<boolean> {
    await assertSupportedSchema();
    const paymentHash = input.paymentHash.toLowerCase();
    return adapter.transaction(async (tx) => {
      const preliminary = await tx.query(
        statement(`SELECT order_id FROM ${table} WHERE payment_hash = ?`),
        [paymentHash],
      );
      const orderId = preliminary[0]?.order_id;
      if (orderId === undefined) return false;
      await lockOrder(tx, asString(orderId, "order_id"));
      const rows = await rowsForOrder(tx, asString(orderId, "order_id"));
      const row = rows.find((candidate) => candidate.paymentHash === paymentHash);
      if (row === undefined || row.status === "settled") return false;
      const firstForOrder = !rows.some((candidate) => candidate.status === "settled");
      const now = clock();
      await tx.query(
        statement(
          `UPDATE ${table} SET status = 'settled', status_reason = ?, paid_at = ?, updated_at = ? WHERE payment_hash = ?`,
        ),
        [firstForOrder ? null : "duplicate_settlement", input.paidAt, now, paymentHash],
      );
      if (firstForOrder) {
        await fulfill({
          orderId: row.orderId,
          paymentHash,
          paidAt: input.paidAt,
          ...(input.details === undefined ? {} : { details: input.details }),
          query: tx.query,
        });
      }
      return firstForOrder;
    });
  }
}

/** Wrap a supported database handle in the uniform adapter interface. */
export function resolveSqlAdapter(db: OpenReceiveSqlDatabase): OpenReceiveSqlAdapter {
  if (isSqlAdapter(db)) return db;
  if (isSqliteLike(db)) return sqliteAdapter(db);
  if (isPgLike(db)) return pgAdapter(db);
  throw new TypeError(
    "Unsupported database handle. Pass a pg Pool/Client, a SQLite database (node:sqlite or better-sqlite3), or an OpenReceiveSqlAdapter.",
  );
}

function isSqlAdapter(db: OpenReceiveSqlDatabase): db is OpenReceiveSqlAdapter {
  const candidate = db as Partial<OpenReceiveSqlAdapter>;
  return (
    (candidate.dialect === "postgres" || candidate.dialect === "sqlite") &&
    typeof candidate.transaction === "function" &&
    typeof candidate.query === "function"
  );
}

function isSqliteLike(db: OpenReceiveSqlDatabase): db is SqliteLike {
  const candidate = db as Partial<SqliteLike>;
  return typeof candidate.prepare === "function" && typeof candidate.exec === "function";
}

function isPgLike(db: OpenReceiveSqlDatabase): db is PgLike {
  return typeof (db as Partial<PgLike>).query === "function";
}

/**
 * In-process serialization for a single database connection: transactions (and
 * reads that must not observe another request's uncommitted state) run one at
 * a time, in arrival order.
 */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function sqliteAdapter(db: SqliteLike): OpenReceiveSqlAdapter {
  // Without a busy timeout, BEGIN IMMEDIATE fails instantly with SQLITE_BUSY
  // whenever another connection (the host's own, typically) holds the write
  // lock, surfacing as a 503 on a checkout that would have succeeded a
  // millisecond later. The pragma makes SQLite wait instead of throwing.
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  } catch {
    // A handle that rejects the pragma (a wrapper, a read-only connection)
    // keeps SQLite's default behaviour rather than failing construction.
  }
  const query: OpenReceiveSqlQuery = async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      return statement.all(...params) as Record<string, unknown>[];
    }
    statement.run(...params);
    return [];
  };
  // node:sqlite / better-sqlite3 expose one connection, so concurrent requests
  // serialize through an in-process queue; top-level reads join the same queue
  // so they never observe an open transaction's uncommitted state.
  const enqueue = createSerialQueue();
  return {
    dialect: "sqlite",
    query: (sql, params) => enqueue(() => query(sql, params)),
    transaction(run) {
      return enqueue(async () => {
        // BEGIN IMMEDIATE takes the write lock up front, making concurrent
        // commits for one order serialize at the database.
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await run({ query });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction may already have rolled back on error.
          }
          throw error;
        }
      });
    },
  };
}

function isPooledClient(value: unknown): value is PgPooledClientLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PgPooledClientLike).query === "function" &&
    typeof (value as PgPooledClientLike).release === "function"
  );
}

function pgAdapter(db: PgLike): OpenReceiveSqlAdapter {
  const queryOn =
    (client: { query: PgLike["query"] }): OpenReceiveSqlQuery =>
    async (sql, params = []) => {
      // Verbatim: the library already wrote `$n` for this dialect, and host SQL
      // (the settlement hook's own statements) must not be rewritten at all.
      const result = await client.query(sql, [...params]);
      return result.rows;
    };
  const directQuery = queryOn(db);
  const enqueue = createSerialQueue();

  // A pg Pool checks out a dedicated client per transaction; a pg Client (or a
  // custom query-only handle) is one shared connection whose transactions must
  // serialize in-process — and Client.connect() opens the socket, so it must
  // never be treated as a checkout. Pools are recognized structurally by their
  // counter getters; otherwise the first transaction probes connect() once:
  // a Pool returns a client with query + release, a Client resolves undefined
  // (connecting it as a side effect) or rejects because it is already connected.
  let mode: "pool" | "single" | undefined =
    db.connect === undefined
      ? "single"
      : typeof (db as { totalCount?: unknown }).totalCount === "number"
        ? "pool"
        : undefined;

  /** Checks out a per-transaction client on a pool; undefined in single mode. */
  const checkoutPooledClient = async (): Promise<PgPooledClientLike | undefined> => {
    if (mode === "single") return undefined;
    try {
      const client = await db.connect?.();
      if (isPooledClient(client)) {
        mode = "pool";
        return client;
      }
      // pg.Client.connect() resolves undefined after opening its one socket.
      mode = "single";
      return undefined;
    } catch (error) {
      if (
        mode === undefined &&
        error instanceof Error &&
        /already been connected/i.test(error.message)
      ) {
        mode = "single";
        return undefined;
      }
      throw error;
    }
  };

  const runTransaction = async <T>(
    query: OpenReceiveSqlQuery,
    run: (tx: OpenReceiveSqlClient) => Promise<T>,
  ): Promise<T> => {
    await query("BEGIN");
    try {
      const result = await run({ query });
      await query("COMMIT");
      return result;
    } catch (error) {
      try {
        await query("ROLLBACK");
      } catch {
        // Connection-level failures surface via the original error.
      }
      throw error;
    }
  };

  return {
    dialect: "postgres",
    // Pooled reads are isolated per checked-out connection; single-connection
    // reads join the transaction queue so they never see uncommitted state.
    query: (sql, params) =>
      mode === "pool" ? directQuery(sql, params) : enqueue(() => directQuery(sql, params)),
    async transaction(run) {
      const client = await checkoutPooledClient();
      if (client !== undefined) {
        try {
          return await runTransaction(queryOn(client), run);
        } finally {
          client.release();
        }
      }
      return enqueue(() => runTransaction(directQuery, run));
    },
  };
}

/**
 * Renders one LIBRARY-authored statement for postgres. Only ever applied to
 * SQL written in this file, which contains no string literals, comments, or
 * JSON operators — host SQL is never passed through here.
 */
function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    index += 1;
    return `$${index}`;
  });
}

/** True when `timestamp` is inside `windowSeconds` of `now`, allowing for skew. */
function isFreshTimestamp(now: number, timestamp: number, windowSeconds: number): boolean {
  const age = now - timestamp;
  // A timestamp far in the future is a clock that stepped backwards, not a
  // fresh write: clamping it to stale keeps a rewound clock from freezing the
  // gate until wall-clock time catches up.
  if (age < -META_CLOCK_SKEW_SECONDS) return false;
  return age < windowSeconds;
}

function recordFromRow(row: Record<string, unknown>): OpenReceivePaymentRecord {
  const swapData = row.swap_data;
  const paymentHash = asString(row.payment_hash, "payment_hash");
  return {
    orderId: asString(row.order_id, "order_id"),
    paymentHash,
    status: asStatus(row.status),
    statusReason: row.status_reason === undefined ? null : (row.status_reason as string | null),
    paidAt:
      row.paid_at === null || row.paid_at === undefined ? null : asInteger(row.paid_at, "paid_at"),
    expiresAt: asInteger(row.expires_at, "expires_at"),
    createdAt: asInteger(row.created_at, "created_at"),
    checkout: parseRowJson(
      asString(row.checkout_data, "checkout_data"),
      "checkout_data",
      paymentHash,
    ) as CheckoutInvoice,
    swapData:
      swapData === null || swapData === undefined
        ? null
        : (parseRowJson(asString(swapData, "swap_data"), "swap_data", paymentHash) as SwapData),
  };
}

/**
 * Parse a JSON column, naming the row so a corrupt value is a storage problem
 * an operator can locate rather than a bare SyntaxError from somewhere in the
 * payment path. The message carries the column and payment hash only — never
 * the value, which may hold server-only swap credentials.
 */
function parseRowJson(value: string, column: string, paymentHash: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(
      `Corrupt ${column} JSON on openreceive payment attempt ${paymentHash}; the row cannot be read.`,
    );
  }
}

const ATTEMPT_STATUSES: readonly OpenReceiveAttemptStatus[] = [
  "pending",
  "settled",
  "expired",
  "failed",
  "attention",
];

function asStatus(value: unknown): OpenReceiveAttemptStatus {
  if (typeof value === "string" && (ATTEMPT_STATUSES as readonly string[]).includes(value)) {
    return value as OpenReceiveAttemptStatus;
  }
  throw new TypeError(`Unexpected openreceive_payments status: ${String(value)}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new TypeError(`Expected ${field} to be a string.`);
}

/**
 * Read an integer column. Every numeric column this repository reads is a
 * count, a revision, or a unix-seconds timestamp, and pg returns BIGINT as a
 * string — so integral strings are accepted while fractions are rejected, and
 * no future reuse of this helper can quietly turn a money column into a binary
 * float.
 */
function asInteger(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`Expected ${field} to fit a safe integer.`);
    }
    return Number(value);
  }
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new TypeError(`Expected ${field} to be an integer.`);
}

function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
