import type { Checkout, SwapData } from "@openreceive/node";
import type { AttemptStatus, PaymentRecord, ReconcilableAttempt } from "./payment-repository.ts";

// Reading `openreceive_payments` rows back into records, shared by every
// library repository (SQL drivers and Supabase's HTTPS API) so a column is
// parsed one way whichever road the row came in on.

/**
 * Oldest-first page size for one reconciliation pass. A backlog of pending
 * attempts is drained over several passes instead of loading every row (and
 * scanning every invoice's window) in one unbounded query.
 */
export const OPENRECEIVE_RECONCILE_BATCH_SIZE = 200 as const;

export function recordFromRow(row: Record<string, unknown>): PaymentRecord {
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

/** A pending row (`payment_hash`, `created_at`, `checkout_data`) as a scan candidate. */
export function reconcilableFromRow(row: Record<string, unknown>): ReconcilableAttempt {
  return {
    paymentHash: asString(row.payment_hash, "payment_hash"),
    createdAt: asInteger(row.created_at, "created_at"),
    createdAtSource: savedCheckout(row).createdAtSource ?? "host",
    expiresAt: settlementExpiresAt(row),
  };
}

/** The saved invoice, rather than the reusable deposit instructions, sets this deadline. */
function savedCheckout(
  row: Record<string, unknown>,
): Pick<Checkout, "expiresAt" | "createdAtSource"> {
  const hash = asString(row.payment_hash, "payment_hash");
  const checkout = parseRowJson(
    asString(row.checkout_data, "checkout_data"),
    "checkout_data",
    hash,
  );
  if (typeof checkout === "object" && checkout !== null) {
    const saved = checkout as Record<string, unknown>;
    const value = saved.expiresAt ?? saved.expires_at;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      return {
        expiresAt: value,
        createdAtSource:
          (saved.createdAtSource ?? saved.created_at_source) === "wallet" ? "wallet" : "host",
      };
  }
  throw new TypeError(
    `Invalid checkout_data invoice expiry on openreceive payment attempt ${hash}.`,
  );
}
export function settlementExpiresAt(row: Record<string, unknown>): number {
  return savedCheckout(row).expiresAt;
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

export function asString(value: unknown, field: string): string {
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
export function asInteger(value: unknown, field: string): number {
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
