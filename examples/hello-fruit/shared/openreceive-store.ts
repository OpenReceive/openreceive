/**
 * Tiny host-owned repositories for the demos. Orders and OpenReceive payment
 * attempts are deliberately separate so one order can retain multiple expired
 * or settled invoice hashes. These process-local maps are suitable only for
 * this disposable, single-instance demo: restart loses every row and a second
 * process would not share its locks. A real deployment replaces them with its
 * existing database/ORM.
 */

import {
  openReceivePaymentInsert,
  type OpenReceivePaymentRecord,
  type OpenReceivePaymentRepository,
} from "@openreceive/http";
import type { CreateCheckoutAmount, SwapData } from "@openreceive/node";
import type { HelloFruitDemoOrder } from "./demo-order.ts";

export interface HelloFruitStoredOrder {
  readonly summary: HelloFruitDemoOrder;
  readonly amount: CreateCheckoutAmount;
}

interface HelloFruitStoredPayment extends OpenReceivePaymentRecord {
  readonly swapData?: SwapData | null;
}

const orders = new Map<string, HelloFruitStoredOrder>();
const payments = new Map<string, HelloFruitStoredPayment>();

export function createHelloFruitHostOrder(
  summary: HelloFruitDemoOrder,
  amount: CreateCheckoutAmount,
): HelloFruitStoredOrder {
  const stored: HelloFruitStoredOrder = { summary, amount };
  orders.set(summary.uuid, stored);
  return stored;
}

export function readHelloFruitHostOrder(orderId: string): HelloFruitStoredOrder | null {
  return orders.get(orderId) ?? null;
}

export const helloFruitPaymentRepository: OpenReceivePaymentRepository = {
  async listForOrder(orderId) {
    return [...payments.values()].filter((payment) => payment.orderId === orderId);
  },

  // JavaScript runs this demo mutation synchronously. A real ORM implementation
  // performs the same checks while holding a database lock on the host order.
  commitAttempt(input) {
    const order = orders.get(input.orderId);
    if (order === undefined) throw new Error("Host order not found.");

    const stored = openReceivePaymentInsert(input);
    const same = payments.get(stored.paymentHash);
    if (same !== undefined) return;

    const orderPayments = [...payments.values()].filter(
      (payment) => payment.orderId === input.orderId,
    );
    if (orderPayments.some((payment) => payment.paidAt !== null)) {
      throw new Error("Host order is already paid.");
    }
    const now = Math.floor(Date.now() / 1_000);
    if (
      orderPayments.some(
        (payment) => payment.paidAt === null && payment.expiresAt > now,
      )
    ) {
      throw new Error("Host order already has a live payment attempt.");
    }

    payments.set(stored.paymentHash, {
      ...stored,
      paidAt: null,
    });
  },
};

/**
 * Write-once settlement per attempt. The first settled attempt fulfills the
 * order; later settled attempts remain recorded without repeating fulfillment.
 */
export function markHelloFruitPaid(
  paymentHash: string,
  paidAt: number,
): HelloFruitStoredOrder | null {
  const payment = payments.get(paymentHash);
  if (payment === undefined) return null;
  const order = orders.get(payment.orderId);
  if (order === undefined) return null;
  if (payment.paidAt === null) {
    payments.set(paymentHash, { ...payment, paidAt });
  }
  if (order.summary.status === "paid") return order;

  const next: HelloFruitStoredOrder = {
    ...order,
    summary: { ...order.summary, status: "paid" },
  };
  orders.set(payment.orderId, next);
  return next;
}
