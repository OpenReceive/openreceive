import type { OpenReceive, PaymentCheck } from "@openreceive/node";
import { type OpenReceiveHost, warnOpenReceiveFailure } from "./host-payments.ts";
import { reconciliationTransition } from "./payment-repository.ts";
import { maybeReconcileOpenReceivePayments } from "./reconcile-gate.ts";

// The wallet-scan side of settlement: one bounded pass over the pending attempts
// (reconcileOpenReceivePayments) and the optional background poller that keeps
// running it (startOpenReceiveReconciler). Both go through the durable gate in
// reconcile-gate.ts, which is what collapses N workers to one real wallet scan
// per interval. The repository contract they act on lives in
// payment-repository.ts; the host integration that owns the repository lives in
// host-payments.ts.

export interface OpenReceiveReconciler {
  stop(): void;
  readonly done: Promise<void>;
}

/**
 * One bounded reconciliation pass: scan the wallet for every pending attempt,
 * deliver settlements at least once, and persist terminal transitions so closed
 * attempts leave the scan set. Attempt closure requires a successful wallet
 * scan at or after expiry plus grace — a local clock alone never closes a row,
 * because a payment could have settled while the application was offline.
 *
 * A walk cut short by its page cap decides nothing: the core scan omits the
 * hashes it could not reach, so those attempts get no transition this pass and
 * stay pending instead of being closed on an unproven `not_found`.
 *
 * Returns the per-hash `PaymentCheck` results of the pass so callers (notably
 * `payments/check`) can serve a requested hash straight from the pass instead
 * of adding a second per-invoice wallet walk. Results are keyed by hash and
 * may cover fewer hashes than were scanned.
 */
export async function reconcileOpenReceivePayments(input: {
  readonly service: OpenReceive;
  readonly host: OpenReceiveHost;
  readonly overlapSeconds?: number;
  readonly maxPages?: number;
  readonly clock?: () => number;
}): Promise<readonly PaymentCheck[]> {
  const clock = input.clock ?? currentUnixSeconds;
  const attempts = await input.host.payments.listReconcilableAttempts();
  if (attempts.length === 0) return [];
  const byHash = new Map(
    attempts.map((attempt) => [attempt.paymentHash.toLowerCase(), attempt] as const),
  );
  const scannedAt = clock();
  const checks = await input.service.reconcilePayments({
    attempts,
    overlapSeconds: input.overlapSeconds,
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
  });
  // One failing delivery or transition must not starve the rest of the pass:
  // each check is isolated, and the failures surface together at the end so
  // the caller's error path (reconciler warn, opportunistic report) sees them.
  const failures: unknown[] = [];
  for (const checked of checks) {
    try {
      const attempt = byHash.get(checked.paymentHash.toLowerCase());
      if (attempt === undefined) continue;
      if (checked.status === "settled") {
        // A settled result without paidAt is malformed; retry it next pass.
        if (checked.paidAt !== undefined) {
          await input.host.onPaid({
            paymentHash: checked.paymentHash,
            paidAt: checked.paidAt,
            details: checked.details,
          });
        }
        continue;
      }
      const walletTransaction = checked.details?.transaction;
      const transition = reconciliationTransition(
        attempt,
        checked.status,
        scannedAt,
        walletTransaction?.state ?? walletTransaction?.transaction_state,
      );
      if (transition !== null) {
        await input.host.payments.recordReconciliation(transition);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const first = failures[0];
    throw new AggregateError(
      failures,
      `reconciliation failed for ${failures.length} of ${checks.length} checks: ` +
        (first instanceof Error ? first.message : String(first)),
    );
  }
  return checks;
}

/**
 * Poll and reconcile only the pending attempts in the ledger. Every pass goes
 * through the durable `claimReconcileGate`, so N worker instances — and the
 * request-path opportunistic reconcile — collapse to one real wallet scan per
 * gate interval instead of each running its own.
 */
export async function startOpenReceiveReconciler(input: {
  readonly service: OpenReceive;
  readonly host: OpenReceiveHost;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly overlapSeconds?: number;
  readonly clock?: () => number;
  /**
   * Observes per-pass failures (wallet, repository, or callback errors). The
   * reconciler always retries from the ledger on the next pass; without this
   * hook failures are reported once per distinct message via console.warn so a
   * permanently failing reconciler is never silent.
   */
  readonly onError?: (error: unknown) => void;
}): Promise<OpenReceiveReconciler> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250) {
    throw new RangeError("pollIntervalMs must be a safe integer of at least 250");
  }
  if (typeof input.host.payments.claimReconcileGate !== "function") {
    throw new TypeError(
      "The reconciler requires payments.claimReconcileGate (a durable CAS gate shared by every " +
        "worker); implement it on the repository so all scan entry points stay within one budget.",
    );
  }
  const overlapSeconds = input.overlapSeconds ?? 60;
  const controller = new AbortController();
  const stop = () => controller.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  let lastWarnedMessage: string | undefined;
  const reportError = (error: unknown): void => {
    if (input.onError !== undefined) {
      try {
        input.onError(error);
      } catch {
        // The error observer must never kill the reconciler loop.
      }
      return;
    }
    // Deduplicate on the message so a persistent outage warns once, not per pass.
    const message = error instanceof Error ? error.message : String(error);
    if (message === lastWarnedMessage) return;
    lastWarnedMessage = message;
    warnOpenReceiveFailure(
      "payment.reconcile.failed",
      "reconciliation pass failed (will retry)",
      error,
    );
  };
  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        // The gated pass never throws: wallet, repository, and callback
        // failures reach reportError and retry from the ledger next pass.
        const result = await maybeReconcileOpenReceivePayments({
          service: input.service,
          host: input.host,
          overlapSeconds,
          onError: reportError,
          ...(input.clock === undefined ? {} : { clock: input.clock }),
        });
        if (result.reason === "ran") lastWarnedMessage = undefined;
        await abortableDelay(pollIntervalMs, controller.signal);
      }
    } finally {
      input.signal?.removeEventListener("abort", stop);
    }
  })();
  return { stop, done };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
