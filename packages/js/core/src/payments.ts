import { DecimalError } from "./money/decimal.ts";
import type { ListTransactionsRequest, NwcTransaction, ReceiveNwcClient } from "./nwc/client.ts";
import {
  type TransactionSettlementStatus,
  classifyTransactionSettlement,
} from "./settlement/index.ts";
import { unixSeconds } from "./values.ts";

const OPENRECEIVE_TRANSACTION_PAGE_LIMIT = 20 as const;

/** {@link TransactionSettlementStatus} plus `not_found`: the hash was not in the scanned window. */
export type PaymentStatus = TransactionSettlementStatus | "not_found";

export interface PaymentDetails {
  readonly transaction: NwcTransaction;
  readonly observed_at: number;
  readonly paid_at_source?: "settled_at" | "observed_at";
}

export interface PaymentCheck {
  readonly paymentHash: string;
  readonly status: PaymentStatus;
  readonly paidAt?: number;
  readonly details?: PaymentDetails;
}

export interface PaidPayment {
  readonly paymentHash: string;
  readonly paidAt: number;
  readonly details?: PaymentDetails;
}

interface ScanPaymentsOptions {
  readonly client: ReceiveNwcClient;
  readonly from?: number;
  readonly until?: number;
  readonly maxPages?: number;
  readonly includeUnpaid?: boolean;
  /** Hashes the walk is looking for; it stops as soon as every one is seen. */
  readonly expected: ReadonlySet<string>;
}

interface TransactionScan {
  readonly byPaymentHash: Map<string, NwcTransaction>;
  /**
   * The walk ended before the wallet ran out of rows — the page cap was
   * reached, or the wallet ignored `offset` and repeated a page. A hash such a
   * walk did not see is unproven, never proven absent.
   */
  readonly truncated: boolean;
}

export interface ReconcilePaymentAttempt {
  readonly paymentHash: string;
  /** Exact NIP-47 invoice creation time returned by make_invoice. */
  readonly createdAt: number;
}

export interface ReconcilePaymentsOptions {
  readonly client: ReceiveNwcClient;
  readonly attempts: readonly ReconcilePaymentAttempt[];
  readonly clock?: () => number;
  readonly overlapSeconds?: number;
  readonly until?: number;
  readonly maxPages?: number;
  /** Observes each wallet-history walk of the pass (diagnostics only). */
  readonly onWalk?: (walk: {
    readonly from: number;
    readonly until: number;
    readonly includeUnpaid: boolean;
  }) => void;
}

/**
 * Reconcile many known host attempts with at most two wallet-history scans:
 * settled/default results first, then the inclusive unpaid view for pending
 * invoices. This avoids one complete list_transactions walk per payment hash.
 *
 * Results carry the NORMALIZED (trimmed, lowercase) payment hash, and attempts
 * that normalize to the same hash collapse into one result — so `results` may
 * be shorter than `attempts` and must be matched by hash, never by index.
 *
 * A hash the walk could not decide is OMITTED rather than reported
 * `not_found`: when the page cap (or a wallet that ignored `offset`) cut the
 * walk short, absence is unproven, and reporting `not_found` would let a
 * caller close a paid attempt. Omitted hashes are simply retried next pass.
 */
export async function reconcilePaymentAttempts(
  options: ReconcilePaymentsOptions,
): Promise<readonly PaymentCheck[]> {
  if (options.attempts.length === 0) return [];
  const overlapSeconds = options.overlapSeconds ?? 60;
  if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0) {
    throw new DecimalError("overlapSeconds must be a non-negative safe integer");
  }
  const expected = new Map(
    options.attempts.map((attempt) => [
      normalizePaymentHash(attempt.paymentHash),
      normalizeUnix(attempt.createdAt, "createdAt"),
    ]),
  );
  const from = Math.max(0, Math.min(...expected.values()) - overlapSeconds);
  // Both ends of the window are padded: `from` against a wallet clock that
  // lags, `until` against one that runs ahead — an unpadded `until` on the
  // host clock hides an invoice the wallet just stamped into the future.
  const until = options.until ?? (options.clock ?? unixSeconds)() + overlapSeconds;
  options.onWalk?.({ from, until, includeUnpaid: false });
  const settled = await listIncomingTransactions({
    client: options.client,
    from,
    until,
    maxPages: options.maxPages,
    expected: new Set(expected.keys()),
  });
  const byHash = settled.byPaymentHash;
  const missing = [...expected.keys()].filter((paymentHash) => !byHash.has(paymentHash));
  let truncated = false;
  if (missing.length > 0) {
    options.onWalk?.({ from, until, includeUnpaid: true });
    const inclusive = await listIncomingTransactions({
      client: options.client,
      from,
      until,
      maxPages: options.maxPages,
      includeUnpaid: true,
      expected: new Set(missing),
    });
    truncated = settled.truncated || inclusive.truncated;
    for (const [paymentHash, transaction] of inclusive.byPaymentHash) {
      if (!byHash.has(paymentHash)) byHash.set(paymentHash, transaction);
    }
  }
  const observedAt = (options.clock ?? unixSeconds)();
  const checks: PaymentCheck[] = [];
  for (const paymentHash of expected.keys()) {
    const transaction = byHash.get(paymentHash);
    if (transaction === undefined) {
      if (truncated) continue;
      checks.push({ paymentHash, status: "not_found" });
      continue;
    }
    checks.push(paymentCheckFromTransaction(paymentHash, transaction, observedAt));
  }
  return checks;
}

