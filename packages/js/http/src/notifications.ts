import {
  classifyTransactionSettlement,
  OpenReceiveError,
  unixSeconds,
  type NwcTransaction,
} from "@openreceive/core";
import type { OpenReceive, WalletNotification } from "@openreceive/node";
import { type Host, warnFailure } from "./host-payments.ts";
import { maybeReconcilePayments } from "./reconcile-gate.ts";
import { startReconciler } from "./reconcile-loop.ts";

export interface NotificationListener {
  /** Unsubscribe from wallet notifications and wait for any in-flight pass. */
  stop(): Promise<void> | void;
}

/**
 * Opt-in NWC-02 notification listener. Notifications are authenticated wallet
 * data: a `payment_received` payload that satisfies the settlement rule
 * (`settled_at` or a settled transaction state — never a preimage alone) and
 * matches a pending attempt settles that attempt directly through
 * `host.onPaid`, with no redundant wallet scan for that invoice. Anything less
 * — no payload, no finality signal, or an unknown/not-pending hash — wakes one
 * reconcile pass instead, claimed through the durable scan gate so listeners,
 * workers, and the request path share one wallet-scan budget. Bursts coalesce:
 * while a pass runs, at most one follow-up pass is queued. Errors go to
 * `onError` (default: a sanitized console.warn); a direct-settlement failure
 * also falls back to a scan so the safety net covers it. The polling
 * reconciler remains the safety net for
 * notifications missed while offline. Direct settlement assumes the NWC client
 * binds notification decryption to the connection's wallet pubkey (the bundled
 * SDK does).
 */
export async function startNotificationListener(input: {
  readonly service: OpenReceive;
  readonly host: Host;
  readonly overlapSeconds?: number;
  readonly onError?: (error: unknown) => void;
}): Promise<NotificationListener> {
  const subscribe = input.service.subscribeWalletNotifications?.bind(input.service);
  if (subscribe === undefined) {
    throw new OpenReceiveError({
      code: "UNSUPPORTED_METHOD",
      message:
        "OpenReceive service does not support wallet notifications (subscribeWalletNotifications). Keep polling reconciliation.",
      retryable: false,
    });
  }
  if (typeof input.host.payments.claimReconcileGate !== "function") {
    throw new TypeError(
      "The notification listener requires payments.claimReconcileGate (a durable CAS gate shared " +
        "by every worker); implement it on the repository so all scan entry points stay within one budget.",
    );
  }
  const reportError = (error: unknown) => {
    if (input.onError === undefined) {
      warnFailure(
        "payment.notification.failed",
        "notification listener failed (polling remains the safety net)",
        error,
      );
      return;
    }
    try {
      input.onError(error);
    } catch {
      // The error sink must never break the listener; polling remains the safety net.
    }
  };

  let stopped = false;
  let running = false;
  let queued = false;
  let inFlight: Promise<void> = Promise.resolve();
  let settling: Promise<void> = Promise.resolve();

  const wakeReconciliation = () => {
    if (stopped) return;
    if (running) {
      // Coalesce notification bursts into at most one queued follow-up pass.
      queued = true;
      return;
    }
    running = true;
    inFlight = (async () => {
      try {
        do {
          queued = false;
          // Durably gated: a pass another worker just ran (gate_busy) is not
          // repeated, so notification bursts never exceed the scan budget.
          await maybeReconcilePayments({
            service: input.service,
            host: input.host,
            onError: reportError,
            ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds }),
          });
        } while (queued && !stopped);
      } finally {
        running = false;
      }
    })();
  };

  /**
   * Is this hash still a pending attempt? Asked by hash where the repository
   * can answer that way — `listReconcilableAttempts` is an oldest-first batch,
   * so a notified attempt sitting behind a batch-sized backlog would read as
   * unknown and lose exactly the shortcut notifications exist to provide.
   */
  const isPendingAttempt = async (paymentHash: string): Promise<boolean> => {
    const payments = input.host.payments;
    if (payments.findPendingAttempt !== undefined) {
      return (await payments.findPendingAttempt(paymentHash)) !== undefined;
    }
    const attempts = await payments.listReconcilableAttempts();
    return attempts.some((attempt) => attempt.paymentHash.toLowerCase() === paymentHash);
  };

  /**
   * Settle one notified payment directly when the payload proves finality and
   * the hash is a known pending attempt; otherwise fall back to a bounded
   * reconciliation scan. Settling removes the attempt from the pending set, so
   * the poll loop never scans that invoice again.
   */
  const settleDirectly = async (
    transaction: NwcTransaction,
    notifiedHash: string | undefined,
  ): Promise<void> => {
    if (stopped) return;
    try {
      const detection = classifyTransactionSettlement(transaction);
      const paymentHash = (transaction.payment_hash ?? notifiedHash)?.toLowerCase();
      if (!detection.settled || paymentHash === undefined) {
        wakeReconciliation();
        return;
      }
      if (!(await isPendingAttempt(paymentHash))) {
        // Unknown or already-terminal hash: only a bounded scan may act on it.
        wakeReconciliation();
        return;
      }
      const observedAt = unixSeconds();
      await input.host.onPaid({
        paymentHash,
        paidAt: transaction.settled_at ?? observedAt,
        details: {
          transaction,
          observed_at: observedAt,
          paid_at_source: transaction.settled_at === undefined ? "observed_at" : "settled_at",
        },
      });
    } catch (error) {
      reportError(error);
      // Fall back to the scan so the safety net still delivers the settlement.
      wakeReconciliation();
    }
  };

  const unsubscribe = await subscribe((notification: WalletNotification) => {
    if (notification.type !== "payment_received") return;
    const transaction = notification.transaction;
    if (transaction === undefined) {
      wakeReconciliation();
      return;
    }
    // Serialize direct settlements so stop() can await them.
    settling = settling.then(() => settleDirectly(transaction, notification.payment_hash));
  });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await unsubscribe();
      } catch (error) {
        reportError(error);
      }
      await settling;
      await inFlight;
    },
  };
}

