import { randomUUID } from "node:crypto";
import {
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  paymentsDdlStatements,
  unixSeconds,
  type PaymentDetails,
} from "@openreceive/core";
import type { Checkout, SwapData } from "@openreceive/node";
import { hostError } from "./errors.ts";
import type { CheckoutCreatedInput } from "./handler.ts";
import {
  liveAttemptCommitDecision,
  type AttemptStatus,
  type PaymentRecord,
  type PaymentRepository,
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

export { OPENRECEIVE_PAYMENTS_SCHEMA_VERSION } from "@openreceive/core";

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

export interface SqlPaymentsOptions {
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  /** Durable reconcile-gate key/value table name. Default `openreceive_meta`. */
  readonly metaTableName?: string;
  readonly clock?: () => number;
}

/** Settlement context passed to the host's `onPaid` in library-persistence mode. */
export interface OrderSettlement {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly paidAt: number;
  readonly details?: PaymentDetails;
  /**
   * Runs statements inside the settlement transaction. Use it to update the
   * host order or insert a transactional outbox row. Write the placeholders
   * your database uses (`?` on sqlite, `$1`-style on postgres) — this SQL is
   * yours and reaches the driver exactly as written.
   *
   * OpenReceive already guarantees this hook fires at most once per order
   * across its own settlement paths, and it never reads or locks the host's
   * order table. It cannot see fulfillment triggered anywhere else, though —
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

export type OrderSettlementHook = (settlement: OrderSettlement) => void | Promise<void>;

export interface SqlPaymentRepository extends PaymentRepository {
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
    fulfill: OrderSettlementHook,
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

  const lockOrder = async (tx: SqlClient, orderId: string): Promise<void> => {
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
    tx: SqlClient,
    orderId: string,
  ): Promise<readonly PaymentRecord[]> => {
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
        (row): ReconcilableAttempt => ({
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
      const insert = paymentInsert(input);
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
              "An unpaid checkout for this payment method is already in progress for this order.",
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

    async recordReconciliation(transition: ReconciliationTransition) {
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
    fulfill: OrderSettlementHook,
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
    ) as Checkout,
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
