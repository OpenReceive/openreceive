import type {
  ListTransactionsRequest,
  ListTransactionsResult,
  NwcTransaction,
  OpenReceiveReceiveNwcClient
} from "../nwc/client.ts";
import { classifyTransactionSettlement } from "../settlement/index.ts";
import {
  isTerminalInvoiceStorageRow,
  type InvoiceStorageRow,
  type MaybePromise
} from "../storage/index.ts";
import type {
  OpenReceiveInvoiceKvStore,
  StoredRecord
} from "../storage/kv.ts";
import {
  applyExpiredClosed,
  applyFailedClosed,
  applySettlementActionCompleted,
  applySettled,
  applyVerifying,
  claimSettlementAction,
  clearSettlementActionClaim,
  markTransactionScanAttempted
} from "../state/transitions.ts";

export type OpenReceiveReconcileEventName =
  | "invoice.verifying"
  | "invoice.settled"
  | "invoice.expired"
  | "invoice.failed"
  | "invoice.settlement_action_completed"
  | "transaction_scan.failed";

export interface OpenReceiveReconcileEvent {
  event: OpenReceiveReconcileEventName;
  invoice: InvoiceStorageRow;
  transaction?: NwcTransaction;
  reason?: string;
}

export interface OpenReceiveSettlementActionInput {
  invoice: InvoiceStorageRow;
  metadata: Record<string, unknown>;
  source: "status";
  transaction?: NwcTransaction;
}

export interface OpenReceiveReconcileOptions {
  store: OpenReceiveInvoiceKvStore;
  client: OpenReceiveReceiveNwcClient;
  settlementAction?: (input: OpenReceiveSettlementActionInput) => MaybePromise<void>;
  onEvent?: (event: OpenReceiveReconcileEvent) => MaybePromise<void>;
  clock?: () => number;
  actionLeaseTtlSeconds?: number;
  transactionScanIntervalSeconds?: number;
  transactionScanPageLimit?: number;
  transactionScanWindowPaddingSeconds?: number;
  transactionScanTimeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export type OpenReceiveStatusRefreshStatus =
  | "updated"
  | "stored"
  | "leased"
  | "conflict";

export interface OpenReceiveStatusRefreshResult {
  status: OpenReceiveStatusRefreshStatus;
  record: StoredRecord;
  wallet_scan_performed: boolean;
  transactions_checked: number;
  reason?:
    | "already_final"
    | "transaction_scan_claim_conflict"
    | "settlement_action_completed"
    | "settlement_action_leased"
    | "wallet_settled"
    | "wallet_expired"
    | "wallet_failed"
    | "wallet_pending"
    | "wallet_no_match"
    | "wallet_scan_failed";
}

export interface OpenReceiveOrderStatusRefreshResult {
  records: StoredRecord[];
  wallet_scan_performed: boolean;
  transactions_checked: number;
  reason?: OpenReceiveStatusRefreshResult["reason"];
}

interface TransactionScanCursor {
  from: number;
  until: number;
  limit: number;
  offset: number;
  cycle: number;
  last_page_scanned_at?: number;
}

const DEFAULT_ACTION_LEASE_TTL_SECONDS = 60;
const DEFAULT_TRANSACTION_SCAN_INTERVAL_SECONDS = 2;
const DEFAULT_TRANSACTION_SCAN_PAGE_LIMIT = 25;
const MAX_TRANSACTION_SCAN_PAGE_LIMIT = 50;
const DEFAULT_TRANSACTION_SCAN_WINDOW_PADDING_SECONDS = 0;
const DEFAULT_TRANSACTION_SCAN_TIMEOUT_MS = 9000;
const TRANSACTION_SCAN_GATE_META_KEY = "transaction_scan_gate";

export async function refreshStoredInvoiceStatus(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
}): Promise<OpenReceiveStatusRefreshResult> {
  const now = getNow(input);
  let record = input.record;

  if (isTerminalInvoiceStorageRow(record.row)) {
    return stored(record, "already_final");
  }

  if (record.row.transaction_state === "settled") {
    const action = await runSettlementAction({
      ...input,
      record,
      now
    });
    return {
      ...action,
      wallet_scan_performed: false,
      transactions_checked: 0
    };
  }

  if (!isTransactionScanEligible(record.row, now)) {
    return stored(record, "already_final");
  }

  if (!await claimTransactionScanGate(input, now)) {
    return stored(record, "transaction_scan_claim_conflict");
  }

  const window = invoiceScanWindow(record.row, input);
  const cursor = await readTransactionScanCursor(input.store, window);
  const request: ListTransactionsRequest = {
    type: "incoming",
    unpaid: true,
    from: cursor.from,
    until: cursor.until,
    limit: cursor.limit,
    offset: cursor.offset
  };

  let page: ListTransactionsResult;
  try {
    page = await withTimeout(
      input.client.listTransactions(request),
      normalizePositiveInteger(
        input.transactionScanTimeoutMs ?? DEFAULT_TRANSACTION_SCAN_TIMEOUT_MS,
        "transactionScanTimeoutMs"
      ),
      input
    );
  } catch {
    await emitEvent(input, {
      event: "transaction_scan.failed",
      invoice: record.row,
      reason: "wallet_scan_failed"
    });
    return {
      status: "stored",
      record,
      wallet_scan_performed: false,
      transactions_checked: 0,
      reason: "wallet_scan_failed"
    };
  }

  const claim = await input.store.put(markTransactionScanAttempted(record, now), record.rev);
  if (claim.status === "ok") record = claim.record;

  const applyResult = await applyTransactionPage({
    ...input,
    requested: record,
    transactions: page.transactions,
    now
  });
  await advanceTransactionScanCursor(input.store, cursor, page.transactions.length, now);

  const latest = await input.store.get(record.row.invoice_id) ?? record;
  return {
    status: applyResult.status,
    record: latest,
    wallet_scan_performed: true,
    transactions_checked: page.transactions.length,
    reason: applyResult.reason
  };
}