export interface NotificationWorker {
  /** Unsubscribe, stop the periodic pass, and wait for in-flight work. */
  stop(): Promise<void>;
  /** Resolves after `stop()` once the periodic loop has drained. */
  readonly done: Promise<void>;
}

/**
 * The OPTIONAL case-2 worker: one separate long-lived process that both
 * listens for NWC-02 `payment_received` notifications AND runs the same
 * one-pass reconcile on an interval — the safety net for notifications missed
 * while this worker was down. The web process never does this; its default is
 * request-path opportunistic reconcile. Every pass — worker or web — claims
 * the same durable scan gate, so running both never double-scans the wallet.
 * A wallet without notification support degrades to the periodic pass alone
 * (reported via `onError`).
 *
 * There is no host-aware CLI for this: wire it from a small host script that
 * owns `service` and `host` (see the scaffold wiring guide).
 */
export async function startNotificationWorker(input: {
  readonly service: OpenReceive;
  readonly host: Host;
  /** Periodic safety-net pass interval. Default 15 seconds. */
  readonly pollIntervalMs?: number;
  readonly overlapSeconds?: number;
  readonly onError?: (error: unknown) => void;
}): Promise<NotificationWorker> {
  const reconciler = await startReconciler({
    service: input.service,
    host: input.host,
    pollIntervalMs: input.pollIntervalMs ?? 15_000,
    ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
  });
  let listener: NotificationListener | undefined;
  try {
    listener = await startNotificationListener({
      service: input.service,
      host: input.host,
      ...(input.overlapSeconds === undefined ? {} : { overlapSeconds: input.overlapSeconds }),
      ...(input.onError === undefined ? {} : { onError: input.onError }),
    });
  } catch (error) {
    if (error instanceof OpenReceiveError && error.code === "UNSUPPORTED_METHOD") {
      // Notifications are opt-in wallet capability; the periodic pass still runs.
      if (input.onError === undefined) {
        warnFailure(
          "payment.notification.unsupported",
          "wallet lacks NWC notifications; running the periodic pass alone",
          error,
        );
      } else {
        input.onError(error);
      }
    } else {
      reconciler.stop();
      await reconciler.done;
      throw error;
    }
  }
  return {
    async stop() {
      await listener?.stop();
      reconciler.stop();
      await reconciler.done;
    },
    done: reconciler.done,
  };
}
