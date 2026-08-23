import {
  type TransactionSettlementStatus,
  unixSeconds,
  type PaymentDetails,
} from "@openreceive/core";
import type { Checkout, SwapData } from "@openreceive/node";
import type { CheckoutCreatedInput } from "./handler.ts";

// The payment-attempt repository contract: the row shape OpenReceive needs, the
// operations a host repository must provide, and the three pure decisions the
// library makes about a row — is an unpaid attempt still reusable, does a live
// row block an incoming attempt, and what terminal transition (if any) a
// reconciliation result justifies.
//
// These three functions ARE the settlement state machine: getting them subtly
// wrong orphans settlements, so they are pinned by cross-language spec vectors
// (spec/test-vectors, tests/sql-payments.test.mjs) and the Ruby engine
// implements the same rules independently. Change them only with the vectors,
// never to tidy a signature.

/** Seconds of remaining life required before a live attempt is reused instead of reminted. */
export const OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS = 60 as const;

/**
 * Seconds past an attempt's expiry during which reconciliation still scans for a
 * settlement before closing the attempt. Covers clock skew and wallets that
 * accept a payment moments after nominal invoice expiry.
 */
export const OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS = 900 as const;

/**
 * Lifecycle of one payment attempt: {@link TransactionSettlementStatus} plus
 * `attention`. `pending` attempts participate in reconciliation; every other
 * status is terminal for reconciliation purposes. `attention` marks rows an
 * operator must review before the attempt moves on: the wallet still
 * explicitly reports an in-flight transaction state long after invoice expiry.
 */
export type AttemptStatus = TransactionSettlementStatus | "attention";

/**
 * The minimal row OpenReceive needs for one invoice or swap attempt.
 * An order may have many of these records. `swapData` must remain server-only.
 */
export interface PaymentRecord {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly status: AttemptStatus;
  /** Optional operator-facing detail for the current status (e.g. "superseded"). */
  readonly statusReason?: string | null;
  readonly paidAt: number | null;
  /** Unix timestamp after which these payer instructions must not be reused. */
  readonly expiresAt: number;
  /** Unix timestamp used only to choose deterministically between historical attempts. */
  readonly createdAt: number;
  /** Safe, replayable payer response. Contains no wallet or provider credentials. */
  readonly checkout: Checkout;
  readonly swapData?: SwapData | null;
}

/** How `commitAttempt` should treat one existing unpaid live row vs an incoming insert. */
export type LiveAttemptCommitDecision = "ignore" | "conflict" | "supersede";

export interface PaymentInsert {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly checkout: Checkout;
  readonly swapData?: SwapData;
  /** Client IP captured at invoice creation, when the adapter could attribute one. */
  readonly clientIp?: string;
}

/** One pending attempt the reconciler should include in its next wallet scan. */
export interface ReconcilableAttempt {
  readonly paymentHash: string;
  /** Exact NIP-47 invoice creation time returned by make_invoice. */
  readonly createdAt: number;
  /** Unix timestamp after which the attempt can be closed once a scan confirms no settlement. */
  readonly expiresAt: number;
}

/** A terminal (non-settled) state transition observed by reconciliation. */
export interface ReconciliationTransition {
  readonly paymentHash: string;
  readonly status: Exclude<AttemptStatus, "pending" | "settled">;
  /** Unix timestamp of the wallet scan that justified this transition. */
  readonly observedAt: number;
  /** Operator-facing reason, e.g. "wallet_reported_expired" or "not_found_after_expiry". */
  readonly reason: string;
}

/** One observed wallet settlement, as handed to the repository to record. */
export interface SettlementRecord {
  readonly paymentHash: string;
  /** Unix timestamp the wallet reports (or the scan observed) the payment at. */
  readonly paidAt: number;
  readonly details?: PaymentDetails;
}

/**
 * Persistence boundary for payment attempts. Most applications use the
 * library-provided SQL repository (`createSqlPayments`); implementing
 * this interface directly is the advanced escape hatch.
 *
 * `commitAttempt` must serialize concurrent creates for one order, reject a
 * settled order or a reusable live attempt on the same rail/asset, supersede a
 * near-expiry same-rail attempt, and commit before it returns. Other rails may
 * remain live so the payer can switch methods. The HTTP handler withholds payer
 * instructions when this method throws.
 *
 * `recordReconciliation` must apply the transition only while the row is still
 * `pending` — it must never overwrite a settled attempt.
 *
 * `recordSettlement` is the write-once settlement claim: the library calls it
 * for every observed settlement and runs the host's own handler only when the
 * call reports the claim won, so a redelivered settlement fulfills once.
 */
