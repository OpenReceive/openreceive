import type {
  LookupInvoiceResult,
  OpenReceiveReceiveNwcClient
} from "../nwc/client.ts";
import { classifyLookupInvoiceSettlement } from "../settlement/index.ts";
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
  applyExpiryPendingVerification,
  applyFailedClosed,
  applySettlementActionCompleted,
  applySettled,
  applyVerifying,
  claimSettlementAction,
  clearSettlementActionClaim,
  markLookupAttempted
} from "../state/transitions.ts";

export type OpenReceiveReconcileEventName =
  | "invoice.verifying"
  | "invoice.settled"
  | "invoice.expired"
  | "invoice.failed"
  | "invoice.settlement_action_completed";

export interface OpenReceiveReconcileEvent {
  event: OpenReceiveReconcileEventName;
  invoice: InvoiceStorageRow;
  lookup_invoice?: LookupInvoiceResult;
  reason?: string;
}

export interface OpenReceiveSettlementActionInput {
  invoice: InvoiceStorageRow;
  metadata: Record<string, unknown>;
  source: "http_lookup" | "poll";
  lookup_invoice?: LookupInvoiceResult;
}

export interface OpenReceiveReconcileOptions {
  store: OpenReceiveInvoiceKvStore;
  client: OpenReceiveReceiveNwcClient;
  settlementAction?: (input: OpenReceiveSettlementActionInput) => MaybePromise<void>;
  onEvent?: (event: OpenReceiveReconcileEvent) => MaybePromise<void>;
  clock?: () => number;
  lookupBurst?: number;
  lookupRatePerSecond?: number;
  actionLeaseTtlSeconds?: number;
  sweepIntervalSeconds?: number;
  sweepBatch?: number;
}

export type OpenReceiveGatedLookupStatus =
  | "updated"
  | "stored"
  | "leased"
  | "conflict";

export interface OpenReceiveGatedLookupResult {
  status: OpenReceiveGatedLookupStatus;
  record: StoredRecord;
  lookup_invoice?: LookupInvoiceResult;
  reason?:
    | "already_final"
    | "cooldown"
    | "token_unavailable"
    | "lookup_claim_conflict"
    | "settlement_action_completed"
    | "settlement_action_leased"
    | "pending"
    | "expired_pending_wallet_truth"
    | "wallet_settled"
    | "wallet_expired"
    | "wallet_failed";
}

export interface OpenReceiveReconcileOnceResult {
  invoice_ids: string[];
  checked: number;
}

export interface OpenReceiveMaybeSweepResult {
  status: "started" | "skipped";
  reason?: "interval" | "claim_conflict";
  result?: OpenReceiveReconcileOnceResult;
}

const DEFAULT_LOOKUP_BURST = 8;
const DEFAULT_LOOKUP_RATE_PER_SECOND = 4;
const DEFAULT_ACTION_LEASE_TTL_SECONDS = 60;
const DEFAULT_SWEEP_INTERVAL_SECONDS = 20;
const DEFAULT_SWEEP_BATCH = 200;
const LOOKUP_BUCKET_META_KEY = "lookup_bucket";
const LAST_SWEEP_META_KEY = "last_sweep_at";

export function cooldownFor(ageSeconds: number): number {
  if (!Number.isSafeInteger(ageSeconds) || ageSeconds < 0) return 2;
  if (ageSeconds < 15) return 2;
  if (ageSeconds < 60) return 5;
  if (ageSeconds < 180) return 10;
  if (ageSeconds < 600) return 20;
  return 60;
}

export async function gatedLookup(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
  source?: OpenReceiveSettlementActionInput["source"];
}): Promise<OpenReceiveGatedLookupResult> {
  const now = getNow(input);
  let record = input.record;

  if (isTerminalInvoiceStorageRow(record.row)) {
    return {
      status: "stored",
      record,
      reason: "already_final"
    };
  }

  if (record.row.transaction_state === "settled") {
    return await runSettlementAction({
      ...input,
      record,
      now,
      source: input.source ?? "poll"
    });
  }

  if (!isLookupDue(record, now)) {
    return {
      status: "stored",
      record,
      reason: "cooldown"
    };
  }

  if (!await tryConsumeLookupToken(input, now)) {
    return {
      status: "stored",
      record,
      reason: "token_unavailable"
    };
  }

  const claim = await input.store.put(markLookupAttempted(record, now), record.rev);
  if (claim.status === "conflict") {
    return {
      status: "conflict",
      record: claim.record,
      reason: "lookup_claim_conflict"
    };
  }

  record = claim.record;
  const lookup = await input.client.lookupInvoice({
    payment_hash: record.row.payment_hash
  });

  return await applyLookupResult({
    ...input,
    record,
    lookup,
    now,
    source: input.source ?? "poll"
  });
}

export async function tryConsumeLookupToken(
  options: OpenReceiveReconcileOptions,
  now = getNow(options)
): Promise<boolean> {
  const max = normalizePositiveNumber(
    options.lookupBurst ?? DEFAULT_LOOKUP_BURST,
    "lookupBurst"
  );
  const refillPerSecond = normalizePositiveNumber(
    options.lookupRatePerSecond ?? DEFAULT_LOOKUP_RATE_PER_SECOND,
    "lookupRatePerSecond"
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await options.store.getMeta(LOOKUP_BUCKET_META_KEY);
    if (current === undefined) {
      const created = await options.store.casMeta(
        LOOKUP_BUCKET_META_KEY,
        JSON.stringify({ tokens: max - 1, refilled_at: now }),
        null
      );
      if (created.status === "ok") return true;
      continue;
    }

    const bucket = parseLookupBucket(current.value, max, now);
    const elapsed = Math.max(0, now - bucket.refilled_at);
    const tokens = Math.min(max, bucket.tokens + elapsed * refillPerSecond);
    if (tokens < 1) return false;

    const next = {
      tokens: tokens - 1,
      refilled_at: now
    };
    const updated = await options.store.casMeta(
      LOOKUP_BUCKET_META_KEY,
      JSON.stringify(next),
      current.rev
    );
    if (updated.status === "ok") return true;
  }

  return false;
}

