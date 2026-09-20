import { randomUUID } from "node:crypto";
import {
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  paymentsDdlStatements,
  unixSeconds,
  type PaymentDetails,
  OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS,
  redactSecrets,
} from "@openreceive/core";
import type { Checkout, SwapData } from "@openreceive/node";
import { hostError } from "./errors.ts";
import type { CheckoutCreatedInput } from "./handler.ts";
import {
  liveAttemptCommitDecision,
  type AttemptStatus,
  type PaymentRecord,
  type PaymentRepository,
  type ReconcileScheduler,
  type ReconcilableAttempt,
  type ReconciliationTransition,
  paymentInsert,
} from "./payment-repository.ts";
import {
  type SqlClient,
  type SqlDatabase,
  type SqlQuery,
  resolveSqlAdapter,
  toPgPlaceholders,
} from "./sql-adapters.ts";

/** Namespacing seed for the postgres per-reference advisory lock. */
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

export { OPENRECEIVE_PAYMENTS_SCHEMA_VERSION } from "@openreceive/core";

/**
 * Oldest-first page size for one reconciliation pass. A backlog of pending
 * attempts is drained over several passes instead of loading every row (and
 * scanning every invoice's window) in one unbounded query.
 */
export const OPENRECEIVE_RECONCILE_BATCH_SIZE = 200 as const;

/**
 * Dialect-aware "that table is absent" sniffing for the schema-version probe.
 * sqlite (node:sqlite and better-sqlite3) reports "no such table"; postgres
 * raises SQLSTATE 42P01 ("relation ... does not exist"). Everything else —
 * connection refused, permissions — is not a migration diagnosis.
 */
function isMissingTableError(error: unknown, dialect: "postgres" | "sqlite"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (dialect === "postgres") {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "42P01" || /relation .+ does not exist/i.test(message);
  }
  return /no such table/i.test(message);
}

