import type {
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
  clearSettlementActionClaim
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
  transactionScanOverlapSeconds?: number;
  sweepOpenInvoiceCap?: number;
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

export type OpenReceivePendingSweepReason =
  | "no_pending"
  | "gate_busy"
  | "wallet_scan_failed";

export interface OpenReceivePendingSweepResult {
  swept: boolean;
  reason?: OpenReceivePendingSweepReason;
  page_count?: number;
}

interface TransactionScanCursor {
  until_cursor: number | null;
  last_swept_at: number;
}

const DEFAULT_ACTION_LEASE_TTL_SECONDS = 60;
const MIN_TRANSACTION_SCAN_INTERVAL_SECONDS = 2;
const EARLY_INVOICE_LOOKUP_DELAY_SECONDS = 2;
const MID_INVOICE_LOOKUP_DELAY_SECONDS = 6;
const LATE_INVOICE_LOOKUP_DELAY_SECONDS = 12;
const EARLY_INVOICE_LOOKUP_WINDOW_SECONDS = 2 * 60;
const MID_INVOICE_LOOKUP_WINDOW_SECONDS = 5 * 60;
const PAGE_LIMIT = 25;
const MAX_TRANSACTION_SCAN_PAGE_LIMIT = 50;
const SCAN_OVERLAP_SECONDS = 60;
const SWEEP_OPEN_INVOICE_CAP = 1000;
const DEFAULT_TRANSACTION_SCAN_TIMEOUT_MS = 9000;
const TRANSACTION_SCAN_GATE_META_KEY = "transaction_scan_gate";
const TRANSACTION_SCAN_CURSOR_META_KEY = "transaction_scan_cursor:v2:global";

export async function refreshStoredInvoiceStatus(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
}): Promise<OpenReceiveStatusRefreshResult> {
  const now = getNow(input);
  const record = input.record;

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

  const sweep = await sweepPendingInvoicesOnce(input);
  const latest = await input.store.get(record.row.invoice_id) ?? record;
  return {
    status: latest.rev === record.rev ? "stored" : "updated",
    record: latest,
    wallet_scan_performed: sweep.swept,
    transactions_checked: sweep.page_count ?? 0,
    reason: refreshReasonFromSweep(sweep, record, latest)
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

  const sweep = await sweepPendingInvoicesOnce(input);
  const fresh = await refreshRecords(input.store, records);

  return {
    records: fresh,
    wallet_scan_performed: sweep.swept,
    transactions_checked: sweep.page_count ?? 0,
    reason: refreshReasonFromSweepForRecords(sweep, records, fresh)
  };
}

export async function sweepPendingInvoicesOnce(
  input: OpenReceiveReconcileOptions
): Promise<OpenReceivePendingSweepResult> {
  const now = getNow(input);
  const open = (await input.store.listOpen({
    now,
    limit: sweepOpenInvoiceCap(input.sweepOpenInvoiceCap)
  })).filter((record) => record.row.metadata.rail !== "checkout_lock");

  if (open.length === 0) {
    return {
      swept: false,
      reason: "no_pending"
    };
  }

  if (!await claimTransactionScanGate(input, now, open)) {
    return {
      swept: false,
      reason: "gate_busy"
    };
  }

  const from = Math.max(
    0,
    Math.min(...open.map((record) => record.row.created_at)) - scanOverlapSeconds(input)
  );
  const cursor = await readTransactionScanCursor(input.store);
  const until = cursor.until_cursor !== null && cursor.until_cursor > from
    ? cursor.until_cursor
    : now;
  const limit = transactionScanPageLimit(input.transactionScanPageLimit);

  let page: ListTransactionsResult;
  try {
    page = await withTimeout(
      input.client.listTransactions({
        type: "incoming",
        unpaid: true,
        from,
        until,
        limit
      }),
      normalizePositiveInteger(
        input.transactionScanTimeoutMs ?? DEFAULT_TRANSACTION_SCAN_TIMEOUT_MS,
        "transactionScanTimeoutMs"
      ),
      input
    );
  } catch {
    await emitEvent(input, {
      event: "transaction_scan.failed",
      invoice: open[0].row,
      reason: "wallet_scan_failed"
    });
    return {
      swept: false,
      reason: "wallet_scan_failed"
    };
  }

  await applyTransactionPageForRecords({
    ...input,
    records: open,
    transactions: page.transactions,
    now
  });
  await writeTransactionScanCursor(input.store, {
    until_cursor: nextTransactionScanUntil(page.transactions, limit, until, now),
    last_swept_at: now
  });

  return {
    swept: true,
    page_count: page.transactions.length
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
  now: number,
  open: readonly StoredRecord[]
): Promise<boolean> {
  const interval = transactionScanGateIntervalSeconds(options, open, now);

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

function transactionScanGateIntervalSeconds(
  options: OpenReceiveReconcileOptions,
  open: readonly StoredRecord[],
  now: number
): number {
  const configuredFloor =
    options.transactionScanIntervalSeconds === undefined
      ? MIN_TRANSACTION_SCAN_INTERVAL_SECONDS
      : normalizePositiveInteger(
          options.transactionScanIntervalSeconds,
          "transactionScanIntervalSeconds"
        );
  const invoiceDelay = Math.min(
    ...open.map((record) =>
      nextInvoiceLookupDelaySeconds(Math.max(0, now - record.row.created_at))
    )
  );

  return Math.max(
    MIN_TRANSACTION_SCAN_INTERVAL_SECONDS,
    configuredFloor,
    invoiceDelay
  );
}

function nextInvoiceLookupDelaySeconds(elapsedSeconds: number): number {
  if (elapsedSeconds < EARLY_INVOICE_LOOKUP_WINDOW_SECONDS) {
    return EARLY_INVOICE_LOOKUP_DELAY_SECONDS;
  }
  if (elapsedSeconds < MID_INVOICE_LOOKUP_WINDOW_SECONDS) {
    return MID_INVOICE_LOOKUP_DELAY_SECONDS;
  }
  return LATE_INVOICE_LOOKUP_DELAY_SECONDS;
}

function transactionScanPageLimit(configured: number | undefined): number {
  return Math.min(
    normalizePositiveInteger(
      configured ?? PAGE_LIMIT,
      "transactionScanPageLimit"
    ),
    MAX_TRANSACTION_SCAN_PAGE_LIMIT
  );
}

function scanOverlapSeconds(options: OpenReceiveReconcileOptions): number {
  return normalizeNonNegativeInteger(
    options.transactionScanOverlapSeconds ??
      options.transactionScanWindowPaddingSeconds ??
      SCAN_OVERLAP_SECONDS,
    "transactionScanOverlapSeconds"
  );
}

function sweepOpenInvoiceCap(configured: number | undefined): number {
  return normalizePositiveInteger(
    configured ?? SWEEP_OPEN_INVOICE_CAP,
    "sweepOpenInvoiceCap"
  );
}

async function readTransactionScanCursor(
  store: OpenReceiveInvoiceKvStore
): Promise<TransactionScanCursor> {
  const row = await store.getMeta(TRANSACTION_SCAN_CURSOR_META_KEY);
  if (row === undefined) {
    return {
      until_cursor: null,
      last_swept_at: 0
    };
  }

  try {
    const parsed = JSON.parse(row.value) as Partial<TransactionScanCursor>;
    const parsedUntilCursor = parsed.until_cursor;
    const parsedLastSweptAt = parsed.last_swept_at;
    return {
      until_cursor: typeof parsedUntilCursor === "number" &&
        Number.isSafeInteger(parsedUntilCursor) &&
        parsedUntilCursor >= 0
        ? parsedUntilCursor
        : null,
      last_swept_at: typeof parsedLastSweptAt === "number" &&
        Number.isSafeInteger(parsedLastSweptAt) &&
        parsedLastSweptAt >= 0
        ? parsedLastSweptAt
        : 0
    };
  } catch {
    return {
      until_cursor: null,
      last_swept_at: 0
    };
  }
}

async function writeTransactionScanCursor(
  store: OpenReceiveInvoiceKvStore,
  cursor: TransactionScanCursor
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await store.getMeta(TRANSACTION_SCAN_CURSOR_META_KEY);
    const updated = await store.casMeta(
      TRANSACTION_SCAN_CURSOR_META_KEY,
      JSON.stringify(cursor),
      current?.rev ?? null
    );
    if (updated.status === "ok") return;
  }
}

function nextTransactionScanUntil(
  transactions: readonly NwcTransaction[],
  limit: number,
  until: number,
  now: number
): number {
  if (transactions.length < limit) return now;

  const createdAts = transactions
    .map((transaction) => transaction.created_at)
    .filter((createdAt): createdAt is number =>
      typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0
    );
  let nextUntil = createdAts.length > 0 ? Math.min(...createdAts) : until - 1;
  if (nextUntil >= until) nextUntil = until - 1;
  return Math.max(0, nextUntil);
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

function refreshReasonFromSweep(
  sweep: OpenReceivePendingSweepResult,
  before: StoredRecord,
  after: StoredRecord
): OpenReceiveStatusRefreshResult["reason"] {
  if (sweep.reason === "gate_busy") return "transaction_scan_claim_conflict";
  if (sweep.reason === "wallet_scan_failed") return "wallet_scan_failed";
  if (sweep.reason === "no_pending") return "already_final";
  return reasonFromTransition(before, after) ?? "wallet_no_match";
}

function refreshReasonFromSweepForRecords(
  sweep: OpenReceivePendingSweepResult,
  before: readonly StoredRecord[],
  after: readonly StoredRecord[]
): OpenReceiveStatusRefreshResult["reason"] {
  if (sweep.reason === "gate_busy") return "transaction_scan_claim_conflict";
  if (sweep.reason === "wallet_scan_failed") return "wallet_scan_failed";
  if (sweep.reason === "no_pending") return "already_final";

  const beforeByInvoiceId = new Map(
    before.map((record) => [record.row.invoice_id, record])
  );
  for (const fresh of after) {
    const previous = beforeByInvoiceId.get(fresh.row.invoice_id);
    if (previous === undefined) continue;
    const reason = reasonFromTransition(previous, fresh);
    if (reason !== undefined) return reason;
  }

  return "wallet_no_match";
}

function reasonFromTransition(
  before: StoredRecord,
  after: StoredRecord
): OpenReceiveStatusRefreshResult["reason"] | undefined {
  if (
    before.row.workflow_state !== "settlement_action_completed" &&
    after.row.workflow_state === "settlement_action_completed"
  ) {
    return "settlement_action_completed";
  }
  if (
    before.row.transaction_state !== "settled" &&
    after.row.transaction_state === "settled"
  ) {
    return "wallet_settled";
  }
  if (
    before.row.transaction_state !== "expired" &&
    after.row.transaction_state === "expired"
  ) {
    return "wallet_expired";
  }
  if (
    before.row.transaction_state !== "failed" &&
    after.row.transaction_state === "failed"
  ) {
    return "wallet_failed";
  }
  if (
    before.row.workflow_state !== "verifying" &&
    after.row.workflow_state === "verifying"
  ) {
    return "wallet_pending";
  }
  return undefined;
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

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}
