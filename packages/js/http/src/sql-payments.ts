import {
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  type PaymentDetails,
  type PaymentsDialect,
  paymentsDdlStatements,
  paymentsMetaKeyColumn,
  redactSecrets,
  unixSeconds,
} from "@openreceive/core";
import { hostError } from "./errors.ts";
import type { CheckoutCreatedInput } from "./handler.ts";
import { checkpointMetaGate, claimMetaGate, type MetaStore } from "./meta-gate.ts";
import {
  liveAttemptCommitDecision,
  type PaymentRecord,
  type PaymentRepository,
  paymentInsert,
  type ReconciliationTransition,
} from "./payment-repository.ts";
import {
  asInteger,
  asString,
  OPENRECEIVE_RECONCILE_BATCH_SIZE,
  reconcilableFromRow,
  recordFromRow,
  settlementExpiresAt,
} from "./payment-rows.ts";
import {
  resolveSqlAdapter,
  type SqlAdapter,
  type SqlClient,
  type SqlDatabase,
  type SqlQuery,
  toPgPlaceholders,
} from "./sql-adapters.ts";

/** Namespacing seed for the postgres per-reference advisory lock. */
const ADVISORY_LOCK_SEED = 8_210_223;

/**
 * MySQL's per-reference lock is a row in the meta table, one per bucket of
 * references: every worker on the database must map a reference to the same
 * row, so neither this count nor `mysqlLockKey` may ever change.
 */
const MYSQL_LOCK_BUCKETS = 1_024;

/** The `openreceive_meta` row recording which schema generation is installed. */
const SCHEMA_VERSION_META_KEY = "schema_version";

export { OPENRECEIVE_PAYMENTS_SCHEMA_VERSION } from "@openreceive/core";
export { OPENRECEIVE_RECONCILE_BATCH_SIZE } from "./payment-rows.ts";

/**
 * Dialect-aware "that table is absent" sniffing for the schema-version probe.
 * sqlite (node:sqlite and better-sqlite3) reports "no such table"; postgres
 * raises SQLSTATE 42P01 ("relation ... does not exist"); MySQL and MariaDB
 * raise error 1146 ("Table '...' doesn't exist"). Everything else —
 * connection refused, permissions — is not a migration diagnosis.
 */
function isMissingTableError(error: unknown, dialect: SqlAdapter["dialect"]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (dialect === "postgres") {
    return code === "42P01" || /relation .+ does not exist/i.test(message);
  }
  if (dialect === "mysql") {
    const errno = (error as { errno?: unknown } | null)?.errno;
    return (
      code === "ER_NO_SUCH_TABLE" ||
      errno === 1146 ||
      /\b1146\b|table .+ doesn't exist/i.test(message)
    );
  }
  return /no such table/i.test(message);
}

/**
 * The meta-table row that serializes one reference's transactions on MySQL.
 * A FNV-1a hash of the reference's UTF-8 bytes picks the bucket.
 */
function mysqlLockKey(reference: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(reference)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return `commit_lock:${(hash >>> 0) % MYSQL_LOCK_BUCKETS}`;
}

export interface SqlPaymentsOptions {
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  /** Durable reconcile-gate key/value table name. Default `openreceive_meta`. */
  readonly metaTableName?: string;
  readonly clock?: () => number;
}

/** Settlement context passed to the host's `onPaid` in library-persistence mode. */
export interface PaymentSettlement {
  readonly reference: string;
  readonly paymentHash: string;
  readonly paidAt: number;
  readonly details?: PaymentDetails;
  /**
   * Runs statements inside the settlement transaction. Use it to update the
   * host order or insert a transactional outbox row. Write the placeholders
   * your database uses (`?` on sqlite and mysql, `$1`-style on postgres) —
   * this SQL is yours and reaches the driver exactly as written.
   *
   * OpenReceive already guarantees this hook fires at most once per reference
   * across its own settlement paths. It cannot see fulfillment triggered
   * anywhere else, though —
   * an admin action, a second processor, a replayed job — so if any of those
   * exist, guard the transition here rather than assuming exclusivity:
   *
   * ```sql
   * UPDATE orders SET state = 'paid'
   *  WHERE id = $1 AND state = 'awaiting_payment' RETURNING id
   * ```
   *
   * An empty result means someone else already fulfilled it; return without
   * shipping. `fulfillmentNote` in `@openreceive/core` is the full
   * version, and is what the scaffold writes into every generated file.
   */
  readonly query: SqlQuery;
}