interface StoredGate {
  version: number;
  claimed_at: number;
  token: string;
  lease_until: number;
  interval_seconds: number;
  scheduler: ReconcileScheduler;
}
function parseGate(value: unknown): StoredGate | undefined {
  let gate: StoredGate;
  try {
    gate = JSON.parse(String(value)) as StoredGate;
  } catch {
    return undefined;
  }
  if (gate.version > 1)
    throw new TypeError(
      "A newer reconcile scheduler is installed; upgrade every application and worker together.",
    );
  // Derived legacy state can be discarded; payment rows are never altered.
  return gate.version === 1 ? gate : undefined;
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
   * your database uses (`?` on sqlite, `$1`-style on postgres) — this SQL is
   * yours and reaches the driver exactly as written.
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
 * ORM migrations can never drift from each other.
 */
export function paymentsSchemaSql(
  dialect: "postgres" | "sqlite",
  tableName = "openreceive_payments",
  metaTableName = "openreceive_meta",
): string {
  return paymentsDdlStatements({ dialect, tableName, metaTableName })
    .map((statement) => `${statement};`)
    .join("\n");
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

  const lockReference = async (tx: SqlClient, reference: string): Promise<void> => {
    // SQLite transactions are single-writer (BEGIN IMMEDIATE); postgres needs a
    // per-reference serialization boundary.
    if (adapter.dialect === "postgres") {
      await tx.query(statement("SELECT pg_advisory_xact_lock(hashtextextended(?, ?))"), [
        reference,
        ADVISORY_LOCK_SEED,
      ]);
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
    return rows.map(recordFromRow);
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
          statement(`SELECT value FROM ${metaTable} WHERE key = ? LIMIT 1`),
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
      return rows.map(
        (row): ReconcilableAttempt => ({
          paymentHash: asString(row.payment_hash, "payment_hash"),
          createdAt: asInteger(row.created_at, "created_at"),
          createdAtSource: savedCheckout(row).createdAtSource ?? "host",
          expiresAt: settlementExpiresAt(row),
        }),
      );
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
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        paymentHash: asString(row.payment_hash, "payment_hash"),
        createdAt: asInteger(row.created_at, "created_at"),
        createdAtSource: savedCheckout(row).createdAtSource ?? "host",
        expiresAt: settlementExpiresAt(row),
      };
    },

    async claimReconcileGate({ now, intervalSeconds, leaseSeconds = 10 }) {
      await assertSupportedSchema();
      const token = randomUUID();
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
        const gate = current === undefined ? undefined : parseGate(current.value);
        if (
          gate !== undefined &&
          isFreshTimestamp(
            now,
            gate.claimed_at,
            Math.max(intervalSeconds, gate.interval_seconds ?? 2),
          )
        )
          return null;
        if (
          gate !== undefined &&
          gate.claimed_at <= now + META_CLOCK_SKEW_SECONDS &&
          gate.lease_until > now
        )
          return null;
        const scheduler = gate?.scheduler ?? { cursor: null, windows: [] };
        const claimValue = JSON.stringify({
          version: 1,
          claimed_at: now,
          token,
          lease_until: now + leaseSeconds,
          interval_seconds: intervalSeconds,
          scheduler,
        });
        if (current === undefined) {
          await adapter.query(statement(insertIfAbsent), [RECONCILE_GATE_META_KEY, claimValue]);
        } else {
          await adapter.query(
            statement(`UPDATE ${metaTable} SET value = ?, rev = rev + 1 WHERE key = ? AND rev = ?`),
            [claimValue, RECONCILE_GATE_META_KEY, asInteger(current.rev, "rev")],
          );
        }
        const readback = await adapter.query(
          statement(`SELECT value FROM ${metaTable} WHERE key = ? LIMIT 1`),
          [RECONCILE_GATE_META_KEY],
        );
        if (readback[0] !== undefined && String(readback[0].value) === claimValue)
          return { token, scheduler };
      }
      return null;
    },

    async checkpointReconcileGate({ claim, scheduler, now, release = false, intervalSeconds }) {
      await assertSupportedSchema();
      if (
        scheduler.windows.length > 2 ||
        scheduler.windows.some(
          (window) => window.attempts.length > OPENRECEIVE_RECONCILE_BATCH_SIZE,
        )
      )
        throw new RangeError("Reconcile progress exceeds its cohort bound.");
      const rows = await adapter.query(
        statement(`SELECT value, rev FROM ${metaTable} WHERE key = ? LIMIT 1`),
        [RECONCILE_GATE_META_KEY],
      );
      const current = rows[0];
      if (current === undefined) return false;
      const gate = parseGate(current.value);
      if (gate?.token !== claim.token || gate.lease_until <= now) return false;
      const value = JSON.stringify({
        ...gate,
        scheduler,
        lease_until: release ? 0 : gate.lease_until,
        interval_seconds: intervalSeconds ?? gate.interval_seconds,
      });
      if (new TextEncoder().encode(value).length > 131072)
        throw new RangeError("Reconcile progress exceeds 128 KiB.");
      await adapter.query(
        statement(`UPDATE ${metaTable} SET value = ?, rev = rev + 1 WHERE key = ? AND rev = ?`),
        [value, RECONCILE_GATE_META_KEY, asInteger(current.rev, "rev")],
      );
      const readback = await adapter.query(
        statement(`SELECT value FROM ${metaTable} WHERE key = ? LIMIT 1`),
        [RECONCILE_GATE_META_KEY],
      );
      return readback[0]?.value === value;
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
      return adapter.transaction(async (tx) => {
        const hash = input.paymentHash.toLowerCase();
        const preliminary = await tx.query(
          statement(`SELECT reference FROM ${table} WHERE payment_hash = ?`),
          [hash],
        );
        if (preliminary[0] === undefined) return false;
        await lockReference(tx, asString(preliminary[0].reference, "reference"));
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
        const prior = await tx.query(statement(`SELECT key FROM ${metaTable} WHERE key = ?`), [
          auditKey,
        ]);
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
        await tx.query(statement(`INSERT INTO ${metaTable} (key, value, rev) VALUES (?, ?, 0)`), [
          auditKey,
          JSON.stringify({ ...candidate, reviewedAt: now, reason: redactSecrets(input.reason) }),
        ]);
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
      await adapter.transaction(async (tx) => {
        const rows = await tx.query(
          statement(`SELECT reference FROM ${table} WHERE payment_hash = ?`),
          [transition.paymentHash.toLowerCase()],
        );
        if (rows[0] === undefined) return;
        await lockReference(tx, asString(rows[0].reference, "reference"));
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
    return adapter.transaction(async (tx) => {
      const preliminary = await tx.query(
        statement(`SELECT reference FROM ${table} WHERE payment_hash = ?`),
        [paymentHash],
      );
      const reference = preliminary[0]?.reference;
      if (reference === undefined) return false;
      await lockReference(tx, asString(reference, "reference"));
      const rows = await rowsForReference(tx, asString(reference, "reference"));
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

/** True when `timestamp` is inside `windowSeconds` of `now`, allowing for skew. */
function isFreshTimestamp(now: number, timestamp: number, windowSeconds: number): boolean {
  const age = now - timestamp;
  // A timestamp far in the future is a clock that stepped backwards, not a
  // fresh write: clamping it to stale keeps a rewound clock from freezing the
  // gate until wall-clock time catches up.
  if (age < -META_CLOCK_SKEW_SECONDS) return false;
  return age < windowSeconds;
}

function recordFromRow(row: Record<string, unknown>): PaymentRecord {
  const swapData = row.swap_data;
  const paymentHash = asString(row.payment_hash, "payment_hash");
  return {
    reference: asString(row.reference, "reference"),
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
    ) as Checkout,
    swapData:
      swapData === null || swapData === undefined
        ? null
        : (parseRowJson(asString(swapData, "swap_data"), "swap_data", paymentHash) as SwapData),
  };
}

/** The saved invoice, rather than the reusable deposit instructions, sets this deadline. */
function savedCheckout(row: Record<string, unknown>): Checkout {
  const hash = asString(row.payment_hash, "payment_hash");
  const checkout = parseRowJson(
    asString(row.checkout_data, "checkout_data"),
    "checkout_data",
    hash,
  );
  if (typeof checkout === "object" && checkout !== null) {
    const value = (checkout as Checkout).expiresAt;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      return checkout as Checkout;
  }
  throw new TypeError(
    `Invalid checkout_data invoice expiry on openreceive payment attempt ${hash}.`,
  );
}
function settlementExpiresAt(row: Record<string, unknown>): number {
  return savedCheckout(row).expiresAt;
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

const ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  "pending",
  "settled",
  "expired",
  "failed",
  "attention",
];

function asStatus(value: unknown): AttemptStatus {
  if (typeof value === "string" && (ATTEMPT_STATUSES as readonly string[]).includes(value)) {
    return value as AttemptStatus;
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
