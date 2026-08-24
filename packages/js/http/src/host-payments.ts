import { unixSeconds } from "@openreceive/core";
import { sanitizeEvent } from "@openreceive/node";
import type {
  CreateCheckoutAmount,
  NodeSettlementActionHook,
  NodeSettlementActionInput,
} from "@openreceive/node";
import { hostError } from "./errors.ts";
import type {
  CheckoutCreatedHook,
  ResolveCheckoutContext,
  ResolveCheckoutHook,
  ResolvedHostCheckout,
} from "./handler.ts";
import {
  isReusablePaymentAttempt,
  type PaymentRecord,
  type PaymentRepository,
} from "./payment-repository.ts";
import type { SqlDatabase } from "./sql-adapters.ts";
import { createSqlPayments, type PaymentSettlementHook } from "./sql-payments.ts";

// The mounted-route host integration: turn a host's price hook plus either a
// database handle or a custom repository into the `Host` the handler
// talks to. The repository contract and its decisions live in
// payment-repository.ts; the wallet-scan passes live in reconcile-loop.ts.

/**
 * Warn about a background settlement failure through the same redaction every
 * service log sink applies. A wallet, relay, or database error message can
 * carry an NWC code or a provider token; the default sink must not be the one
 * place that prints it.
 */
export function warnFailure(event: string, prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeEvent({ level: "warn", event, message });
  console.warn(`[openreceive] ${prefix}: ${String(sanitized.message)}`);
}

interface CreateOpenReceiveHostBaseOptions {
  /**
   * The trusted price for a reference, or `null` when there is nothing to
   * pay for (the request is answered 404). Called only where a price is
   * minted or quoted; the payer never sends an amount.
   */
  readonly amountFor: (
    reference: string,
    context: ResolveCheckoutContext,
  ) => CreateCheckoutAmount | null | Promise<CreateCheckoutAmount | null>;
  readonly clock?: () => number;
}

/**
 * Default mode: OpenReceive owns the payment-attempt rows in the host
 * application's existing database. `onPaid` runs inside the settlement
 * transaction for the first settled attempt for a reference only.
 */
export interface CreateHostDbOptions extends CreateOpenReceiveHostBaseOptions {
  readonly db: SqlDatabase;
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  readonly onPaid: PaymentSettlementHook;
  readonly payments?: never;
}

/**
 * Settlement context passed to repository-mode `onPaid`: the raw core
 * settlement event (`paymentHash`, `paidAt`, `details`). Unlike db-mode's
 * {@link PaymentSettlement} it carries no `reference` and no
 * transactional `query` — the custom repository owns that mapping.
 */
export type SettlementEvent = NodeSettlementActionInput;

export type SettlementEventHook = (settlement: SettlementEvent) => void | Promise<void>;

/**
 * Advanced escape hatch: the host implements the full
 * `PaymentRepository` contract, including commit locking, write-once
 * settlement, and reconciliation transitions.
 *
 * The settlement hook is `onPaid` in this mode too, but its context type
 * differs from db mode: it receives the raw {@link SettlementEvent}
 * (`paymentHash`, `paidAt`, `details`), with no `reference` and no transactional
 * `query` — unlike db-mode `onPaid`, which runs inside the library's settlement
 * transaction. Write-once is still the library's: repository-mode `onPaid`
 * runs only for the settlement whose `payments.recordSettlement` claim was
 * won, so a redelivered settlement never fulfills twice.
 */
export interface CreateHostRepositoryOptions extends CreateOpenReceiveHostBaseOptions {
  readonly payments: PaymentRepository;
  /** Host settlement handler; runs once, for the winning first-settlement claim. */
  readonly onPaid: SettlementEventHook;
  readonly db?: never;
  readonly tableName?: never;
}

export type CreateHostOptions = CreateHostDbOptions | CreateHostRepositoryOptions;

export interface Host {
  readonly resolveCheckout: ResolveCheckoutHook;
  readonly onCheckoutCreated: CheckoutCreatedHook;
  readonly onPaid: NodeSettlementActionHook;
  readonly payments: PaymentRepository;
}

/**
 * Build the mounted-route host integration around the host's price hook and
 * either the host database handle (`db`, default) or a custom payment
 * repository (`payments`, advanced). Attempt selection, commit locking,
 * settlement write-once, and reconciliation transitions are library-owned in
 * `db` mode.
 */
