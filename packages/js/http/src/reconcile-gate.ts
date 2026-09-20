import { createPaymentScanWindow, unixSeconds, type PaymentScanWindow } from "@openreceive/core";
import type { OpenReceive, PaymentCheck } from "@openreceive/node";
import { type Host, warnFailure } from "./host-payments.ts";
import type { ReconcilableAttempt, ReconcileScheduler } from "./payment-repository.ts";
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
  if (
    typeof claimReconcileGate !== "function" ||
    typeof input.host.payments.checkpointReconcileGate !== "function"
  ) {
    throw new TypeError(
      "Opportunistic reconcile requires payments.claimReconcileGate and checkpointReconcileGate (durable lease and progress CAS); " +
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
    const clock = input.clock ?? unixSeconds;
    const now = clock();
    const minInterval = Math.max(2, input.minIntervalSeconds ?? 2);
    const timeout = Math.min(
      OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS,
      input.scanTimeoutMs ?? OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS,
    );
    const claim = await claimReconcileGate.call(input.host.payments, {
      now,
      intervalSeconds: minInterval,
      leaseSeconds: Math.ceil(timeout / 1000) + 1,
    });
    if (claim === null) return { reason: "gate_busy" };
    if (typeof claim !== "object" || typeof claim.token !== "string")
      throw new TypeError(
        "claimReconcileGate must return a lease claim or null; boolean gate repositories must upgrade.",
      );
    const scheduler: ReconcileScheduler = structuredClone(claim.scheduler);
    const queued = new Set(
      scheduler.windows.flatMap((window) => window.attempts.map((attempt) => attempt.payment_hash)),
    );
    if (scheduler.windows.length < 2) {
      let candidates = await input.host.payments.listReconcilableAttempts(scheduler.cursor);
      if (candidates.length === 0 && scheduler.cursor !== null)
        candidates = await input.host.payments.listReconcilableAttempts(null);
      const last = candidates.at(-1);
      scheduler.cursor =
        last === undefined ? null : { created_at: last.createdAt, payment_hash: last.paymentHash };
      const fresh = candidates.filter((attempt) => !queued.has(attempt.paymentHash));
      if (fresh.length > 0)
        scheduler.windows.push(
          createPaymentScanWindow(
            fresh.map((attempt) => ({
              payment_hash: attempt.paymentHash,
              created_at: attempt.createdAt,
              expires_at: attempt.expiresAt,
              created_at_source: attempt.createdAtSource ?? "host",
            })),
            now,
            input.overlapSeconds,
          ),
        );
    }
    const window = scheduler.windows.shift();
    if (window === undefined) {
      await input.host.payments.checkpointReconcileGate({
        claim,
        scheduler,
        now: clock(),
        release: true,
      });
      return { reason: "no_pending" };
    }
    // Rotate before I/O. Failed wallets or fulfillment callbacks cannot pin the
    // next gate winner to this cohort. Every pending row returns on keyset wrap.
    scheduler.windows.push(window);
    const attempts = window.attempts.map((attempt) => ({
      paymentHash: attempt.payment_hash,
      createdAt: attempt.created_at,
      expiresAt: attempt.expires_at,
      createdAtSource: attempt.created_at_source,
    }));
    const intervalSeconds = reconcileIntervalSeconds(attempts, now, minInterval);
    if (
      !(await input.host.payments.checkpointReconcileGate({
        claim,
        scheduler,
        now: clock(),
        intervalSeconds,
      }))
    )
      return { reason: "gate_busy" };
    const streamed = new Set<string>();
    const deliveryFailures: unknown[] = [];
    const deadline = Date.now() + timeout;
    const controller = new AbortController();
    const slice = await withScanTimeout(
      input.service.scanPaymentSlice({
        window,
        maxPages: Math.min(
          OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES,
          input.maxPages ?? OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES,
        ),
        deadline,
        signal: controller.signal,
        onFinality: async (check) => {
          if (streamed.has(check.paymentHash) || Date.now() >= deadline) return;
          if (
            !(await input.host.payments.checkpointReconcileGate!({
              claim,
              scheduler,
              now: clock(),
              intervalSeconds,
            }))
          )
            throw new Error("Reconciliation lease expired before finality delivery.");
          streamed.add(check.paymentHash);
          try {
            await reconcileHostPayments({
              service: input.service,
              host: input.host,
              attempts,
              checks: [check],
              clock,
            });
          } catch (error) {
            deliveryFailures.push(error);
          }
        },
      }),
      timeout,
      controller,
    );
    scheduler.windows.pop();
    if (slice.outcome === "continued") {
      const halves =
        scheduler.windows.length === 0
          ? splitWindow(slice.window, clock(), input.overlapSeconds)
          : undefined;
      scheduler.windows.push(...(halves ?? [slice.window]));
    }
    if (slice.outcome === "stalled")
      report(
        new Error(
          "Wallet history made no pagination progress; attempts remain pending and other cohorts will be served.",
        ),
      );
    if (
      !(await input.host.payments.checkpointReconcileGate({
        claim,
        scheduler,
        now: clock(),
        release: true,
        intervalSeconds,
      }))
    )
      return { reason: "gate_busy" };
    await reconcileHostPayments({
      service: input.service,
      host: input.host,
      attempts,
      checks: slice.checks.filter((check) => !streamed.has(check.paymentHash)),
      clock,
    });
    if (deliveryFailures.length > 0)
      throw new AggregateError(
        deliveryFailures,
        "One or more settlement transactions failed; pending attempts will be retried.",
      );
    return { reason: "ran", checks: slice.checks };
  } catch (error) {
    report(error);
    return { reason: "scan_failed" };
  }
}

function withScanTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Abort the history subscription, queued relay connections and publication
    // before rejecting the caller; the next lease must not overlap that walker.
    const timer = setTimeout(() => {
      const error = new Error(`reconcile scan exceeded ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
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

/** Split broad cohorts on a creation-time boundary; never skip same-second rows. */
function splitWindow(
  window: PaymentScanWindow,
  now: number,
  overlap?: number,
): PaymentScanWindow[] | undefined {
  if (!window.attempts.every((attempt) => attempt.created_at_source === "wallet")) return undefined;
  const timestamps = [...new Set(window.attempts.map((attempt) => attempt.created_at))].sort(
    (a, b) => a - b,
  );
  if (timestamps.length < 2) return undefined;
  const boundary = timestamps[Math.floor(timestamps.length / 2)]!;
  return [
    window.attempts.filter((attempt) => attempt.created_at < boundary),
    window.attempts.filter((attempt) => attempt.created_at >= boundary),
  ].map((attempts) => createPaymentScanWindow(attempts, now, overlap));
}