export interface PaymentRepository {
  listForOrder(orderId: string): Promise<readonly PaymentRecord[]>;
  /**
   * The oldest `pending` attempts, terminal rows excluded. A repository with a
   * large backlog should return an oldest-first batch (the built-in SQL one
   * caps each pass at OPENRECEIVE_RECONCILE_BATCH_SIZE); the remainder is
   * covered by later passes.
   */
  listReconcilableAttempts(): Promise<readonly ReconcilableAttempt[]>;
  commitAttempt(input: CheckoutCreatedInput): void | Promise<void>;
  recordReconciliation(transition: ReconciliationTransition): void | Promise<void>;
  /**
   * Claim the order's first settlement for this attempt and persist it.
   * Returns true only for the call that won the claim — the attempt was still
   * unsettled AND no sibling attempt on the order had settled. Later calls for
   * the same or a sibling attempt must record the settlement (a genuine second
   * payment is not discarded) and return false. A settled attempt is never
   * overwritten, and an unknown payment hash is a no-op returning false.
   */
  recordSettlement(settlement: SettlementRecord): boolean | Promise<boolean>;
  /**
   * Count attempt rows recorded for this client IP at or after `sinceUnixSeconds`.
   * Backs the handler's opt-in `rateLimiting` option; when a custom repository
   * omits it, enabling `rateLimiting` fails at construction (there is no
   * in-memory fallback — use a custom `rateLimitHook` instead).
   */
  countAttemptsFromIp?(clientIp: string, sinceUnixSeconds: number): number | Promise<number>;
  /**
   * Claim the durable global reconcile gate: return true when this caller may
   * run a wallet scan now, false when another worker scanned within
   * `intervalSeconds` (`gate_busy`). The claim MUST be a durable compare-and-set
   * shared by every process on the host database (the built-in SQL repository
   * uses the `openreceive_meta` key/value/rev table) — process-local memory
   * cannot coordinate multiple workers and must never back this. Backs the
   * handler's default opportunistic reconcile; when a custom repository omits
   * it, construction throws unless `opportunisticReconcile: false` — the
   * default settlement path never degrades silently.
   */
  claimReconcileGate?(input: {
    readonly now: number;
    readonly intervalSeconds: number;
  }): boolean | Promise<boolean>;
}

/** True when an unpaid attempt still has more than the reuse buffer remaining. */
export function isReusablePaymentAttempt(expiresAt: number, now = unixSeconds()): boolean {
  return expiresAt - now > OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS;
}

/**
 * Decide whether an existing unpaid live row blocks, should be expired, or is
 * irrelevant to the incoming payment attempt (different Lightning vs swap asset).
 */
export function liveAttemptCommitDecision(
  live: Pick<PaymentRecord, "expiresAt" | "swapData">,
  incoming: Pick<PaymentInsert, "swapData">,
  now = unixSeconds(),
): LiveAttemptCommitDecision {
  if (!sameRailAndAsset(live, incoming)) return "ignore";
  return isReusablePaymentAttempt(live.expiresAt, now) ? "conflict" : "supersede";
}

function sameRailAndAsset(
  left: Pick<PaymentRecord, "swapData">,
  right: Pick<PaymentInsert, "swapData">,
): boolean {
  const leftSwap = left.swapData ?? null;
  const rightSwap = right.swapData ?? null;
  if (leftSwap === null && rightSwap === null) return true;
  if (leftSwap === null || rightSwap === null) return false;
  return leftSwap.providerOrder.pay_in_asset === rightSwap.providerOrder.pay_in_asset;
}

/**
 * Decide the terminal transition (if any) for one non-settled reconciliation
 * result. `transactionState` is the explicit state field on the wallet's
 * transaction record, when the scan found one; it decides whether a pending
 * result past expiry plus grace is an operator-attention case or just an
 * abandoned invoice.
 */
export function reconciliationTransition(
  attempt: ReconcilableAttempt,
  status: "pending" | "expired" | "failed" | "not_found",
  observedAt: number,
  transactionState?: string,
): ReconciliationTransition | null {
  const paymentHash = attempt.paymentHash.toLowerCase();
  if (status === "failed") {
    return { paymentHash, status: "failed", observedAt, reason: "wallet_reported_failed" };
  }
  if (status === "expired") {
    return { paymentHash, status: "expired", observedAt, reason: "wallet_reported_expired" };
  }
  // The invoice may outlive the requested expiry, so closure waits for a scan
  // past expiry plus grace instead of trusting the local clock alone.
  if (observedAt < attempt.expiresAt + OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS) return null;
  if (status === "not_found") {
    return { paymentHash, status: "expired", observedAt, reason: "not_found_after_expiry" };
  }
  // `attention` requires the wallet's EXPLICIT claim that the transaction is
  // still in flight long after expiry. NIP-47 state fields are optional and the
  // unpaid scan lists unpaid invoices, so a state-less record is
  // indistinguishable from an ordinary abandoned invoice — close it as expired.
  if (transactionState === "pending" || transactionState === "accepted") {
    return { paymentHash, status: "attention", observedAt, reason: "unsettled_after_expiry" };
  }
  return { paymentHash, status: "expired", observedAt, reason: "no_finality_after_expiry" };
}

/** Convert a checkout callback to the values common ORM create calls persist. */
export function paymentInsert(input: CheckoutCreatedInput): PaymentInsert {
  return {
    orderId: input.orderId,
    paymentHash: input.paymentHash.toLowerCase(),
    createdAt: input.checkout.createdAt,
    checkout: structuredClone(input.checkout),
    expiresAt: input.swapData?.providerOrder.expires_at ?? input.checkout.expiresAt,
    ...(input.swapData === undefined ? {} : { swapData: input.swapData }),
    ...(input.clientIp === undefined ? {} : { clientIp: input.clientIp }),
  };
}