export function createHost(options: CreateHostOptions): Host {
  if (options?.amountFor === undefined) {
    throw new TypeError("OpenReceive host requires amountFor.");
  }
  if (options.onPaid === undefined) {
    throw new TypeError(
      "OpenReceive host requires onPaid (per-reference settlement context in db mode; the raw " +
        "settlement event in custom repository mode).",
    );
  }

  let payments: PaymentRepository;
  let onPaid: NodeSettlementActionHook;
  if (options.db !== undefined) {
    const repository = createSqlPayments(options.db, {
      ...(options.tableName === undefined ? {} : { tableName: options.tableName }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    payments = repository;
    const fulfill = options.onPaid as PaymentSettlementHook;
    onPaid = async (input) => {
      await repository.markPaidOnce(input, fulfill);
    };
  } else {
    if (options.payments?.listForReference === undefined) {
      throw new TypeError("OpenReceive host requires db or payments.listForReference.");
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
    const notify = options.onPaid as SettlementEventHook;
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

  const clock = options.clock ?? unixSeconds;
  // The host is asked only where a price is minted or quoted. Status polls and
  // refund recovery for committed attempts are answered from OpenReceive's own
  // rows and never depend on (or wait for) the host's price hook.
  const priceFor = async (context: ResolveCheckoutContext): Promise<CreateCheckoutAmount> => {
    const amount = await options.amountFor(context.reference, context);
    if (amount === null) throw hostError("Unknown reference.", 404, "NOT_FOUND");
    return amount;
  };
  const resolveCheckout: ResolveCheckoutHook = async (context) => {
    if (context.action === "swap.quote" || context.action === "checkout.prepare") {
      return { amount: await priceFor(context) };
    }
    const isCreate = context.action === "checkout.create" || context.action === "swap.create";
    const amount = isCreate ? await priceFor(context) : undefined;

    const attempts = normalizePayments(await payments.listForReference(context.reference));
    const requestedHash = paymentHashHint(context.input);

    if (requestedHash !== undefined) {
      const selected = attempts.find((payment) => payment.paymentHash === requestedHash);
      if (selected === undefined) {
        throw hostError("Payment attempt not found for this reference.", 404, "NOT_FOUND");
      }
      // A hash-hinted CREATE may only re-serve a reusable pending attempt.
      // Without this, a settled or expired attempt would be re-served 201 with
      // stale payer instructions, bypassing the paid/expired guards below.
      //
      // UNREACHABLE OVER HTTP: assertDeclaredFields rejects `payment_hash` on
      // checkout.create / swap.create, so only a caller invoking this
      // resolveCheckout directly (not through the mounted handler) can get
      // here. Kept because such a caller can, not because the wire can.
      if (context.action === "checkout.create" || context.action === "swap.create") {
        if (attempts.some((payment) => payment.status === "settled")) {
          throw hostError("This reference is already paid.", 409, "CONFLICT");
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
        throw hostError("This reference is already paid.", 409, "CONFLICT");
      }

      const now = clock();
      const matching = attempts.filter(
        (payment) =>
          isLivePaymentAttempt(payment, now) &&
          matchesCreateAction(payment, context.action, context.payInAsset),
      );
      if (matching.length > 1) {
        throw hostError(
          "This reference has multiple unpaid checkouts in progress for this payment method; wait for them to expire before creating another.",
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

function resolvedPayment(
  amount: CreateCheckoutAmount | undefined,
  payment: PaymentRecord,
): ResolvedHostCheckout {
  return {
    ...(amount === undefined ? {} : { amount }),
    paymentHash: payment.paymentHash,
    checkout: structuredClone(payment.checkout),
    // Carried so `payments/check` can serve the row path without re-listing
    // the rows this resolver just read.
    attemptStatus: { status: payment.status, paidAt: payment.paidAt },
    ...(payment.swapData === undefined || payment.swapData === null
      ? {}
      : { swapData: payment.swapData }),
  };
}

/** The Ruby `live_at` model: pending, not superseded, and not yet expired. */
function isLivePaymentAttempt(
  payment: Pick<PaymentRecord, "status" | "statusReason" | "expiresAt">,
  now: number,
): boolean {
  return (
    payment.status === "pending" && payment.statusReason !== "superseded" && payment.expiresAt > now
  );
}

function matchesCreateAction(
  payment: PaymentRecord,
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

function normalizePayments(values: readonly PaymentRecord[]): readonly PaymentRecord[] {
  return values
    .map((payment) => ({
      ...payment,
      paymentHash: storedPaymentHash(payment.paymentHash),
    }))
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.paymentHash.localeCompare(left.paymentHash),
    );
}

/**
 * The request body's `payment_hash`, when it carries one. Only `payment.check`,
 * `swap.read` and `swap.refund` may declare it (see ROUTE_BODY_FIELDS); the
 * wire is snake_case, so there is no camelCase alias to read.
 */
function paymentHashHint(input: Readonly<Record<string, unknown>>): string | undefined {
  const value = input.payment_hash;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw hostError("payment_hash must be a string.", 400, "INVALID_REQUEST");
  }
  return normalizePaymentHash(value);
}

/** The payer's `payment_hash` hint: malformed input is a payer 400. */
function normalizePaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw hostError("payment_hash must be 64 hexadecimal characters.", 400, "INVALID_REQUEST");
  }
  return normalized;
}

/**
 * A hash read back out of the repository. Malformed here means the STORED row
 * is wrong — a repository or storage bug — so it must not surface as a
 * payer-blaming 400. Same distinction the handler's hostPaymentHash makes for
 * resolver-supplied hashes.
 */
function storedPaymentHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw hostError(
      "The payment repository returned a row with a malformed payment hash.",
      500,
      "INTERNAL",
    );
  }
  return normalized;
}
