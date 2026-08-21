import type { PaymentDetails } from "@openreceive/core";
import { sanitizeOpenReceiveEvent } from "@openreceive/node";
import type {
  CheckoutInvoice,
  CreateCheckoutAmount,
  NodeSettlementActionHook,
  OpenReceive,
  PaymentCheck,
  SwapData,
} from "@openreceive/node";
import { hostError } from "./errors.ts";
import type {
  CheckoutCreatedHook,
  CheckoutCreatedInput,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
} from "./handler.ts";
import { maybeReconcileOpenReceivePayments } from "./reconcile-gate.ts";
import {
  createOpenReceiveSqlPayments,
  type OpenReceiveOrderSettlementHook,
  type OpenReceiveSqlDatabase,
} from "./sql-payments.ts";

/** Seconds of remaining life required before a live attempt is reused instead of reminted. */
export const OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS = 60 as const;

/**
 * Seconds past an attempt's expiry during which reconciliation still scans for a
 * settlement before closing the attempt. Covers clock skew and wallets that
 * accept a payment moments after nominal invoice expiry.
 */
export const OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS = 900 as const;

/**
 * Lifecycle of one payment attempt. `pending` attempts participate in
 * reconciliation; every other status is terminal for reconciliation purposes.
 * `attention` marks rows that need operator review: the wallet still
 * explicitly reports an in-flight transaction state long after invoice expiry.
 */
export type OpenReceiveAttemptStatus = "pending" | "settled" | "expired" | "failed" | "attention";

/**
 * The minimal row OpenReceive needs for one invoice or swap attempt.
 * An order may have many of these records. `swapData` must remain server-only.
 */
export interface OpenReceivePaymentRecord {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly status: OpenReceiveAttemptStatus;
  /** Optional operator-facing detail for the current status (e.g. "superseded"). */
  readonly statusReason?: string | null;
  readonly paidAt: number | null;
  /** Unix timestamp after which these payer instructions must not be reused. */
  readonly expiresAt: number;
  /** Unix timestamp used only to choose deterministically between historical attempts. */
  readonly createdAt: number;
  /** Safe, replayable payer response. Contains no wallet or provider credentials. */
  readonly checkout: CheckoutInvoice;
  readonly swapData?: SwapData | null;
}

/** How `commitAttempt` should treat one existing unpaid live row vs an incoming insert. */
export type LiveAttemptCommitDecision = "ignore" | "conflict" | "supersede";

export interface OpenReceivePaymentInsert {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly checkout: CheckoutInvoice;
  readonly swapData?: SwapData;
  /** Client IP captured at invoice creation, when the adapter could attribute one. */
  readonly clientIp?: string;
}

/** One pending attempt the reconciler should include in its next wallet scan. */
export interface OpenReceiveReconcilableAttempt {
  readonly paymentHash: string;
  /** Exact NIP-47 invoice creation time returned by make_invoice. */
  readonly createdAt: number;
  /** Unix timestamp after which the attempt can be closed once a scan confirms no settlement. */
  readonly expiresAt: number;
}

/** A terminal (non-settled) state transition observed by reconciliation. */
export interface OpenReceiveReconciliationTransition {
  readonly paymentHash: string;
  readonly status: Exclude<OpenReceiveAttemptStatus, "pending" | "settled">;
  /** Unix timestamp of the wallet scan that justified this transition. */
  readonly observedAt: number;
  /** Operator-facing reason, e.g. "wallet_reported_expired" or "not_found_after_expiry". */
  readonly reason: string;
}

/** One observed wallet settlement, as handed to the repository to record. */
export interface OpenReceiveSettlementRecord {
  readonly paymentHash: string;
  /** Unix timestamp the wallet reports (or the scan observed) the payment at. */
  readonly paidAt: number;
  readonly details?: PaymentDetails;
}

/**
 * Persistence boundary for payment attempts. Most applications use the
 * library-provided SQL repository (`createOpenReceiveSqlPayments`); implementing
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
export interface OpenReceivePaymentRepository {
  listForOrder(orderId: string): Promise<readonly OpenReceivePaymentRecord[]>;
  /**
   * The oldest `pending` attempts, terminal rows excluded. A repository with a
   * large backlog should return an oldest-first batch (the built-in SQL one
   * caps each pass at OPENRECEIVE_RECONCILE_BATCH_SIZE); the remainder is
   * covered by later passes.
   */
  listReconcilableAttempts(): Promise<readonly OpenReceiveReconcilableAttempt[]>;
  commitAttempt(input: CheckoutCreatedInput): void | Promise<void>;
  recordReconciliation(transition: OpenReceiveReconciliationTransition): void | Promise<void>;
  /**
   * Claim the order's first settlement for this attempt and persist it.
   * Returns true only for the call that won the claim — the attempt was still
   * unsettled AND no sibling attempt on the order had settled. Later calls for
   * the same or a sibling attempt must record the settlement (a genuine second
   * payment is not discarded) and return false. A settled attempt is never
   * overwritten, and an unknown payment hash is a no-op returning false.
   */
  recordSettlement(settlement: OpenReceiveSettlementRecord): boolean | Promise<boolean>;
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