export async function refreshStoredInvoiceRecordsStatus(input: OpenReceiveReconcileOptions & {
  records: readonly StoredRecord[];
}): Promise<OpenReceiveOrderStatusRefreshResult> {
  const now = getNow(input);
  const records = [...input.records];
  const nonTerminal = records.filter((record) => !isTerminalInvoiceStorageRow(record.row));

  const settled = nonTerminal.filter((record) => record.row.transaction_state === "settled");
  if (settled.length > 0) {
    for (const record of settled) {
      await runSettlementAction({
        ...input,
        record,
        now
      });
    }
    return {
      records: await refreshRecords(input.store, records),
      wallet_scan_performed: false,
      transactions_checked: 0,
      reason: "settlement_action_completed"
    };
  }

  const scanEligible = nonTerminal.filter((record) => isTransactionScanEligible(record.row, now));

  if (scanEligible.length === 0) {
    return {
      records,
      wallet_scan_performed: false,
      transactions_checked: 0,
      reason: "already_final"
    };
  }

  if (!await claimTransactionScanGate(input, now)) {
    return {
      records,
      wallet_scan_performed: false,
      transactions_checked: 0,
      reason: "transaction_scan_claim_conflict"
    };
  }

  const window = invoiceScanWindowForRecords(scanEligible.map((record) => record.row), input);
  const cursor = await readTransactionScanCursor(input.store, window);
  const request: ListTransactionsRequest = {
    type: "incoming",
    unpaid: true,
    from: cursor.from,
    until: cursor.until,
    limit: cursor.limit,
    offset: cursor.offset
  };

  let page: ListTransactionsResult;
  try {
    page = await withTimeout(
      input.client.listTransactions(request),
      normalizePositiveInteger(
        input.transactionScanTimeoutMs ?? DEFAULT_TRANSACTION_SCAN_TIMEOUT_MS,
        "transactionScanTimeoutMs"
      ),
      input
    );
  } catch {
    await emitEvent(input, {
      event: "transaction_scan.failed",
      invoice: nonTerminal[0].row,
      reason: "wallet_scan_failed"
    });
    return {
      records,
      wallet_scan_performed: false,
      transactions_checked: 0,
      reason: "wallet_scan_failed"
    };
  }

  for (const record of nonTerminal) {
    const claim = await input.store.put(markTransactionScanAttempted(record, now), record.rev);
    if (claim.status === "conflict") continue;
  }

  const applyResult = await applyTransactionPageForRecords({
    ...input,
    records: nonTerminal,
    transactions: page.transactions,
    now
  });
  await advanceTransactionScanCursor(input.store, cursor, page.transactions.length, now);

  return {
    records: await refreshRecords(input.store, records),
    wallet_scan_performed: true,
    transactions_checked: page.transactions.length,
    reason: applyResult.reason
  };
}

