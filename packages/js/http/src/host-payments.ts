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
import { createSqlPayments, type OrderSettlementHook } from "./sql-payments.ts";

// The mounted-route host integration: turn a host's order loader plus either a
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
  readonly db: SqlDatabase;
  /** Payment attempts table name. Default `openreceive_payments`. */
  readonly tableName?: string;
  readonly onPaid: OrderSettlementHook;
  readonly payments?: never;
}

/**
 * Settlement context passed to repository-mode `onPaid`: the raw core
 * settlement event (`paymentHash`, `paidAt`, `details`). Unlike db-mode's
 * {@link OrderSettlement} it carries no `orderId` and no
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
 * (`paymentHash`, `paidAt`, `details`), with no `orderId` and no transactional
 * `query` — unlike db-mode `onPaid`, which runs inside the library's settlement
 * transaction. Write-once is still the library's: repository-mode `onPaid`
 * runs only for the settlement whose `payments.recordSettlement` claim was
 * won, so a redelivered settlement never fulfills twice.
 */
export interface CreateOpenReceiveHostRepositoryOptions<Order>
  extends CreateOpenReceiveHostBaseOptions<Order> {
  readonly payments: PaymentRepository;
  /** Host settlement handler; runs once, for the winning first-settlement claim. */
  readonly onPaid: SettlementEventHook;
  readonly db?: never;
  readonly tableName?: never;
}

export type CreateOpenReceiveHostOptions<Order> =
  | CreateOpenReceiveHostDbOptions<Order>
  | CreateOpenReceiveHostRepositoryOptions<Order>;

export interface Host {
  readonly resolveCheckout: ResolveCheckoutHook;
  readonly onCheckoutCreated: CheckoutCreatedHook;
  readonly onPaid: NodeSettlementActionHook;
  readonly payments: PaymentRepository;
}

/**
 * Build the mounted-route host integration around an order loader and either
 * the host database handle (`db`, default) or a custom payment repository
 * (`payments`, advanced). Attempt selection, commit locking, settlement
 * write-once, and reconciliation transitions are library-owned in `db` mode.
 */
export function createHost<Order>(options: CreateOpenReceiveHostOptions<Order>): Host {
  if (options?.loadOrder === undefined) {
    throw new TypeError("OpenReceive host requires loadOrder.");
  }
  if (options.amountForOrder === undefined) {
    throw new TypeError("OpenReceive host requires amountForOrder.");
  }
  if (options.onPaid === undefined) {
    throw new TypeError(
      "OpenReceive host requires onPaid (per-order settlement context in db mode; the raw " +
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
    const fulfill = options.onPaid as OrderSettlementHook;
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

function resolvedPayment(
  amount: CreateCheckoutAmount | undefined,
  payment: PaymentRecord,
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

function normalizePayments(
  expectedOrderId: string,
  values: readonly PaymentRecord[],
): readonly PaymentRecord[] {
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
