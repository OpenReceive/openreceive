import type {
  ListTransactionsRequest,
  NwcTransaction,
  OpenReceiveReceiveNwcClient,
} from "./nwc/client.ts";
import { classifyTransactionSettlement } from "./settlement/index.ts";

export const OPENRECEIVE_TRANSACTION_PAGE_LIMIT = 20 as const;

export type PaymentStatus = "pending" | "settled" | "expired" | "failed" | "not_found";

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

export interface CheckPaymentOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly paymentHash: string;
  /** Exact NIP-47 invoice creation time returned by make_invoice. */
  readonly createdAt: number;
  readonly clock?: () => number;
  readonly until?: number;
  readonly overlapSeconds?: number;
  readonly maxPages?: number;
}

interface ScanPaymentsOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly clock?: () => number;
  readonly from?: number;
  readonly until?: number;
  readonly maxPages?: number;
  readonly includeUnpaid?: boolean;
}

export interface ReconcilePaymentAttempt {
  readonly paymentHash: string;
  /** Exact NIP-47 invoice creation time returned by make_invoice. */
  readonly createdAt: number;
}

export interface ReconcilePaymentsOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly attempts: readonly ReconcilePaymentAttempt[];
  readonly clock?: () => number;
  readonly overlapSeconds?: number;
  readonly until?: number;
  readonly maxPages?: number;
}

export async function checkPayment(options: CheckPaymentOptions): Promise<PaymentCheck> {
  const [checked] = await reconcilePaymentAttempts({
    client: options.client,
    attempts: [{ paymentHash: options.paymentHash, createdAt: options.createdAt }],
    clock: options.clock,
    until: options.until,
    overlapSeconds: options.overlapSeconds,
    maxPages: options.maxPages,
  });
  if (checked === undefined) throw new Error("payment reconciliation returned no result");
  return checked;
}

/**
 * Reconcile many known host attempts with at most two wallet-history scans:
 * settled/default results first, then the inclusive unpaid view for pending
 * invoices. This avoids one complete list_transactions walk per payment hash.
 */
export async function reconcilePaymentAttempts(
  options: ReconcilePaymentsOptions,
): Promise<readonly PaymentCheck[]> {
  if (options.attempts.length === 0) return [];
  const overlapSeconds = options.overlapSeconds ?? 60;
  if (!Number.isSafeInteger(overlapSeconds) || overlapSeconds < 0) {
    throw new RangeError("overlapSeconds must be a non-negative safe integer");
  }
  const expected = new Map(
    options.attempts.map((attempt) => [
      normalizePaymentHash(attempt.paymentHash),
      normalizeUnix(attempt.createdAt, "createdAt"),
    ]),
  );
  const from = Math.max(0, Math.min(...expected.values()) - overlapSeconds);
  const until = options.until ?? (options.clock ?? currentUnixSeconds)();
  const settledRows = await listIncomingTransactions({
    client: options.client,
    from,
    until,
    maxPages: options.maxPages,
  });
  const byHash = transactionMap(settledRows);
  const missing = [...expected.keys()].filter((paymentHash) => !byHash.has(paymentHash));
  if (missing.length > 0) {
    const inclusiveRows = await listIncomingTransactions({
      client: options.client,
      from,
      until,
      maxPages: options.maxPages,
      includeUnpaid: true,
    });
    for (const [paymentHash, transaction] of transactionMap(inclusiveRows)) {
      if (!byHash.has(paymentHash)) byHash.set(paymentHash, transaction);
    }
  }
  const observedAt = (options.clock ?? currentUnixSeconds)();
  return [...expected.keys()].map((paymentHash) => {
    const transaction = byHash.get(paymentHash);
    return transaction === undefined
      ? { paymentHash, status: "not_found" }
      : paymentCheckFromTransaction(paymentHash, transaction, observedAt);
  });
}

async function listIncomingTransactions(
  options: ScanPaymentsOptions,
): Promise<readonly NwcTransaction[]> {
  const maxPages = normalizeMaxPages(options.maxPages);
  const byPaymentHash = new Map<string, NwcTransaction>();
  const withoutHash: NwcTransaction[] = [];
  let offset = 0;

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
      if (transaction.payment_hash === undefined) {
        withoutHash.push(transaction);
      } else {
        byPaymentHash.set(transaction.payment_hash.toLowerCase(), transaction);
      }
    }
    if (page.transactions.length < OPENRECEIVE_TRANSACTION_PAGE_LIMIT) break;
    offset += OPENRECEIVE_TRANSACTION_PAGE_LIMIT;
  }
  return [...byPaymentHash.values(), ...withoutHash];
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
    throw new RangeError("paymentHash must be 64 hexadecimal characters");
  }
  return normalized;
}

function normalizeMaxPages(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxPages must be a positive safe integer");
  }
  return value;
}

function transactionMap(transactions: readonly NwcTransaction[]): Map<string, NwcTransaction> {
  const byHash = new Map<string, NwcTransaction>();
  for (const transaction of transactions) {
    if (transaction.payment_hash === undefined) continue;
    byHash.set(normalizePaymentHash(transaction.payment_hash), transaction);
  }
  return byHash;
}

function normalizeUnix(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