export async function runSettlementAction(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
  now?: number;
  transaction?: NwcTransaction;
}): Promise<Omit<OpenReceiveStatusRefreshResult, "wallet_scan_performed" | "transactions_checked">> {
  const now = input.now ?? getNow(input);
  let record = input.record;

  if (
    record.row.workflow_state === "settlement_action_completed" ||
    record.row.settlement_action_state === "completed"
  ) {
    return {
      status: "stored",
      record,
      reason: "already_final"
    };
  }

  const leaseTtl = normalizePositiveInteger(
    input.actionLeaseTtlSeconds ?? DEFAULT_ACTION_LEASE_TTL_SECONDS,
    "actionLeaseTtlSeconds"
  );
  if (
    record.row.action_claimed_at !== undefined &&
    now - record.row.action_claimed_at < leaseTtl
  ) {
    return {
      status: "leased",
      record,
      reason: "settlement_action_leased"
    };
  }

  const claim = await input.store.put(claimSettlementAction(record, now), record.rev);
  if (claim.status === "conflict") {
    return {
      status: "conflict",
      record: claim.record,
      reason: "settlement_action_leased"
    };
  }

  record = claim.record;

  try {
    await input.settlementAction?.({
      invoice: record.row,
      metadata: record.row.metadata,
      source: "status",
      transaction: input.transaction
    });
  } catch (error) {
    await input.store.put(clearSettlementActionClaim(record), record.rev);
    throw error;
  }

  const completed = await input.store.put(
    applySettlementActionCompleted(record, now),
    record.rev
  );
  const finalRecord = completed.record;
  await emitEvent(input, {
    event: "invoice.settlement_action_completed",
    invoice: finalRecord.row,
    transaction: input.transaction
  });

  return {
    status: "updated",
    record: finalRecord,
    reason: "settlement_action_completed"
  };
}

async function applyTransactionPageForRecords(input: OpenReceiveReconcileOptions & {
  records: readonly StoredRecord[];
  transactions: readonly NwcTransaction[];
  now: number;
}): Promise<Pick<OpenReceiveStatusRefreshResult, "reason">> {
  const invoiceIds = new Set(input.records.map((record) => record.row.invoice_id));
  let orderMatched = false;
  let orderReason: OpenReceiveStatusRefreshResult["reason"] = "wallet_no_match";

  for (const transaction of input.transactions) {
    if (transaction.type !== undefined && transaction.type !== "incoming") continue;

    const record = await findTransactionRecord(input.store, transaction);
    if (record === undefined || isTerminalInvoiceStorageRow(record.row)) continue;

    const result = await applyTransactionResult({
      ...input,
      record,
      transaction
    });
    if (invoiceIds.has(record.row.invoice_id)) {
      orderMatched = true;
      if (result.reason === "wallet_settled" || orderReason === "wallet_no_match") {
        orderReason = result.reason;
      }
    }
  }

  return {
    reason: orderMatched ? orderReason : "wallet_no_match"
  };
}

async function applyTransactionPage(input: OpenReceiveReconcileOptions & {
  requested: StoredRecord;
  transactions: readonly NwcTransaction[];
  now: number;
}): Promise<Pick<OpenReceiveStatusRefreshResult, "status" | "reason">> {
  let requestedMatched = false;
  let requestedReason: OpenReceiveStatusRefreshResult["reason"] = "wallet_no_match";

  for (const transaction of input.transactions) {
    if (transaction.type !== undefined && transaction.type !== "incoming") continue;

    const record = await findTransactionRecord(input.store, transaction);
    if (record === undefined || isTerminalInvoiceStorageRow(record.row)) continue;

    const result = await applyTransactionResult({
      ...input,
      record,
      transaction
    });
    if (record.row.invoice_id === input.requested.row.invoice_id) {
      requestedMatched = true;
      requestedReason = result.reason;
    }
  }

  return {
    status: requestedMatched ? "updated" : "stored",
    reason: requestedReason
  };
}

