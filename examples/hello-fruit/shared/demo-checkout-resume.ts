/**
 * Hello Fruit guest checkout resume — thin wrapper over `@openreceive/browser`
 * `createGuestCheckoutResume`. Demos keep only the URL shape (`/checkout/:orderId`)
 * and the host order type.
 */

import {
  createGuestCheckoutResume,
  createGuestOrderFetcher,
} from "@openreceive/browser";
import type { HelloFruitDemoOrder } from "./demo-order.ts";

export const HELLO_FRUIT_CHECKOUT_PATH_PREFIX = "/checkout" as const;

const ORDER_STORAGE_KEY_PREFIX = "hellofruit.order." as const;

function isHelloFruitDemoOrder(value: unknown): value is HelloFruitDemoOrder {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.uuid === "string" &&
    record.uuid.length > 0 &&
    (record.status === "pending_payment" || record.status === "paid") &&
    Array.isArray(record.items) &&
    typeof record.total_amount === "object" &&
    record.total_amount !== null
  );
}

function parseHelloFruitDemoOrder(value: unknown): HelloFruitDemoOrder | undefined {
  return isHelloFruitDemoOrder(value) ? value : undefined;
}

export const helloFruitCheckoutResume = createGuestCheckoutResume<HelloFruitDemoOrder>({
  pathPrefix: HELLO_FRUIT_CHECKOUT_PATH_PREFIX,
  storageKeyPrefix: ORDER_STORAGE_KEY_PREFIX,
  orderIdOf: (order) => order.uuid,
  parseOrder: parseHelloFruitDemoOrder,
  fetchOrder: createGuestOrderFetcher({ parseOrder: parseHelloFruitDemoOrder }),
});

export function helloFruitCheckoutPath(orderId: string): string {
  return helloFruitCheckoutResume.checkoutPath(orderId);
}

export function parseHelloFruitCheckoutOrderId(pathname: string): string | undefined {
  return helloFruitCheckoutResume.parseOrderId(pathname);
}

export function rememberHelloFruitOrder(order: HelloFruitDemoOrder): void {
  helloFruitCheckoutResume.rememberOrder(order);
}

export function readRememberedHelloFruitOrder(orderId: string): HelloFruitDemoOrder | undefined {
  return helloFruitCheckoutResume.readRememberedOrder(orderId);
}

export function forgetHelloFruitOrder(orderId?: string): void {
  helloFruitCheckoutResume.forgetOrder(orderId);
}

export function enterHelloFruitCheckout(orderId: string): void {
  helloFruitCheckoutResume.enterCheckout(orderId);
}

export function leaveHelloFruitCheckout(): void {
  helloFruitCheckoutResume.leaveCheckout();
}

export async function loadHelloFruitOrderForResume(
  orderId: string,
): Promise<HelloFruitDemoOrder | undefined> {
  return helloFruitCheckoutResume.loadOrderForResume(orderId);
}
