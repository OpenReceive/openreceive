import type { PaymentDetails } from "@openreceive/core";
import type { Checkout, PaymentCheck, SwapCheckout } from "@openreceive/node";
import { bigintToJsonNumber, HttpError } from "./errors.ts";
import type { PaymentRepository } from "./payment-repository.ts";

// The response half of the HTTP wire boundary: the internal camelCase shapes
// turned into the published snake_case bodies, and the deliberate narrowing
// that keeps wallet internals out of a payer-visible response. The request half
// lives in http-request.ts.

export function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (typeof value === "bigint") return bigintToJsonNumber(value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      toSnakeCase(item),
    ]),
  );
}

export function httpCheckout(checkout: Checkout): Record<string, unknown> {
  return {
    order_id: checkout.orderId,
    payment_hash: checkout.paymentHash,
    bolt11: checkout.bolt11,
    amount_msats: checkout.amountMsats,
    created_at: checkout.createdAt,
    expires_at: checkout.expiresAt,
    fiat_quote: checkout.fiatQuote === null ? null : toSnakeCase(checkout.fiatQuote),
  };
}

export function httpSwap(swap: SwapCheckout): Record<string, unknown> {
  const { checkout, swapData: _swapData, ...rest } = swap;
  return {
    ...(toSnakeCase(rest) as Record<string, unknown>),
    checkout: httpCheckout(checkout),
  };
}

/** `payments/check` body for the request that won the gate: straight from the pass. */
export function paymentCheckFromReconcilePass(checked: PaymentCheck): Record<string, unknown> {
  const { details, ...checkedPublic } = checked;
  return {
    ...(toSnakeCase(checkedPublic) as Record<string, unknown>),
    ...(details === undefined ? {} : { details: publicPaymentDetails(details) }),
  };
}

/**
 * `payments/check` body from the host row (`gate_busy`, a hash outside the
 * pending set, or opportunistic reconcile disabled). Row `attention` serves as
 * `pending` on the wire — it is operator state, not payer information — and
 * the row path never emits `not_found`. `details` stays contract-optional:
 * there is no persisted wallet snapshot, only the pass provides it.
 */
export async function paymentCheckFromStoredAttempt(
  payments: PaymentRepository,
  orderId: string,
  paymentHash: string,
): Promise<Record<string, unknown>> {
  const rows = await payments.listForOrder(orderId);
  const record = rows.find((row) => row.paymentHash.toLowerCase() === paymentHash.toLowerCase());
  if (record === undefined) {
    // resolveHostCheckout selected this hash from the same repository moments ago.
    throw new HttpError(404, "NOT_FOUND", "Payment attempt not found for this order.");
  }
  return {
    payment_hash: record.paymentHash.toLowerCase(),
    status: record.status === "attention" ? "pending" : record.status,
    ...(record.paidAt === null ? {} : { paid_at: record.paidAt }),
  };
}

/**
 * Payer-facing subset of a settlement's wallet details. The raw NwcTransaction
 * carries the preimage, full invoice, and wallet metadata — none of which belong
 * in a browser-polled response.
 */
function publicPaymentDetails(details: PaymentDetails): Record<string, unknown> {
  const transaction = details.transaction as Record<string, unknown> | undefined;
  const pick = (keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(
      keys.flatMap((key) =>
        transaction?.[key] === undefined ? [] : [[key, transaction[key]] as const],
      ),
    );
  return {
    ...(transaction === undefined
      ? {}
      : {
          transaction: pick([
            "payment_hash",
            "state",
            "transaction_state",
            "amount_msats",
            "fees_paid_msats",
            "created_at",
            "settled_at",
            "expires_at",
          ]),
        }),
    observed_at: details.observed_at,
    ...(details.paid_at_source === undefined ? {} : { paid_at_source: details.paid_at_source }),
  };
}