async function applyTransactionResult(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
  transaction: NwcTransaction;
  now: number;
}): Promise<Pick<OpenReceiveStatusRefreshResult, "status" | "reason">> {
  const detection = classifyTransactionSettlement(input.transaction);

  if (detection.status === "settled") {
    const settled = await persistTransition(
      input.store,
      input.record,
      (record) => applySettled(record, input.transaction.settled_at)
    );
    await emitEvent(input, {
      event: "invoice.settled",
      invoice: settled.row,
      transaction: input.transaction,
      reason: "wallet_settled"
    });
    await runSettlementAction({
      ...input,
      record: settled,
      transaction: input.transaction
    });
    return {
      status: "updated",
      reason: "wallet_settled"
    };
  }

  if (detection.status === "expired") {
    const expired = await persistTransition(
      input.store,
      input.record,
      applyExpiredClosed
    );
    await emitEvent(input, {
      event: "invoice.expired",
      invoice: expired.row,
      transaction: input.transaction,
      reason: "wallet_expired"
    });
    return {
      status: "updated",
      reason: "wallet_expired"
    };
  }

  if (detection.status === "failed") {
    const failed = await persistTransition(
      input.store,
      input.record,
      applyFailedClosed
    );
    await emitEvent(input, {
      event: "invoice.failed",
      invoice: failed.row,
      transaction: input.transaction,
      reason: "wallet_failed"
    });
    return {
      status: "updated",
      reason: "wallet_failed"
    };
  }

  const pending = await persistTransition(
    input.store,
    input.record,
    applyVerifying
  );
  await emitEvent(input, {
    event: "invoice.verifying",
    invoice: pending.row,
    transaction: input.transaction,
    reason: "wallet_pending"
  });

  return {
    status: "updated",
    reason: "wallet_pending"
  };
}

async function findTransactionRecord(
  store: OpenReceiveInvoiceKvStore,
  transaction: NwcTransaction
): Promise<StoredRecord | undefined> {
  if (transaction.payment_hash !== undefined) {
    const byHash = await store.getByPaymentHash(transaction.payment_hash);
    if (byHash !== undefined) return byHash;
  }
  if (transaction.invoice !== undefined) {
    return await store.getByBolt11Invoice(transaction.invoice);
  }
  return undefined;
}

async function claimTransactionScanGate(
  options: OpenReceiveReconcileOptions,
  now: number
): Promise<boolean> {
  const interval = normalizePositiveInteger(
    options.transactionScanIntervalSeconds ?? DEFAULT_TRANSACTION_SCAN_INTERVAL_SECONDS,
    "transactionScanIntervalSeconds"
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await options.store.getMeta(TRANSACTION_SCAN_GATE_META_KEY);
    if (current !== undefined) {
      const claimedAt = parseClaimedAt(current.value);
      if (claimedAt !== undefined && now - claimedAt < interval) return false;
    }

    const claimed = await options.store.casMeta(
      TRANSACTION_SCAN_GATE_META_KEY,
      JSON.stringify({ claimed_at: now }),
      current?.rev ?? null
    );
    if (claimed.status === "ok") return true;
  }

  return false;
}

function invoiceScanWindow(
  row: InvoiceStorageRow,
  options: OpenReceiveReconcileOptions
): { from: number; until: number; limit: number } {
  const padding = options.transactionScanWindowPaddingSeconds ?? DEFAULT_TRANSACTION_SCAN_WINDOW_PADDING_SECONDS;
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new TypeError("transactionScanWindowPaddingSeconds must be a non-negative safe integer");
  }
  return {
    from: Math.max(0, row.created_at - padding),
    until: row.expires_at + padding,
    limit: transactionScanPageLimit(options.transactionScanPageLimit)
  };
}

function invoiceScanWindowForRecords(
  rows: readonly InvoiceStorageRow[],
  options: OpenReceiveReconcileOptions
): { from: number; until: number; limit: number } {
  if (rows.length === 0) {
    throw new TypeError("invoiceScanWindowForRecords requires at least one invoice");
  }
  const padding = options.transactionScanWindowPaddingSeconds ?? DEFAULT_TRANSACTION_SCAN_WINDOW_PADDING_SECONDS;
  if (!Number.isSafeInteger(padding) || padding < 0) {
    throw new TypeError("transactionScanWindowPaddingSeconds must be a non-negative safe integer");
  }
  return {
    from: Math.max(0, Math.min(...rows.map((row) => row.created_at)) - padding),
    until: Math.max(...rows.map((row) => row.expires_at)) + padding,
    limit: transactionScanPageLimit(options.transactionScanPageLimit)
  };
}

