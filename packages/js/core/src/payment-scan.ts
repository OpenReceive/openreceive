import { OPENRECEIVE_TRANSACTION_PAGE_LIMIT } from "./generated/contracts.ts";
import type { ReceiveNwcClient } from "./nwc/client.ts";
import { paymentCheckFromTransaction, type PaymentCheck } from "./payments.ts";
import { unixSeconds } from "./values.ts";

/** Nonsecret, versioned durable scan state. The payment ledger remains authoritative. */
export interface ScanAttempt {
  readonly payment_hash: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly created_at_source: "wallet" | "host";
}
export interface PaymentScanWindow {
  attempts: ScanAttempt[];
  from: number;
  until?: number;
  view: "default" | "inclusive";
  offset: number;
  started_at: number;
  absence_safe: boolean;
  anchor_offset?: number;
  anchor?: string;
  observations: Record<string, { status: "pending"; transaction_state?: string }>;
}
export interface PaymentScanSlice {
  readonly checks: readonly PaymentCheck[];
  readonly outcome: "complete" | "continued" | "stalled";
  readonly window: PaymentScanWindow;
}

export function createPaymentScanWindow(
  attempts: readonly ScanAttempt[],
  now: number,
  overlap = 60,
): PaymentScanWindow {
  const authoritative = attempts.every((attempt) => attempt.created_at_source === "wallet");
  return {
    attempts: [...attempts],
    from: authoritative
      ? Math.max(0, Math.min(...attempts.map((attempt) => attempt.created_at)) - overlap)
      : 0,
    ...(authoritative
      ? { until: Math.max(...attempts.map((attempt) => attempt.created_at)) + overlap }
      : {}),
    view: "default",
    offset: 0,
    started_at: now,
    absence_safe: true,
    observations: {},
  };
}

/**
 * One budgeted slice, with fixed creation-time bounds across restarts. Resuming
 * can discover finality but cannot certify absence: offset history is not a
 * snapshot. Only a fresh complete covering sweep supplies clock-closure proof.
 */
export async function scanPaymentSlice(input: {
  readonly client: ReceiveNwcClient;
  readonly window: PaymentScanWindow;
  readonly maxPages?: number;
  readonly deadline?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
  /** Commit positive finality as it is found, even if a later page fails. */
  readonly onFinality?: (check: PaymentCheck) => Promise<void>;
}): Promise<PaymentScanSlice> {
  const window = structuredClone(input.window);
  const clock = input.clock ?? unixSeconds;
  const maxPages = input.maxPages ?? 50;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50)
    throw new RangeError("scan maxPages must be between 1 and 50");
  const checks = new Map<string, PaymentCheck>();
  const expected = new Set(window.attempts.map((attempt) => attempt.payment_hash));
  const resumed = window.offset > 0 || window.view === "inclusive";
  if (resumed) window.absence_safe = false;
  // Overlap the last page. A changed boundary cannot prove absence, and a wallet
  // ignoring offset must not consume the same entire budget on every pass.
  let verifyingAnchor = resumed && maxPages > 1 && window.anchor_offset !== undefined;
  let previous = window.anchor;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    if (input.signal?.aborted || (input.deadline !== undefined && Date.now() >= input.deadline))
      break;
    const offset = verifyingAnchor ? window.anchor_offset! : window.offset;
    const page = await input.client.listTransactions(
      {
        type: "incoming",
        limit: OPENRECEIVE_TRANSACTION_PAGE_LIMIT,
        offset,
        from: window.from,
        ...(window.until === undefined ? {} : { until: window.until }),
        ...(window.view === "inclusive" ? { unpaid: true } : {}),
      },
      input.signal === undefined ? undefined : { signal: input.signal },
    );
    input.signal?.throwIfAborted();
    const physicalRows = page.transactions.length + (page.skippedRows ?? 0);
    if (physicalRows > 0 && page.transactions.length === 0)
      throw new TypeError("list_transactions returned no usable rows");
    const fingerprint = pageFingerprint(
      page.transactions.map((tx) => tx.payment_hash ?? ""),
      physicalRows,
    );
    for (const tx of page.transactions) {
      if (tx.type !== undefined && tx.type !== "incoming") continue;
      const hash = tx.payment_hash?.toLowerCase();
      if (hash === undefined || !expected.has(hash)) continue;
      const check = paymentCheckFromTransaction(hash, tx, clock());
      if (check.status === "settled" || check.status === "expired" || check.status === "failed") {
        // A replayed sparse observation must never erase positive finality.
        if (checks.get(hash)?.status !== "settled") checks.set(hash, check);
        delete window.observations[hash];
        if (
          check.status === "settled" &&
          (input.deadline === undefined || Date.now() < input.deadline)
        )
          await input.onFinality?.(check);
      } else if (!checks.has(hash)) {
        const state = tx.state ?? tx.transaction_state;
        window.observations[hash] = {
          status: "pending",
          ...(state === undefined ? {} : { transaction_state: state }),
        };
      }
    }
    if (verifyingAnchor) {
      verifyingAnchor = false;
      if (fingerprint === window.anchor) continue;
      window.absence_safe = false;
      // Continue from the overlap when insertions/deletions shifted the page.
    } else if (physicalRows > 0 && fingerprint === previous) {
      return { checks: [...checks.values()], outcome: "stalled", window };
    }
    if (physicalRows === 0) {
      if (window.view === "default") {
        window.view = "inclusive";
        window.offset = 0;
        delete window.anchor;
        delete window.anchor_offset;
        previous = undefined;
        continue;
      }
      if (window.absence_safe) {
        for (const hash of expected) {
          if (checks.has(hash)) continue;
          const observation = window.observations[hash];
          checks.set(
            hash,
            observation === undefined
              ? { paymentHash: hash, status: "not_found", coverageStartedAt: window.started_at }
              : {
                  paymentHash: hash,
                  status: "pending",
                  coverageStartedAt: window.started_at,
                  details: {
                    observed_at: window.started_at,
                    transaction: {
                      payment_hash: hash,
                      ...(observation.transaction_state === undefined
                        ? {}
                        : { transaction_state: observation.transaction_state as "pending" }),
                    },
                  },
                },
          );
        }
      }
      return { checks: [...checks.values()], outcome: "complete", window };
    }
    previous = fingerprint;
    window.anchor = fingerprint;
    window.anchor_offset = offset;
    window.offset = offset + physicalRows;
    if (
      [...expected].every((hash) => checks.has(hash) || window.observations[hash] !== undefined)
    ) {
      if (window.absence_safe) {
        for (const [hash, observation] of Object.entries(window.observations)) {
          if (checks.has(hash)) continue;
          checks.set(hash, {
            paymentHash: hash,
            status: "pending",
            coverageStartedAt: window.started_at,
            details: {
              observed_at: window.started_at,
              transaction: {
                payment_hash: hash,
                ...(observation.transaction_state === undefined
                  ? {}
                  : { transaction_state: observation.transaction_state as "pending" }),
              },
            },
          });
        }
      }
      return { checks: [...checks.values()], outcome: "complete", window };
    }
  }
  return { checks: [...checks.values()], outcome: "continued", window };
}

// Bounded digest of identities only; never persist wallet payloads or preimages.
function pageFingerprint(hashes: readonly string[], count: number): string {
  let value = 2166136261;
  for (const char of `${count}:${hashes.join(",")}`)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return (value >>> 0).toString(16);
}
