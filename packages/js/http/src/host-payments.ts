import type {
  Checkout,
  CreateCheckoutAmount,
  NodeSettlementActionHook,
  OpenReceive,
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

/**
 * The minimal host-owned row OpenReceive needs for one invoice or swap attempt.
 * An order may have many of these records. `swapData` must remain server-only.
 */
export interface OpenReceivePaymentRecord {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly paidAt: number | null;
  /** Unix timestamp after which these payer instructions must not be reused. */
  readonly expiresAt: number;
  /** Unix timestamp used only to choose deterministically between historical attempts. */
  readonly createdAt: number;
  /** Safe, replayable payer response. Contains no wallet or provider credentials. */
  readonly checkout: Checkout;
  readonly swapData?: SwapData | null;
}

export interface OpenReceivePaymentInsert {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly checkout: Checkout;
  readonly swapData?: SwapData;
}

/**
 * ORM boundary implemented by the host application.
 *
 * `commitAttempt` must lock the host order row (or provide an equivalent
 * database serialization boundary), reject a different live attempt, and
 * commit before it returns. The HTTP handler withholds payer instructions when
 * this method throws.
 */
export interface OpenReceivePaymentRepository {
  listForOrder(orderId: string): Promise<readonly OpenReceivePaymentRecord[]>;
  listUnsettledAttempts(): Promise<
    readonly { readonly paymentHash: string; readonly createdAt: number }[]
  >;
  commitAttempt(input: CheckoutCreatedInput): void | Promise<void>;
}

export type OpenReceiveHostRepository = OpenReceivePaymentRepository;

export interface CreateOpenReceiveHostOptions<Order> {
  readonly loadOrder: (
    orderId: string,
    context: ResolveCheckoutContext,
  ) => Order | null | Promise<Order | null>;
  readonly amountForOrder: (
    order: Order,
    context: ResolveCheckoutContext,
  ) => CreateCheckoutAmount | Promise<CreateCheckoutAmount>;
  readonly payments: OpenReceiveHostRepository;
  /** Replay-safe host settlement transaction. */
  readonly onPaid: NodeSettlementActionHook;
  readonly clock?: () => number;
}

export interface OpenReceiveHost {
  readonly resolveCheckout: ResolveCheckoutHook;
  readonly onCheckoutCreated: CheckoutCreatedHook;
  readonly onPaid: NodeSettlementActionHook;
  readonly payments: OpenReceiveHostRepository;
}

export interface OpenReceiveReconciler {
  stop(): void;
  readonly done: Promise<void>;
}

/** Poll and reconcile only the unsettled attempts in the host ledger. */
export async function startOpenReceiveReconciler(input: {
  readonly service: OpenReceive;
  readonly host: OpenReceiveHost;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly overlapSeconds?: number;
}): Promise<OpenReceiveReconciler> {
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250) {
    throw new RangeError("pollIntervalMs must be a safe integer of at least 250");
  }
  const overlapSeconds = input.overlapSeconds ?? 60;
  const controller = new AbortController();
  const stop = () => controller.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          const attempts = await input.host.payments.listUnsettledAttempts();
          const checks = await input.service.reconcilePayments({ attempts, overlapSeconds });
          for (const checked of checks) {
            if (checked.status !== "settled" || checked.paidAt === undefined) continue;
            await input.host.onPaid({
              paymentHash: checked.paymentHash,
              paidAt: checked.paidAt,
              details: checked.details,
            });
          }
        } catch {
          // Wallet, repository, and callback failures retry from the host ledger.
        }
        await abortableDelay(pollIntervalMs, controller.signal);
      }
    } finally {
      input.signal?.removeEventListener("abort", stop);
    }
  })();
  return { stop, done };
}

/**
 * Build the mounted-route host integration around an order loader and an
 * ORM-specific payment repository. This keeps payment selection consistent
 * while leaving transactions and SQL entirely in the host application.
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
  if (options.payments?.listForOrder === undefined) {
    throw new TypeError("OpenReceive host requires payments.listForOrder.");
  }
  if (options.payments.commitAttempt === undefined) {
    throw new TypeError("OpenReceive host requires payments.commitAttempt.");
  }
  if (options.payments.listUnsettledAttempts === undefined) {
    throw new TypeError("OpenReceive host requires payments.listUnsettledAttempts.");
  }
  if (options.onPaid === undefined) {
    throw new TypeError("OpenReceive host requires onPaid.");
  }

  const clock = options.clock ?? currentUnixSeconds;
  const resolveCheckout: ResolveCheckoutHook = async (context) => {
    const order = await options.loadOrder(context.orderId, context);
    if (order === null) throw hostError("Order not found.", 404, "NOT_FOUND");

    const amount = await options.amountForOrder(order, context);
    if (context.action === "swap.quote") return { amount };

    const payments = normalizePayments(
      context.orderId,
      await options.payments.listForOrder(context.orderId),
    );
    const requestedHash = paymentHashHint(context.input);

    if (requestedHash !== undefined) {
      const selected = payments.find((payment) => payment.paymentHash === requestedHash);
      if (selected === undefined) {
        throw hostError("Payment attempt not found for this order.", 404, "NOT_FOUND");
      }
      return resolvedPayment(amount, selected);
    }

    if (context.action === "checkout.create" || context.action === "swap.create") {
      if (payments.some((payment) => payment.paidAt !== null)) {
        throw hostError("This order is already paid.", 409, "CONFLICT");
      }

      const live = payments.filter(
        (payment) => payment.paidAt === null && payment.expiresAt > clock(),
      );
      if (live.length > 1) {
        throw hostError(
          "This order has multiple live payment attempts; reconcile them before creating another.",
          409,
          "CONFLICT",
        );
      }
      const selected = live[0];
      if (selected === undefined) return { amount };

      const isSwap = selected.swapData !== undefined && selected.swapData !== null;
      if (context.action === "checkout.create" && isSwap) {
        throw hostError("This order already has a live swap attempt.", 409, "CONFLICT");
      }
      if (context.action === "swap.create" && !isSwap) {
        throw hostError("This order already has a live Lightning attempt.", 409, "CONFLICT");
      }
      if (
        context.action === "swap.create" &&
        context.payInAsset !== undefined &&
        selected.swapData?.providerOrder.pay_in_asset !== context.payInAsset
      ) {
        throw hostError(
          "This order already has a live swap attempt for another asset.",
          409,
          "CONFLICT",
        );
      }
      return resolvedPayment(amount, selected);
    }

    const selected =
      context.action === "swap.read" || context.action === "swap.refund"
        ? payments.find((payment) => payment.swapData !== undefined && payment.swapData !== null)
        : payments[0];
    if (selected === undefined) {
      throw hostError("Payment attempt not found for this order.", 404, "NOT_FOUND");
    }
    return resolvedPayment(amount, selected);
  };

  return {
    resolveCheckout,
    onCheckoutCreated: (input) => options.payments.commitAttempt(input),
    onPaid: options.onPaid,
    payments: options.payments,
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
  };
}

function resolvedPayment(
  amount: CreateCheckoutAmount,
  payment: OpenReceivePaymentRecord,
): ResolvedHostCheckout {
  return {
    amount,
    paymentHash: payment.paymentHash,
    checkout: structuredClone(payment.checkout),
    ...(payment.swapData === undefined || payment.swapData === null
      ? {}
      : { swapData: payment.swapData }),
  };
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
