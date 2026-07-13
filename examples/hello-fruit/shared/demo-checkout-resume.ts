/**
 * Hello Fruit guest checkout URL helpers (`/checkout/:orderId`).
 * Prefer `<Checkout orderId />` for summary restore (always on in create mode); add `syncUrl`
 * when you want History API URL sync. These helpers remain for custom storage keys / URL
 * shapes and for SPA navigation around prepare and start-over.
 */

import {
  createGuestCheckoutResume,
  createGuestOrderFetcher,
  enterCheckoutResumePath,
} from "@openreceive/browser";
import type { HelloFruitDemoOrder } from "./demo-order.ts";
import { isHelloFruitDemoOrder } from "./demo-order.ts";

export const HELLO_FRUIT_CHECKOUT_PATH_PREFIX = "/checkout" as const;

const ORDER_STORAGE_KEY_PREFIX = "hellofruit.order." as const;

function parseHelloFruitDemoOrder(value: unknown): HelloFruitDemoOrder | undefined {
  return isHelloFruitDemoOrder(value) ? value : undefined;
}

export const helloFruitCheckoutResume = createGuestCheckoutResume<HelloFruitDemoOrder>({
  pathPrefix: HELLO_FRUIT_CHECKOUT_PATH_PREFIX,
  storageKeyPrefix: ORDER_STORAGE_KEY_PREFIX,
  orderIdOf: (order) => order.uuid,
  parseOrder: parseHelloFruitDemoOrder,
  fetchOrder: createGuestOrderFetcher({
    parseOrder: parseHelloFruitDemoOrder,
  }),
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
  enterCheckoutResumePath(orderId, { pathPrefix: HELLO_FRUIT_CHECKOUT_PATH_PREFIX });
}

export function leaveHelloFruitCheckout(): void {
  helloFruitCheckoutResume.leaveCheckout();
}

export async function loadHelloFruitOrderForResume(
  orderId: string,
): Promise<HelloFruitDemoOrder | undefined> {
  return helloFruitCheckoutResume.loadOrderForResume(orderId);
}