async function listIncomingTransactions(options: ScanPaymentsOptions): Promise<TransactionScan> {
  const maxPages = normalizeMaxPages(options.maxPages);
  const byPaymentHash = new Map<string, NwcTransaction>();
  const outstanding = new Set(options.expected);
  let offset = 0;
  let previousPage: string | undefined;
  // Proven false the moment the wallet runs out of rows or every expected hash
  // is accounted for; otherwise the walk hit its cap with rows still to come.
  let truncated = true;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const request: ListTransactionsRequest = {
      type: "incoming",
      limit: OPENRECEIVE_TRANSACTION_PAGE_LIMIT,
      offset,
      ...(options.includeUnpaid === true ? { unpaid: true } : {}),
      ...(options.from === undefined ? {} : { from: normalizeUnix(options.from, "from") }),
      ...(options.until === undefined ? {} : { until: normalizeUnix(options.until, "until") }),
    };
    const page = await options.client.listTransactions(request);
    for (const transaction of page.transactions) {
      if (transaction.type !== undefined && transaction.type !== "incoming") continue;
      const paymentHash = normalizedTransactionHash(transaction);
      if (paymentHash === undefined) continue;
      byPaymentHash.set(paymentHash, transaction);
      outstanding.delete(paymentHash);
    }
    if (outstanding.size === 0) {
      truncated = false;
      break;
    }
    if (page.transactions.length < OPENRECEIVE_TRANSACTION_PAGE_LIMIT) {
      truncated = false;
      break;
    }
    // A wallet that ignores `offset` serves the same page forever; stop instead
    // of paging to the cap, and keep the scan marked incomplete.
    const pageKey = page.transactions
      .map((transaction) => transaction.payment_hash ?? "")
      .join(",");
    if (pageKey === previousPage) break;
    previousPage = pageKey;
    offset += OPENRECEIVE_TRANSACTION_PAGE_LIMIT;
  }
  return { byPaymentHash, truncated };
}

function paymentCheckFromTransaction(
  paymentHash: string,
  transaction: NwcTransaction,
  observedAt: number,
): PaymentCheck {
  const detection = classifyTransactionSettlement(transaction);
  const status: PaymentStatus = detection.status;
  const paidAt = status === "settled" ? (transaction.settled_at ?? observedAt) : undefined;
  const details: PaymentDetails = {
    transaction: safeTransaction(transaction),
    observed_at: observedAt,
    ...(status !== "settled"
      ? {}
      : { paid_at_source: transaction.settled_at === undefined ? "observed_at" : "settled_at" }),
  };
  return {
    paymentHash,
    status,
    ...(paidAt === undefined ? {} : { paidAt }),
    details,
  };
}

function safeTransaction(transaction: NwcTransaction): NwcTransaction {
  // NwcTransaction deliberately contains no connection strings or provider secrets.
  return structuredClone(transaction);
}

function normalizePaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new DecimalError("paymentHash must be 64 hexadecimal characters");
  }
  return normalized;
}

function normalizeMaxPages(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DecimalError("maxPages must be a positive safe integer");
  }
  return value;
}

/**
 * The scan key for one wallet row, or undefined when the row can never match
 * an attempt. A wallet-supplied row with a missing or malformed hash is
 * skipped rather than rejected, so one quirky row cannot livelock
 * reconciliation — pending attempts could then neither settle nor close.
 */
function normalizedTransactionHash(transaction: NwcTransaction): string | undefined {
  if (transaction.payment_hash === undefined) return undefined;
  const paymentHash = transaction.payment_hash.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(paymentHash) ? paymentHash : undefined;
}

function normalizeUnix(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DecimalError(`${field} must be a non-negative safe integer`);
  }
  return value;
}
