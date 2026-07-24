/**
 * Hello Fruit guest checkout URL helpers (`/checkout/:orderId`).
 * The host application owns summary restore. These helpers provide its storage, fetch, and
 * URL behavior; `<Checkout orderId />` owns only payment creation and polling.
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
    orderUrl: (orderId) => `/orders/${encodeURIComponent(orderId)}`,
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
