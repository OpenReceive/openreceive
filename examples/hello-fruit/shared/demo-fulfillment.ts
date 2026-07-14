/**
 * Server-only Hello Fruit fulfillment. Marks the prepared order summary paid after
 * OpenReceive verifies settlement. Do not import from browser clients.
 */

import {
  createHostOrderStore,
  type HostOrderMetaStore,
  type StoredHostOrder,
} from "@openreceive/node";
import { isHelloFruitDemoOrder, type HelloFruitDemoOrder } from "./demo-order.ts";

export const HELLO_FRUIT_FULFILLED_CHECKOUT_META_KEY = "fulfilled_checkout_id" as const;

export interface FulfillHelloFruitOrderInput {
  readonly store: HostOrderMetaStore;
  readonly orderId: string | undefined;
  readonly checkoutId: string | undefined;
}

export type FulfillHelloFruitOrderResult =
  | { readonly fulfilled: false; readonly reason: "missing_order_id" | "order_not_found" | "invalid_summary" | "already_fulfilled" }
  | { readonly fulfilled: true; readonly order: HelloFruitDemoOrder; readonly checkoutId: string | undefined };

/**
 * Flip the persisted host-order summary to `status: "paid"` after backend-verified settlement.
 * Idempotent on `checkoutId` (and on an already-paid summary).
 */
export async function fulfillHelloFruitOrder(
  input: FulfillHelloFruitOrderInput,
): Promise<FulfillHelloFruitOrderResult> {
  const orderId = input.orderId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    return { fulfilled: false, reason: "missing_order_id" };
  }

  const hostOrders = createHostOrderStore<HelloFruitDemoOrder>(input.store);
  const stored = await hostOrders.read(orderId);
  if (stored === null) {
    return { fulfilled: false, reason: "order_not_found" };
  }
  if (!isHelloFruitDemoOrder(stored.summary)) {
    return { fulfilled: false, reason: "invalid_summary" };
  }

  const priorCheckoutId = readFulfilledCheckoutId(stored.metadata);
  if (
    stored.summary.status === "paid" ||
    (input.checkoutId !== undefined &&
      input.checkoutId.length > 0 &&
      priorCheckoutId === input.checkoutId)
  ) {
    return { fulfilled: false, reason: "already_fulfilled" };
  }

  const order: HelloFruitDemoOrder = {
    ...stored.summary,
    status: "paid",
  };
  const next: StoredHostOrder<HelloFruitDemoOrder> = {
    amount: stored.amount,
    summary: order,
    metadata: {
      ...(stored.metadata ?? {}),
      ...(typeof input.checkoutId === "string" && input.checkoutId.length > 0
        ? { [HELLO_FRUIT_FULFILLED_CHECKOUT_META_KEY]: input.checkoutId }
        : {}),
    },
  };
  await hostOrders.persist(orderId, next);
  return { fulfilled: true, order, checkoutId: input.checkoutId };
}

function readFulfilledCheckoutId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (metadata === undefined) return undefined;
  const value = metadata[HELLO_FRUIT_FULFILLED_CHECKOUT_META_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