function transactionScanPageLimit(configured: number | undefined): number {
  return Math.min(
    normalizePositiveInteger(
      configured ?? DEFAULT_TRANSACTION_SCAN_PAGE_LIMIT,
      "transactionScanPageLimit"
    ),
    MAX_TRANSACTION_SCAN_PAGE_LIMIT
  );
}

function isTransactionScanEligible(row: InvoiceStorageRow, now: number): boolean {
  return (
    row.expires_at > now &&
    (row.transaction_state === "pending" || row.transaction_state === "accepted")
  );
}

async function readTransactionScanCursor(
  store: OpenReceiveInvoiceKvStore,
  window: { from: number; until: number; limit: number }
): Promise<TransactionScanCursor> {
  const row = await store.getMeta(transactionScanCursorKey(window));
  if (row === undefined) {
    return {
      ...window,
      offset: 0,
      cycle: 0
    };
  }

  try {
    const parsed = JSON.parse(row.value) as Partial<TransactionScanCursor>;
    return {
      from: window.from,
      until: window.until,
      limit: window.limit,
      offset: Number.isSafeInteger(parsed.offset) && parsed.offset !== undefined && parsed.offset >= 0
        ? parsed.offset
        : 0,
      cycle: Number.isSafeInteger(parsed.cycle) && parsed.cycle !== undefined && parsed.cycle >= 0
        ? parsed.cycle
        : 0,
      ...(Number.isSafeInteger(parsed.last_page_scanned_at)
        ? { last_page_scanned_at: parsed.last_page_scanned_at }
        : {})
    };
  } catch {
    return {
      ...window,
      offset: 0,
      cycle: 0
    };
  }
}

async function advanceTransactionScanCursor(
  store: OpenReceiveInvoiceKvStore,
  cursor: TransactionScanCursor,
  count: number,
  now: number
): Promise<void> {
  const key = transactionScanCursorKey(cursor);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await store.getMeta(key);
    const latest = current === undefined
      ? cursor
      : await readTransactionScanCursor(store, cursor);
    const next: TransactionScanCursor = {
      ...latest,
      offset: count >= latest.limit ? latest.offset + latest.limit : 0,
      cycle: count >= latest.limit ? latest.cycle : latest.cycle + 1,
      last_page_scanned_at: now
    };
    const updated = await store.casMeta(
      key,
      JSON.stringify(next),
      current?.rev ?? null
    );
    if (updated.status === "ok") return;
  }
}

function transactionScanCursorKey(input: { from: number; until: number }): string {
  return `transaction_scan_cursor:${input.from}:${input.until}`;
}

async function persistTransition(
  store: OpenReceiveInvoiceKvStore,
  record: StoredRecord,
  transition: (record: StoredRecord) => StoredRecord
): Promise<StoredRecord> {
  let current = record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const updated = await store.put(transition(current), current.rev);
    if (updated.status === "ok") return updated.record;
    current = updated.record;
  }
  return current;
}

async function refreshRecords(
  store: OpenReceiveInvoiceKvStore,
  records: readonly StoredRecord[]
): Promise<StoredRecord[]> {
  const refreshed = await Promise.all(
    records.map(async (record) => await store.get(record.row.invoice_id) ?? record)
  );
  return refreshed;
}

async function emitEvent(
  options: OpenReceiveReconcileOptions,
  event: OpenReceiveReconcileEvent
): Promise<void> {
  await options.onEvent?.(event);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  options: OpenReceiveReconcileOptions
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const setTimeout = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("OpenReceive list_transactions request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stored(
  record: StoredRecord,
  reason: OpenReceiveStatusRefreshResult["reason"]
): OpenReceiveStatusRefreshResult {
  return {
    status: "stored",
    record,
    wallet_scan_performed: false,
    transactions_checked: 0,
    reason
  };
}

function parseClaimedAt(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as { claimed_at?: unknown };
    return Number.isSafeInteger(parsed.claimed_at) ? parsed.claimed_at as number : undefined;
  } catch {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : undefined;
  }
}

function getNow(options: OpenReceiveReconcileOptions): number {
  return options.clock?.() ?? Math.floor(Date.now() / 1000);
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}