export type PaymentSettlementHook = (settlement: PaymentSettlement) => void | Promise<void>;

/** Nonsecret dry-run report for explicit host/operator review. */
export interface PaymentRepairCandidate {
  readonly paymentHash: string;
  readonly reference: string;
  readonly status: "expired" | "attention";
  readonly statusReason: string | null;
  readonly updatedAt: number;
  readonly instructionExpiresAt: number;
  readonly settlementExpiresAt: number;
  readonly category: "early_swap_closure" | "attention";
}

export interface SqlPaymentRepository extends PaymentRepository<SqlClient> {
  /** Read-only, hash-keyset candidate report; normal routes never call this. */
  listRepairCandidates(input?: {
    after?: string;
    limit?: number;
  }): Promise<{ candidates: readonly PaymentRepairCandidate[]; nextCursor: string | null }>;
  /** Requeue one reviewed row only if its reported status and version still match. */
  requeueAttempt(input: {
    paymentHash: string;
    expectedStatus: "expired" | "attention";
    expectedUpdatedAt: number;
    reason: string;
  }): Promise<boolean>;
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
    fulfill: PaymentSettlementHook,
  ): Promise<boolean>;
}

/**
 * The canonical payment-attempts DDL, rendered as one executable script. The
 * statements themselves live in `@openreceive/core`
 * (`paymentsDdlStatements`) so this helper and the scaffold CLI's
 * ORM migrations can never drift from each other. A mysql2 connection runs a
 * script of several statements only when opened with `multipleStatements`;
 * otherwise run `paymentsSchemaStatements` one at a time.
 */
export function paymentsSchemaSql(
  dialect: PaymentsDialect,
  tableName = "openreceive_payments",
  metaTableName = "openreceive_meta",
): string {
  return paymentsSchemaStatements(dialect, tableName, metaTableName)
    .map((statement) => `${statement};`)
    .join("\n");
}

/** The same DDL as `paymentsSchemaSql`, one statement per entry, without semicolons. */
export function paymentsSchemaStatements(
  dialect: PaymentsDialect,
  tableName = "openreceive_payments",
  metaTableName = "openreceive_meta",
): readonly string[] {
  return paymentsDdlStatements({ dialect, tableName, metaTableName });
}

/**
 * Library-owned payment-attempt repository over the host application's existing
 * database. Owns the commit locking, settlement write-once, and reconciliation
 * state transitions so host applications never implement them.
 */
