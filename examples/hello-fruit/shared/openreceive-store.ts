/**
 * Tiny host-owned order repository for the demos. This is application state, not
 * OpenReceive state. A real app replaces this module with its normal ORM.
 */

import type { Checkout, CreateCheckoutAmount } from "@openreceive/node";
import type { HelloFruitDemoOrder } from "./demo-order.ts";

export interface HelloFruitStoredOrder {
  readonly summary: HelloFruitDemoOrder;
  readonly amount: CreateCheckoutAmount;
  readonly paymentHash: string | null;
  readonly paidAt: number | null;
  readonly swapRecoveryToken: string | null;
}

const orders = new Map<string, HelloFruitStoredOrder>();

export function createHelloFruitHostOrder(
  summary: HelloFruitDemoOrder,
  amount: CreateCheckoutAmount,
): HelloFruitStoredOrder {
  const stored: HelloFruitStoredOrder = {
    summary,
    amount,
    paymentHash: null,
    paidAt: null,
    swapRecoveryToken: null,
  };
  orders.set(summary.uuid, stored);
  return stored;
}

export function readHelloFruitHostOrder(orderId: string): HelloFruitStoredOrder | null {
  return orders.get(orderId) ?? null;
}

export function resolveHelloFruitHostCheckout(orderId: string): {
  readonly amount: CreateCheckoutAmount;
  readonly paymentHash?: string;
  readonly swapRecoveryToken?: string;
} | null {
  const current = orders.get(orderId);
  if (current === undefined) return null;
  if (current.paidAt !== null) return null;
  if (
    current.paymentHash !== null &&
    current.paidAt === null
  ) {
    return {
      amount: current.amount,
      paymentHash: current.paymentHash,
      ...(current.swapRecoveryToken === null ? {} : { swapRecoveryToken: current.swapRecoveryToken }),
    };
  }
  return { amount: current.amount };
}

/** Compare-and-set payment correlation before payer instructions are returned. */
export function commitHelloFruitCheckout(input: {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly checkout: Checkout;
  readonly swapRecoveryToken?: string;
}): void {
  const current = orders.get(input.orderId);
  if (current === undefined) throw new Error("Host order not found.");
  if (current.paymentHash !== null && current.paymentHash !== input.paymentHash) {
    throw new Error("Host order already has a live payment hash.");
  }
  orders.set(input.orderId, {
    ...current,
    paymentHash: input.paymentHash,
    swapRecoveryToken: input.swapRecoveryToken ?? current.swapRecoveryToken,
  });
}

/** Write-once paid transition; duplicate onPaid delivery is harmless. */
export function markHelloFruitPaid(paymentHash: string, paidAt: number): HelloFruitStoredOrder | null {
  for (const [orderId, current] of orders) {
    if (current.paymentHash !== paymentHash) continue;
    if (current.paidAt !== null) return current;
    const next: HelloFruitStoredOrder = {
      ...current,
      paidAt,
      summary: { ...current.summary, status: "paid" },
    };
    orders.set(orderId, next);
    return next;
  }
  return null;
}