/**
 * Warn about a background settlement failure through the same redaction every
 * service log sink applies. A wallet, relay, or database error message can
 * carry an NWC code or a provider token; the default sink must not be the one
 * place that prints it.
 */
export function warnOpenReceiveFailure(event: string, prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeOpenReceiveEvent({ level: "warn", event, message });
  console.warn(`[openreceive] ${prefix}: ${String(sanitized.message)}`);
}

/** True when an unpaid attempt still has more than the reuse buffer remaining. */
export function isReusablePaymentAttempt(expiresAt: number, now = currentUnixSeconds()): boolean {
  return expiresAt - now > OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS;
}

/**
 * Decide whether an existing unpaid live row blocks, should be expired, or is
 * irrelevant to the incoming payment attempt (different Lightning vs swap asset).
 */
export function liveAttemptCommitDecision(
  live: Pick<OpenReceivePaymentRecord, "expiresAt" | "swapData">,
  incoming: Pick<OpenReceivePaymentInsert, "swapData">,
  now = currentUnixSeconds(),
): LiveAttemptCommitDecision {
  if (!sameRailAndAsset(live, incoming)) return "ignore";
  return isReusablePaymentAttempt(live.expiresAt, now) ? "conflict" : "supersede";
}

interface CreateOpenReceiveHostBaseOptions<Order> {
  readonly loadOrder: (
    orderId: string,
    context: ResolveCheckoutContext,
  ) => Order | null | Promise<Order | null>;
  readonly amountForOrder: (
    order: Order,
    context: ResolveCheckoutContext,
  ) => CreateCheckoutAmount | Promise<CreateCheckoutAmount>;
  readonly clock?: () => number;
}

/**
 * Default mode: OpenReceive owns the payment-attempt rows in the host
 * application's existing database. `onPaid` runs inside the settlement
 * transaction for the order's first settled attempt only.
 */
export interface CreateOpenReceiveHostDbOptions<Order>
  extends CreateOpenReceiveHostBaseOptions<Order> {
  readonly db: OpenReceiveSqlDatabase;
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  readonly onPaid: OpenReceiveOrderSettlementHook;
  readonly payments?: never;
  readonly onSettlement?: never;
}

/**
 * Advanced escape hatch: the host implements the full
 * `OpenReceivePaymentRepository` contract, including commit locking, write-once
 * settlement, and reconciliation transitions.
 *
 * The settlement hook here is named `onSettlement` (not `onPaid`) because its
 * contract is different: it receives the raw core settlement event
 * (`paymentHash`, `paidAt`, `details`), with no `orderId` and no transactional
 * `query` — unlike db-mode `onPaid`, which runs inside the library's settlement
 * transaction. Write-once is still the library's: `onSettlement` runs only for
 * the settlement whose `payments.recordSettlement` claim was won, so a
 * redelivered settlement never fulfills twice.
 */
export interface CreateOpenReceiveHostRepositoryOptions<Order>
  extends CreateOpenReceiveHostBaseOptions<Order> {
  readonly payments: OpenReceivePaymentRepository;
  /** Host settlement handler; runs once, for the winning first-settlement claim. */
  readonly onSettlement: NodeSettlementActionHook;
  readonly db?: never;
  readonly tableName?: never;
  readonly onPaid?: never;
}

export type CreateOpenReceiveHostOptions<Order> =
  | CreateOpenReceiveHostDbOptions<Order>
  | CreateOpenReceiveHostRepositoryOptions<Order>;

export interface OpenReceiveHost {
  readonly resolveCheckout: ResolveCheckoutHook;
  readonly onCheckoutCreated: CheckoutCreatedHook;
  readonly onPaid: NodeSettlementActionHook;
  readonly payments: OpenReceivePaymentRepository;
}

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
 * Decide the terminal transition (if any) for one non-settled reconciliation
 * result. `transactionState` is the explicit state field on the wallet's
 * transaction record, when the scan found one; it decides whether a pending
 * result past expiry plus grace is an operator-attention case or just an
 * abandoned invoice.
 */