export function createSqlPayments(
  db: SqlDatabase,
  options: SqlPaymentsOptions = {},
): SqlPaymentRepository {
  const adapter = resolveSqlAdapter(db);
  const table = options.tableName ?? "openreceive_payments";
  assertSafeIdentifier(table);
  const metaTable = options.metaTableName ?? "openreceive_meta";
  assertSafeIdentifier(metaTable);
  const clock = options.clock ?? unixSeconds;
  // Library-authored SQL is rendered for this dialect here, at authoring time.
  // Host SQL (notably the settlement hook's `query`) is never rewritten: a `?`
  // in a literal, a comment, or a postgres JSON operator must survive.
  const statement = (sql: string): string =>
    adapter.dialect === "postgres" ? toPgPlaceholders(sql) : sql;
  const key = paymentsMetaKeyColumn(adapter.dialect);

  const lockReference = async (tx: SqlClient, reference: string): Promise<void> => {
    // SQLite transactions are single-writer (BEGIN IMMEDIATE); postgres and
    // mysql need a per-reference serialization boundary.
    if (adapter.dialect === "postgres") {
      // The lock function returns void, a column type Prisma's raw queries
      // cannot read, so select a constant from it instead.
      await tx.query(
        statement("SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(?, ?))"),
        [reference, ADVISORY_LOCK_SEED],
      );
    } else if (adapter.dialect === "mysql") {
      // A row lock held until commit, not GET_LOCK, which Vitess (PlanetScale)
      // restricts. The upsert creates the bucket's row on first use and takes
      // its exclusive lock either way, so a second transaction on the same
      // bucket waits here until the first commits or rolls back.
      await tx.query(
        `INSERT INTO ${metaTable} (${key}, value, rev) VALUES (?, '', 0) ON DUPLICATE KEY UPDATE rev = rev`,
        [mysqlLockKey(reference)],
      );
    }
  };

  const rowsForReference = async (
    tx: SqlClient,
    reference: string,
  ): Promise<readonly PaymentRecord[]> => {
    const rows = await tx.query(
      statement(
        `SELECT * FROM ${table} WHERE reference = ? ORDER BY created_at DESC, payment_hash DESC`,
      ),
      [reference],
    );
    // A MySQL table made by an ORM keeps the database's default collation,
    // which matches "Order-1" to "order-1": only the exact reference counts.
    return rows.filter((row) => row.reference === reference).map(recordFromRow);
  };

  const referenceOf = async (client: SqlClient, paymentHash: string) => {
    const rows = await client.query(
      statement(`SELECT reference FROM ${table} WHERE payment_hash = ?`),
      [paymentHash],
    );
    return rows[0] === undefined ? undefined : asString(rows[0].reference, "reference");
  };

  /**
   * Runs `run` in a transaction holding the lock of the attempt's reference,
   * or returns `missing` when no attempt has this hash. On MySQL the
   * reference is read before the transaction: REPEATABLE READ fixes a
   * transaction's snapshot at its first read, and a read before the lock
   * would hide a settlement committed while this transaction waited for it.
   * A reference never changes, so reading it first is safe.
   */
  const withAttemptLock = async <T>(
    paymentHash: string,
    missing: T,
    run: (tx: SqlClient, reference: string) => Promise<T>,
  ): Promise<T> => {
    if (adapter.dialect === "mysql") {
      const reference = await referenceOf(adapter, paymentHash);
      if (reference === undefined) return missing;
      return adapter.transaction(async (tx) => {
        await lockReference(tx, reference);
        return run(tx, reference);
      });
    }
    return adapter.transaction(async (tx) => {
      const reference = await referenceOf(tx, paymentHash);
      if (reference === undefined) return missing;
      await lockReference(tx, reference);
      return run(tx, reference);
    });
  };

  // One probe per repository, on first use: a database written by a NEWER
  // library must not be operated by this one (columns or state transitions it
  // does not know about). An unreadable or absent marker means "not versioned"
  // — the pre-versioned migrations could not seed a row — and is not a refusal,
  // EXCEPT when the meta table itself does not exist: that is diagnosable as
  // "the migration never ran here", and saying so beats the raw driver error
  // the first payments query would raise a moment later.
  let schemaVersionChecked: Promise<void> | undefined;
  const assertSupportedSchema = (): Promise<void> => {
    schemaVersionChecked ??= (async () => {
      let stored: number | undefined;
      try {
        const rows = await adapter.query(
          statement(`SELECT value FROM ${metaTable} WHERE ${key} = ? LIMIT 1`),
          [SCHEMA_VERSION_META_KEY],
        );
        const value = rows[0]?.value;
        stored = value === undefined ? undefined : Number(asString(value, "value"));
      } catch (error) {
        // Any other read failure (connection refused, permissions) keeps the
        // silent pre-versioned behavior; the real query surfaces it.
        if (!isMissingTableError(error, adapter.dialect)) return;
        throw new TypeError(
          `The ${metaTable} table does not exist — the OpenReceive tables have not been migrated ` +
            "in this database. Run `npx openreceive scaffold payments --orm <your orm>` and apply " +
            "the emitted migration through your normal workflow (or execute " +
            "paymentsSchemaSql(dialect) directly for bare drivers). " +
            "https://openreceive.org/guides/storage.md",
        );
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

  // Drivers report affected rows differently, so the gate reads its writes back.
  const metaStore: MetaStore = {
    async read(gateKey) {
      const rows = await adapter.query(
        statement(`SELECT value, rev FROM ${metaTable} WHERE ${key} = ? LIMIT 1`),
        [gateKey],
      );
      return rows[0] === undefined ? undefined : { value: rows[0].value, rev: rows[0].rev };
    },
    async insertIfAbsent(gateKey, value) {
      const insert = {
        postgres: `INSERT INTO ${metaTable} (key, value, rev) VALUES (?, ?, 0) ON CONFLICT (key) DO NOTHING`,
        mysql: `INSERT IGNORE INTO ${metaTable} (${key}, value, rev) VALUES (?, ?, 0)`,
        sqlite: `INSERT OR IGNORE INTO ${metaTable} (key, value, rev) VALUES (?, ?, 0)`,
      }[adapter.dialect];
      await adapter.query(statement(insert), [gateKey, value]);
      return undefined;
    },
    async compareAndSet(gateKey, value, rev) {
      await adapter.query(
        statement(`UPDATE ${metaTable} SET value = ?, rev = rev + 1 WHERE ${key} = ? AND rev = ?`),
        [value, gateKey, rev],
      );
      return undefined;
    },
  };

  return {
    async listForReference(reference) {
      await assertSupportedSchema();
      return rowsForReference(adapter, reference);
    },

    async findByPaymentHash(paymentHash) {
      await assertSupportedSchema();
      const rows = await adapter.query(statement(`SELECT * FROM ${table} WHERE payment_hash = ?`), [
        paymentHash.toLowerCase(),
      ]);
      return rows[0] === undefined ? undefined : recordFromRow(rows[0]);
    },

    async listReconcilableAttempts(after) {
      await assertSupportedSchema();
      // Oldest first, one batch per pass: the attempts closest to their closure
      // deadline are always covered, and a backlog drains over several passes
      // instead of widening one wallet scan window without bound.
      const rows = await adapter.query(
        statement(
          `SELECT payment_hash, created_at, checkout_data FROM ${table} WHERE status = 'pending' ${after == null ? "" : "AND (created_at > ? OR (created_at = ? AND payment_hash > ?))"} ORDER BY created_at ASC, payment_hash ASC LIMIT ?`,
        ),
        [
          ...(after == null ? [] : [after.created_at, after.created_at, after.payment_hash]),
          OPENRECEIVE_RECONCILE_BATCH_SIZE,
        ],
      );
      return rows.map(reconcilableFromRow);
    },

    async findPendingAttempt(paymentHash) {
      await assertSupportedSchema();
      // By hash, not by batch position: a notified settlement must not wait for
      // a backlog to drain past it (payment_hash is unique).
      const rows = await adapter.query(
        statement(
          `SELECT payment_hash, created_at, checkout_data FROM ${table} WHERE payment_hash = ? AND status = 'pending'`,
        ),
        [paymentHash.toLowerCase()],
      );
      return rows[0] === undefined ? undefined : reconcilableFromRow(rows[0]);
    },

    async claimReconcileGate(input) {
      await assertSupportedSchema();
      return claimMetaGate(metaStore, input);
    },

    async checkpointReconcileGate(input) {
      await assertSupportedSchema();
      return checkpointMetaGate(metaStore, input);
    },

    async listRepairCandidates({ after = "", limit = 100 } = {}) {
      await assertSupportedSchema();
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new RangeError("Repair report limit must be between 1 and 200.");
      const rows = await adapter.query(
        statement(
          `SELECT payment_hash, reference, status, status_reason, updated_at, expires_at, checkout_data, swap_data IS NOT NULL AS has_swap FROM ${table} WHERE status IN ('expired', 'attention') AND paid_at IS NULL AND payment_hash > ? ORDER BY payment_hash LIMIT ?`,
        ),
        [after, limit],
      );
      return {
        candidates: rows
          .map(repairCandidate)
          .filter((row): row is PaymentRepairCandidate => row !== null),
        nextCursor:
          rows.length === limit ? asString(rows.at(-1)!.payment_hash, "payment_hash") : null,
      };
    },

    async requeueAttempt(input) {
      await assertSupportedSchema();
      if (!input.reason.trim() || input.reason.length > 500)
        throw new TypeError("A reviewed repair reason of 1–500 characters is required.");
      const hash = input.paymentHash.toLowerCase();
      return withAttemptLock(hash, false, async (tx) => {
        const rows = await tx.query(
          statement(
            `SELECT payment_hash, reference, status, status_reason, updated_at, expires_at, checkout_data, swap_data IS NOT NULL AS has_swap FROM ${table} WHERE payment_hash = ? AND paid_at IS NULL`,
          ),
          [hash],
        );
        const row = rows[0];
        if (
          row === undefined ||
          row.status !== input.expectedStatus ||
          asInteger(row.updated_at, "updated_at") !== input.expectedUpdatedAt
        )
          return false;
        const candidate = repairCandidate(row);
        if (candidate === null) return false;
        const auditKey = `payment_repair:${hash}:${input.expectedStatus}:${input.expectedUpdatedAt}`;
        const prior = await tx.query(
          statement(`SELECT ${key} FROM ${metaTable} WHERE ${key} = ?`),
          [auditKey],
        );
        if (prior.length > 0) return false;
        const now = clock();
        // The reference lock also excludes a concurrent settlement. Audit and
        // requeue commit together; replay of the selected version is a no-op.
        await tx.query(
          statement(
            `UPDATE ${table} SET status = 'pending', status_reason = 'operator_requeued', updated_at = ? WHERE payment_hash = ? AND status = ? AND updated_at = ?`,
          ),
          [now, hash, input.expectedStatus, input.expectedUpdatedAt],
        );
        await tx.query(
          statement(`INSERT INTO ${metaTable} (${key}, value, rev) VALUES (?, ?, 0)`),
          [
            auditKey,
            JSON.stringify({ ...candidate, reviewedAt: now, reason: redactSecrets(input.reason) }),
          ],
        );
        return true;
      });
    },

    async commitAttempt(input: CheckoutCreatedInput) {
      await assertSupportedSchema();
      const insert = paymentInsert(input);
      const now = clock();
      await adapter.transaction(async (tx) => {
        await lockReference(tx, insert.reference);
        const existing = await rowsForReference(tx, insert.reference);
        if (existing.some((row) => row.paymentHash === insert.paymentHash)) return;
        if (existing.some((row) => row.status === "settled")) {
          throw hostError("This reference is already paid.", 409, "CONFLICT");
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
              "An unpaid checkout for this payment method is already in progress for this reference.",
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
            `INSERT INTO ${table} (reference, payment_hash, status, paid_at, expires_at, created_at, updated_at, inserted_at, checkout_data, swap_data, client_ip)
           VALUES (?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)`,
          ),
          [
            insert.reference,
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
      await assertSupportedSchema();
      const rows = await adapter.query(
        statement(`SELECT COUNT(*) AS n FROM ${table} WHERE client_ip = ? AND inserted_at >= ?`),
        [clientIp, sinceUnixSeconds],
      );
      return asInteger(rows[0]?.n ?? 0, "n");
    },

    async recordReconciliation(transition: ReconciliationTransition) {
      await assertSupportedSchema();
      await withAttemptLock<void>(transition.paymentHash.toLowerCase(), undefined, async (tx) => {
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

    recordSettlementWithFulfillment: (settlement, fulfill) =>
      markPaidOnce(settlement, ({ query, ...context }) =>
        fulfill({ ...context, transaction: { query } }),
      ),

    markPaidOnce,
  };

  async function markPaidOnce(
    input: { paymentHash: string; paidAt: number; details?: PaymentDetails },
    fulfill: PaymentSettlementHook,
  ): Promise<boolean> {
    await assertSupportedSchema();
    const paymentHash = input.paymentHash.toLowerCase();
    return withAttemptLock(paymentHash, false, async (tx, reference) => {
      const rows = await rowsForReference(tx, reference);
      const row = rows.find((candidate) => candidate.paymentHash === paymentHash);
      if (row === undefined || row.status !== "pending") return false;
      const firstForReference = !rows.some((candidate) => candidate.status === "settled");
      const now = clock();
      await tx.query(
        statement(
          `UPDATE ${table} SET status = 'settled', status_reason = ?, paid_at = ?, updated_at = ? WHERE payment_hash = ?`,
        ),
        [firstForReference ? null : "duplicate_settlement", input.paidAt, now, paymentHash],
      );
      if (firstForReference) {
        await fulfill({
          reference: row.reference,
          paymentHash,
          paidAt: input.paidAt,
          ...(input.details === undefined ? {} : { details: input.details }),
          query: tx.query,
        });
      }
      return firstForReference;
    });
  }
}

function repairCandidate(row: Record<string, unknown>): PaymentRepairCandidate | null {
  if (row.status !== "expired" && row.status !== "attention") return null;
  const expires = settlementExpiresAt(row);
  const instruction = asInteger(row.expires_at, "expires_at");
  const updated = asInteger(row.updated_at, "updated_at");
  const reason = row.status_reason == null ? null : asString(row.status_reason, "status_reason");
  const early =
    Boolean(row.has_swap) &&
    expires > instruction &&
    updated >= instruction + OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS &&
    updated < expires + OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS &&
    ["not_found_after_expiry", "no_finality_after_expiry", "unsettled_after_expiry"].includes(
      reason ?? "",
    );
  if (!early && row.status !== "attention") return null;
  return {
    paymentHash: asString(row.payment_hash, "payment_hash"),
    reference: asString(row.reference, "reference"),
    status: row.status,
    statusReason: reason,
    updatedAt: updated,
    instructionExpiresAt: instruction,
    settlementExpiresAt: expires,
    category: early ? "early_swap_closure" : "attention",
  };
}

function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new RangeError(`Unsafe SQL identifier: ${name}`);
  }
}
