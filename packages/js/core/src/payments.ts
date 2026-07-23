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
  readonly clock?: () => number;
  /** Optional creation-time lower bound for wallets without lookup_invoice. */
  readonly from?: number;
  readonly until?: number;
  readonly maxPages?: number;
}

export interface ScanPaymentsOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly clock?: () => number;
  readonly from?: number;
  readonly until?: number;
  readonly maxPages?: number;
  readonly includeUnpaid?: boolean;
}

export async function checkPayment(options: CheckPaymentOptions): Promise<PaymentCheck> {
  const paymentHash = normalizePaymentHash(options.paymentHash);
  const observedAt = (options.clock ?? currentUnixSeconds)();
  let transaction: NwcTransaction | undefined;

  if (options.client.lookupInvoice !== undefined) {
    try {
      transaction = await options.client.lookupInvoice({ payment_hash: paymentHash });
    } catch {
      // lookup_invoice is optional in NIP-47 and some wallets advertise it but reject
      // particular requests. list_transactions remains the portable recovery path.
    }
  }

  transaction ??= await findTransactionByPaymentHash({
    client: options.client,
    paymentHash,
    from: options.from,
    until: options.until,
    maxPages: options.maxPages,
  });

  if (transaction === undefined) {
    return { paymentHash, status: "not_found" };
  }
  return paymentCheckFromTransaction(paymentHash, transaction, observedAt);
}

export async function scanSettledPayments(
  options: ScanPaymentsOptions,
): Promise<readonly PaidPayment[]> {
  const transactions = await listIncomingTransactions(options);
  const observedAt = (options.clock ?? currentUnixSeconds)();
  const settled = new Map<string, PaidPayment>();
  for (const transaction of transactions) {
    if (transaction.payment_hash === undefined) continue;
    const paymentHash = normalizePaymentHash(transaction.payment_hash);
    const checked = paymentCheckFromTransaction(paymentHash, transaction, observedAt);
    if (checked.status !== "settled" || checked.paidAt === undefined) continue;
    settled.set(paymentHash, {
      paymentHash,
      paidAt: checked.paidAt,
      details: checked.details,
    });
  }
  return [...settled.values()];
}

export async function findTransactionByPaymentHash(
  options: ScanPaymentsOptions & { readonly paymentHash: string },
): Promise<NwcTransaction | undefined> {
  const expected = normalizePaymentHash(options.paymentHash);
  const transactions = await listIncomingTransactions(options);
  const settled = transactions.find(
    (transaction) => transaction.payment_hash?.toLowerCase() === expected,
  );
  if (settled !== undefined || options.includeUnpaid === true) return settled;
  // NIP-47's `unpaid` filter is wallet-dependent: some implementations return
  // only pending invoices when it is true. Search the settled/default view first,
  // then the unpaid view so a known hash can be recovered in either state.
  const unpaid = await listIncomingTransactions({ ...options, includeUnpaid: true });
  return unpaid.find(
    (transaction) => transaction.payment_hash?.toLowerCase() === expected,
  );
}

export async function listIncomingTransactions(
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

export function paymentCheckFromTransaction(
  paymentHash: string,
  transaction: NwcTransaction,
  observedAt: number,
): PaymentCheck {
  const detection = classifyTransactionSettlement(transaction);
  const status: PaymentStatus = detection.status;
  const paidAt = status === "settled" ? transaction.settled_at ?? observedAt : undefined;
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

function normalizeUnix(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