export function reconciliationTransition(
  attempt: OpenReceiveReconcilableAttempt,
  status: "pending" | "expired" | "failed" | "not_found",
  observedAt: number,
  transactionState?: string,
): OpenReceiveReconciliationTransition | null {
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

/**
 * Build the mounted-route host integration around an order loader and either
 * the host database handle (`db`, default) or a custom payment repository
 * (`payments`, advanced). Attempt selection, commit locking, settlement
 * write-once, and reconciliation transitions are library-owned in `db` mode.
 */
export function createOpenReceiveHost<Order>(
  options: CreateOpenReceiveHostOptions<Order>,
): OpenReceiveHost {
  if (options?.loadOrder === undefined) {
    throw new TypeError("OpenReceive host requires loadOrder.");
  }
  if (options.amountForOrder === undefined) {
    throw new TypeError("OpenReceive host requires amountForOrder.");
  }
  if (options.onPaid === undefined && options.onSettlement === undefined) {
    throw new TypeError(
      "OpenReceive host requires onPaid (db mode) or onSettlement (custom repository mode).",
    );
  }
  if (options.payments !== undefined && options.onSettlement === undefined) {
    throw new TypeError(
      "OpenReceive host with a custom payments repository requires onSettlement " +
        "(the raw settlement-event hook; db mode's per-order onPaid does not apply).",
    );
  }
  if (options.db !== undefined && options.onPaid === undefined) {
    throw new TypeError("OpenReceive host requires onPaid.");
  }

  let payments: OpenReceivePaymentRepository;
  let onPaid: NodeSettlementActionHook;
  if (options.db !== undefined) {
    const repository = createOpenReceiveSqlPayments(options.db, {
      ...(options.tableName === undefined ? {} : { tableName: options.tableName }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    payments = repository;
    const fulfill = options.onPaid as OpenReceiveOrderSettlementHook;
    onPaid = async (input) => {
      await repository.markPaidOnce(input, fulfill);
    };
  } else {
    if (options.payments?.listForOrder === undefined) {
      throw new TypeError("OpenReceive host requires db or payments.listForOrder.");
    }
    if (options.payments.commitAttempt === undefined) {
      throw new TypeError("OpenReceive host requires payments.commitAttempt.");
    }
    if (options.payments.listReconcilableAttempts === undefined) {
      throw new TypeError("OpenReceive host requires payments.listReconcilableAttempts.");
    }
    if (options.payments.recordReconciliation === undefined) {
      throw new TypeError("OpenReceive host requires payments.recordReconciliation.");
    }
    if (typeof options.payments.recordSettlement !== "function") {
      throw new TypeError(
        "OpenReceive host requires payments.recordSettlement (the write-once settlement claim).",
      );
    }
    payments = options.payments;
    const custom = options.payments;
    const notify = options.onSettlement as NodeSettlementActionHook;
    // Write-once stays library-owned in custom-repository mode too: the
    // repository claims the settlement and the host is told only when the claim
    // is won, so a redelivered settlement event fulfills exactly once.
    onPaid = async (settlement) => {
      const claimed = await custom.recordSettlement({
        paymentHash: settlement.paymentHash,
        paidAt: settlement.paidAt,
        ...(settlement.details === undefined ? {} : { details: settlement.details }),
      });
      if (claimed) await notify(settlement);
    };
  }

  const clock = options.clock ?? currentUnixSeconds;
  const resolveCheckout: ResolveCheckoutHook = async (context) => {
    const order = await options.loadOrder(context.orderId, context);
    if (order === null) throw hostError("Order not found.", 404, "NOT_FOUND");

    // Pricing runs only where a price is minted or quoted. Status polls and
    // refund recovery for committed attempts must not depend on (or wait for)
    // the host's pricing callback.
    if (context.action === "swap.quote" || context.action === "checkout.prepare") {
      return { amount: await options.amountForOrder(order, context) };
    }
    const isCreate = context.action === "checkout.create" || context.action === "swap.create";
    const amount = isCreate ? await options.amountForOrder(order, context) : undefined;

    const attempts = normalizePayments(
      context.orderId,
      await payments.listForOrder(context.orderId),
    );
    const requestedHash = paymentHashHint(context.input);

    if (requestedHash !== undefined) {
      const selected = attempts.find((payment) => payment.paymentHash === requestedHash);
      if (selected === undefined) {
        throw hostError("Payment attempt not found for this order.", 404, "NOT_FOUND");
      }
      // A hash-hinted CREATE may only re-serve a reusable pending attempt.
      // Without this, a settled or expired attempt would be re-served 201 with
      // stale payer instructions, bypassing the paid/expired guards below.
      if (context.action === "checkout.create" || context.action === "swap.create") {
        if (attempts.some((payment) => payment.status === "settled")) {
          throw hostError("This order is already paid.", 409, "CONFLICT");
        }
        const now = clock();
        if (
          !isLivePaymentAttempt(selected, now) ||
          !isReusablePaymentAttempt(selected.expiresAt, now) ||
          !matchesCreateAction(selected, context.action, context.payInAsset)
        ) {
          throw hostError(
            "The selected payment attempt is not a reusable pending checkout.",
            409,
            "CONFLICT",
          );
        }
      }
      return resolvedPayment(amount, selected);
    }

    if (context.action === "checkout.create" || context.action === "swap.create") {
      if (attempts.some((payment) => payment.status === "settled")) {
        throw hostError("This order is already paid.", 409, "CONFLICT");
      }

      const now = clock();
      const matching = attempts.filter(
        (payment) =>
          isLivePaymentAttempt(payment, now) &&
          matchesCreateAction(payment, context.action, context.payInAsset),
      );
      if (matching.length > 1) {
        throw hostError(
          "This order already has unpaid checkouts in progress for this payment method; wait for them to expire before creating another.",
          409,
          "CONFLICT",
        );
      }
      const selected = matching[0];
      if (selected === undefined) return { amount };
      // Reuse while comfortably before expiry; otherwise mint a replacement.
      if (!isReusablePaymentAttempt(selected.expiresAt, now)) return { amount };
      return resolvedPayment(amount, selected);
    }

    // Every remaining action addresses one specific attempt; the HTTP routes
    // all require payment_hash, so a hash-less call here is a caller bug.
    throw hostError("payment_hash is required for this action.", 400, "INVALID_REQUEST");
  };

  return {
    resolveCheckout,
    onCheckoutCreated: (input) => payments.commitAttempt(input),
    onPaid,
    payments,
  };
}

/** Convert a checkout callback to the values common ORM create calls persist. */
export function openReceivePaymentInsert(input: CheckoutCreatedInput): OpenReceivePaymentInsert {
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

function resolvedPayment(
  amount: CreateCheckoutAmount | undefined,
  payment: OpenReceivePaymentRecord,
): ResolvedHostCheckout {
  return {
    ...(amount === undefined ? {} : { amount }),
    paymentHash: payment.paymentHash,
    checkout: structuredClone(payment.checkout),
    ...(payment.swapData === undefined || payment.swapData === null
      ? {}
      : { swapData: payment.swapData }),
  };
}

/** The Ruby `live_at` model: pending, not superseded, and not yet expired. */
function isLivePaymentAttempt(
  payment: Pick<OpenReceivePaymentRecord, "status" | "statusReason" | "expiresAt">,
  now: number,
): boolean {
  return (
    payment.status === "pending" && payment.statusReason !== "superseded" && payment.expiresAt > now
  );
}

function matchesCreateAction(
  payment: OpenReceivePaymentRecord,
  action: ResolveCheckoutContext["action"],
  payInAsset: string | undefined,
): boolean {
  const isSwap = payment.swapData !== undefined && payment.swapData !== null;
  if (action === "checkout.create") return !isSwap;
  if (action !== "swap.create") return false;
  if (!isSwap) return false;
  if (payInAsset === undefined) return true;
  return payment.swapData?.providerOrder.pay_in_asset === payInAsset;
}

function sameRailAndAsset(
  left: Pick<OpenReceivePaymentRecord, "swapData">,
  right: Pick<OpenReceivePaymentInsert, "swapData">,
): boolean {
  const leftSwap = left.swapData ?? null;
  const rightSwap = right.swapData ?? null;
  if (leftSwap === null && rightSwap === null) return true;
  if (leftSwap === null || rightSwap === null) return false;
  return leftSwap.providerOrder.pay_in_asset === rightSwap.providerOrder.pay_in_asset;
}

function normalizePayments(
  expectedOrderId: string,
  values: readonly OpenReceivePaymentRecord[],
): readonly OpenReceivePaymentRecord[] {
  return values
    .map((payment) => {
      if (payment.orderId !== expectedOrderId) {
        throw new TypeError("Payment repository returned a row for another order.");
      }
      return {
        ...payment,
        paymentHash: normalizePaymentHash(payment.paymentHash),
      };
    })
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.paymentHash.localeCompare(left.paymentHash),
    );
}

function paymentHashHint(input: Readonly<Record<string, unknown>>): string | undefined {
  const value = input.payment_hash ?? input.paymentHash;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw hostError("payment_hash must be a string.", 400, "INVALID_REQUEST");
  }
  return normalizePaymentHash(value);
}

function normalizePaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw hostError("payment_hash must be 64 hexadecimal characters.", 400, "INVALID_REQUEST");
  }
  return normalized;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
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
