import type { CreateCheckoutAmount, SwapData } from "@openreceive/node";
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
  readonly swapData?: SwapData | null;
}

export interface OpenReceivePaymentInsert {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly expiresAt: number;
  readonly createdAt: number;
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
  commitAttempt(input: CheckoutCreatedInput): void | Promise<void>;
}

export interface CreateOpenReceivePaymentHooksOptions<Order> {
  readonly loadOrder: (
    orderId: string,
    context: ResolveCheckoutContext,
  ) => Order | null | Promise<Order | null>;
  readonly amountForOrder: (
    order: Order,
    context: ResolveCheckoutContext,
  ) => CreateCheckoutAmount | Promise<CreateCheckoutAmount>;
  readonly payments: OpenReceivePaymentRepository;
  readonly clock?: () => number;
}

export interface OpenReceivePaymentHooks {
  readonly resolveCheckout: ResolveCheckoutHook;
  readonly onCheckoutCreated: CheckoutCreatedHook;
}

/**
 * Build the two mounted-route hooks around a host order loader and an
 * ORM-specific payment repository. This keeps payment selection consistent
 * while leaving transactions and SQL entirely in the host application.
 */
export function createOpenReceivePaymentHooks<Order>(
  options: CreateOpenReceivePaymentHooksOptions<Order>,
): OpenReceivePaymentHooks {
  if (options?.loadOrder === undefined) {
    throw new TypeError("OpenReceive payment hooks require loadOrder.");
  }
  if (options.amountForOrder === undefined) {
    throw new TypeError("OpenReceive payment hooks require amountForOrder.");
  }
  if (options.payments?.listForOrder === undefined) {
    throw new TypeError("OpenReceive payment hooks require payments.listForOrder.");
  }
  if (options.payments.commitAttempt === undefined) {
    throw new TypeError("OpenReceive payment hooks require payments.commitAttempt.");
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
  };
}

/** Convert a checkout callback to the values common ORM create calls persist. */
export function openReceivePaymentInsert(
  input: CheckoutCreatedInput,
): OpenReceivePaymentInsert {
  return {
    orderId: input.orderId,
    paymentHash: input.paymentHash.toLowerCase(),
    createdAt: input.checkout.createdAt,
    expiresAt:
      input.swapData?.providerOrder.expires_at ?? input.checkout.expiresAt,
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
        right.createdAt - left.createdAt ||
        right.paymentHash.localeCompare(left.paymentHash),
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
    throw hostError(
      "payment_hash must be 64 hexadecimal characters.",
      400,
      "INVALID_REQUEST",
    );
  }
  return normalized;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}
