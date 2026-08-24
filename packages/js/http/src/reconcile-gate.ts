import { compact, unixSeconds } from "@openreceive/core";
import type { OpenReceive, PaymentCheck } from "@openreceive/node";
import { type Host, warnFailure } from "./host-payments.ts";
import type { ReconcilableAttempt } from "./payment-repository.ts";
import { reconcileHostPayments } from "./reconcile-loop.ts";

/**
 * Floor for the durable reconcile-gate interval: at most one real wallet scan
 * per two seconds across EVERY worker sharing the host database. This gate is
 * the NWC rate limit for settlement scans — open tabs polling `payments/check`
 * (~3s) all share the one global pass instead of fanning out wallet walks.
 */
export const OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS = 2 as const;

/**
 * Wall-clock bound on an awaited request-path pass: a slow wallet must not
 * hang user-facing requests. A timed-out pass counts as a failed scan; the
 * gate stays claimed so the next interval retries without a stampede.
 */
export const OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS = 9_000 as const;

/** Page cap per wallet-history walk on the awaited request path. */
export const OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES = 50 as const;

// Invoice-age stretch for the gate interval: young invoices (payer likely
// watching) scan every 2s, then 6s, then 12s once everything pending is stale.
const EARLY_INVOICE_INTERVAL_SECONDS = 2;
const MID_INVOICE_INTERVAL_SECONDS = 6;
const LATE_INVOICE_INTERVAL_SECONDS = 12;
const EARLY_INVOICE_WINDOW_SECONDS = 2 * 60;
const MID_INVOICE_WINDOW_SECONDS = 5 * 60;

export type OpportunisticReconcileResult =
  | { readonly reason: "ran"; readonly checks: readonly PaymentCheck[] }
  | { readonly reason: "no_pending" | "gate_busy" | "scan_failed" };

export interface MaybeReconcilePaymentsOptions {
  readonly service: OpenReceive;
  readonly host: Host;
  /** Gate interval floor. Default (and minimum) 2 seconds. */
  readonly minIntervalSeconds?: number;
  readonly overlapSeconds?: number;
  readonly scanTimeoutMs?: number;
  readonly maxPages?: number;
  readonly clock?: () => number;
  /** Observes failed scans. Default: console.warn — a failure never propagates. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The gate interval for the current pending set: the configured floor,
 * stretched by invoice age (2s while any pending invoice is under 2 minutes
 * old, 6s under 5 minutes, else 12s).
 */
export function reconcileIntervalSeconds(
  attempts: readonly ReconcilableAttempt[],
  now: number,
  minIntervalSeconds: number = OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS,
): number {
  const floor = Math.max(OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS, minIntervalSeconds);
  // Nothing pending: nothing to pace, so the floor. Math.min() of an empty
  // list is Infinity, and a host feeding that to the gate would never reopen it.
  if (attempts.length === 0) return floor;
  const ageStretch = Math.min(
    // A wallet-issued createdAt ahead of the host clock reads as a negative
    // age; clamped to zero it counts as freshly minted (scan fast), which is
    // what a just-created invoice deserves.
    ...attempts.map((attempt) => intervalForInvoiceAge(Math.max(0, now - attempt.createdAt))),
  );
  return Math.max(floor, ageStretch);
}

function intervalForInvoiceAge(elapsedSeconds: number): number {
  if (elapsedSeconds < EARLY_INVOICE_WINDOW_SECONDS) return EARLY_INVOICE_INTERVAL_SECONDS;
  if (elapsedSeconds < MID_INVOICE_WINDOW_SECONDS) return MID_INVOICE_INTERVAL_SECONDS;
  return LATE_INVOICE_INTERVAL_SECONDS;
}

/**
 * Opportunistic settlement discovery, piggybacked on any later OpenReceive
 * call: skip without a wallet call when nothing is pending, try the durable
 * `openreceive_meta` gate (`gate_busy` means another worker just scanned —
 * skip the wallet), otherwise AWAIT one bounded `reconcileHostPayments`
 * pass (serverless-safe) and return its per-hash results.
 *
 * Never throws: a failed or timed-out scan is reported (default console.warn)
 * and returns `scan_failed` — the caller's own request must not fail because a
 * settlement sweep did. The gate's `claimed_at` is left in place on failure so
 * a broken wallet cannot stampede; the next interval retries.
 *
 * The HTTP handler calls this on every mounted payment route by default
 * (`opportunisticReconcile`; unauthenticated `GET /rates` is excluded so
 * crawlers and health checks cannot consume the scan budget); it is exported
 * so hosts can also drive it from their own routes or middleware (host-only
 * routes never auto-run it).
 */
export async function maybeReconcilePayments(
  input: MaybeReconcilePaymentsOptions,
): Promise<OpportunisticReconcileResult> {
  // A missing gate is a wiring error, not a transient failure: propagate it
  // (the HTTP handler already refuses to construct in this state) instead of
  // silently degrading the default settlement path.
  const claimReconcileGate = input.host.payments.claimReconcileGate;
  if (typeof claimReconcileGate !== "function") {
    throw new TypeError(
      "Opportunistic reconcile requires payments.claimReconcileGate (a durable CAS gate); " +
        "implement it on the repository or disable with opportunisticReconcile: false.",
    );
  }
  const report =
    input.onError ??
    ((error: unknown) => {
      warnFailure(
        "payment.reconcile.opportunistic.failed",
        "opportunistic reconcile failed (will retry)",
        error,
      );
    });
  try {
    const attempts = await input.host.payments.listReconcilableAttempts();
    if (attempts.length === 0) return { reason: "no_pending" };
    const clock = input.clock ?? unixSeconds;
    const now = clock();
    const intervalSeconds = reconcileIntervalSeconds(attempts, now, input.minIntervalSeconds);
    const claimed = await claimReconcileGate.call(input.host.payments, { now, intervalSeconds });
    if (!claimed) return { reason: "gate_busy" };
    const checks = await withScanTimeout(
      reconcileHostPayments({
        service: input.service,
        host: input.host,
        // Already read above to size the gate interval; the pass scans that
        // exact batch rather than repeating the query on the request path.
        attempts,
        overlapSeconds: input.overlapSeconds,
        maxPages: input.maxPages ?? OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES,
        ...compact({ clock: input.clock }),
      }),
      input.scanTimeoutMs ?? OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS,
    );
    return { reason: "ran", checks };
  } catch (error) {
    report(error);
    return { reason: "scan_failed" };
  }
}

function withScanTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // The timeout abandons the in-flight scan; it cannot cancel it. Nothing in
    // the wallet path (`service.reconcilePayments` -> core reconcile ->
    // `listTransactions` over the NWC relay round-trip) accepts an
    // AbortSignal, so there is no plumbing to cancel into. The abandoned pass
    // drains in the background and the gate's `claimed_at` stays in place, so
    // a slow wallet is retried next interval instead of stampeding new scans.
    const timer = setTimeout(() => {
      reject(new Error(`reconcile scan exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