export async function maybeSweep(
  options: OpenReceiveReconcileOptions
): Promise<OpenReceiveMaybeSweepResult> {
  const now = getNow(options);
  const interval = normalizePositiveInteger(
    options.sweepIntervalSeconds ?? DEFAULT_SWEEP_INTERVAL_SECONDS,
    "sweepIntervalSeconds"
  );
  const current = await options.store.getMeta(LAST_SWEEP_META_KEY);
  const lastSweepAt = current === undefined ? undefined : Number(current.value);

  if (
    lastSweepAt !== undefined &&
    Number.isSafeInteger(lastSweepAt) &&
    now - lastSweepAt < interval
  ) {
    return {
      status: "skipped",
      reason: "interval"
    };
  }

  const claimed = await options.store.casMeta(
    LAST_SWEEP_META_KEY,
    String(now),
    current?.rev ?? null
  );
  if (claimed.status !== "ok") {
    return {
      status: "skipped",
      reason: "claim_conflict"
    };
  }

  return {
    status: "started",
    result: await reconcileOnce({
      ...options,
      now
    })
  };
}

export async function reconcileOnce(
  options: OpenReceiveReconcileOptions & { now?: number }
): Promise<OpenReceiveReconcileOnceResult> {
  const now = options.now ?? getNow(options);
  const limit = normalizePositiveInteger(
    options.sweepBatch ?? DEFAULT_SWEEP_BATCH,
    "sweepBatch"
  );
  const records = await options.store.listOpen({ now, limit });
  const invoiceIds: string[] = [];
  let checked = 0;

  for (const record of records) {
    invoiceIds.push(record.row.invoice_id);
    const result = await gatedLookup({
      ...options,
      record,
      source: "poll"
    });
    if (result.lookup_invoice !== undefined) checked += 1;
  }

  return {
    invoice_ids: invoiceIds,
    checked
  };
}

export async function runSettlementAction(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
  now?: number;
  source?: OpenReceiveSettlementActionInput["source"];
  lookup_invoice?: LookupInvoiceResult;
}): Promise<OpenReceiveGatedLookupResult> {
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
      source: input.source ?? "poll",
      lookup_invoice: input.lookup_invoice
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
    lookup_invoice: input.lookup_invoice
  });

  return {
    status: "updated",
    record: finalRecord,
    lookup_invoice: input.lookup_invoice,
    reason: "settlement_action_completed"
  };
}

async function applyLookupResult(input: OpenReceiveReconcileOptions & {
  record: StoredRecord;
  lookup: LookupInvoiceResult;
  now: number;
  source: OpenReceiveSettlementActionInput["source"];
}): Promise<OpenReceiveGatedLookupResult> {
  const detection = classifyLookupInvoiceSettlement(input.lookup);

  if (detection.status === "settled") {
    const settled = await persistTransition(
      input.store,
      input.record,
      (record) => applySettled(record, input.lookup.settled_at)
    );
    await emitEvent(input, {
      event: "invoice.settled",
      invoice: settled.row,
      lookup_invoice: input.lookup,
      reason: "wallet_settled"
    });
    return await runSettlementAction({
      ...input,
      record: settled,
      lookup_invoice: input.lookup
    });
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
      lookup_invoice: input.lookup,
      reason: "wallet_expired"
    });
    return {
      status: "updated",
      record: expired,
      lookup_invoice: input.lookup,
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
      lookup_invoice: input.lookup,
      reason: "wallet_failed"
    });
    return {
      status: "updated",
      record: failed,
      lookup_invoice: input.lookup,
      reason: "wallet_failed"
    };
  }

  const pending = await persistTransition(
    input.store,
    input.record,
    input.now >= input.record.row.expires_at
      ? applyExpiryPendingVerification
      : applyVerifying
  );
  await emitEvent(input, {
    event: "invoice.verifying",
    invoice: pending.row,
    lookup_invoice: input.lookup,
    reason: input.now >= input.record.row.expires_at
      ? "expired_pending_wallet_truth"
      : "pending"
  });

  return {
    status: "updated",
    record: pending,
    lookup_invoice: input.lookup,
    reason: input.now >= input.record.row.expires_at
      ? "expired_pending_wallet_truth"
      : "pending"
  };
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

async function emitEvent(
  options: OpenReceiveReconcileOptions,
  event: OpenReceiveReconcileEvent
): Promise<void> {
  await options.onEvent?.(event);
}

function isLookupDue(record: StoredRecord, now: number): boolean {
  const lastLookupAt = record.row.last_lookup_at;
  if (lastLookupAt === undefined) return true;
  const age = Math.max(0, now - record.row.created_at);
  return now >= lastLookupAt + cooldownFor(age);
}

function parseLookupBucket(
  value: string,
  max: number,
  now: number
): { tokens: number; refilled_at: number } {
  try {
    const parsed = JSON.parse(value) as {
      tokens?: unknown;
      refilled_at?: unknown;
    };
    const tokens =
      typeof parsed.tokens === "number" && Number.isFinite(parsed.tokens)
        ? parsed.tokens
        : max;
    const refilledAt =
      Number.isSafeInteger(parsed.refilled_at)
        ? parsed.refilled_at as number
        : now;
    return {
      tokens,
      refilled_at: refilledAt
    };
  } catch {
    return {
      tokens: max,
      refilled_at: now
    };
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

function normalizePositiveNumber(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return value;
}
