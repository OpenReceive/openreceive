/**
 * Guest checkout resume helpers for no-account content sites.
 *
 * Pattern:
 * - Put the public `order_id` in the URL (`/checkout/:orderId`) so refresh/share works.
 * - Keep the OpenReceive capability token out of the URL (cookie + sessionStorage handle it).
 * - Mirror the host order summary in sessionStorage for instant same-tab restore; fall back to
 *   `GET /orders/:orderId` when storage is empty (new tab with the same link).
 */

import type { HelloFruitDemoOrder } from "./demo-order.ts";

export const HELLO_FRUIT_CHECKOUT_PATH_PREFIX = "/checkout" as const;

const ORDER_STORAGE_KEY_PREFIX = "hellofruit.order." as const;

export function helloFruitCheckoutPath(orderId: string): string {
  return `${HELLO_FRUIT_CHECKOUT_PATH_PREFIX}/${encodeURIComponent(orderId)}`;
}

/** Parse `/checkout/:orderId` from a pathname. Returns undefined when not a checkout resume URL. */
export function parseHelloFruitCheckoutOrderId(pathname: string): string | undefined {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== "checkout") return undefined;
  const raw = segments[1];
  if (raw === undefined || raw.length === 0) return undefined;
  let orderId: string;
  try {
    orderId = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (orderId.length === 0 || orderId.includes("/") || orderId.includes("..")) return undefined;
  return orderId;
}

export function rememberHelloFruitOrder(order: HelloFruitDemoOrder): void {
  const store = sessionStore();
  if (store === undefined) return;
  try {
    store.setItem(orderStorageKey(order.uuid), JSON.stringify(order));
  } catch {
    // Best-effort; GET /orders/:id still restores display.
  }
}

export function readRememberedHelloFruitOrder(orderId: string): HelloFruitDemoOrder | undefined {
  const store = sessionStore();
  if (store === undefined) return undefined;
  try {
    const raw = store.getItem(orderStorageKey(orderId));
    if (raw === null || raw.length === 0) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return isHelloFruitDemoOrder(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function forgetHelloFruitOrder(orderId?: string): void {
  const store = sessionStore();
  if (store === undefined) return;
  try {
    if (orderId !== undefined) {
      store.removeItem(orderStorageKey(orderId));
      return;
    }
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(ORDER_STORAGE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Ignore storage failures on reset.
  }
}

/** Push `/checkout/:orderId` when not already there (Vite SPAs / History API). */
export function enterHelloFruitCheckout(orderId: string): void {
  const path = helloFruitCheckoutPath(orderId);
  if (typeof globalThis.location === "undefined") return;
  if (globalThis.location.pathname === path) return;
  globalThis.history.pushState({ helloFruitCheckout: orderId }, "", path);
}

/** Return to `/` when leaving a checkout resume URL. */
export function leaveHelloFruitCheckout(): void {
  if (typeof globalThis.location === "undefined") return;
  if (parseHelloFruitCheckoutOrderId(globalThis.location.pathname) === undefined) return;
  globalThis.history.pushState({}, "", "/");
}

/**
 * Load a host order for resume: sessionStorage first, then `GET /orders/:orderId`.
 */
export async function loadHelloFruitOrderForResume(
  orderId: string,
): Promise<HelloFruitDemoOrder | undefined> {
  const remembered = readRememberedHelloFruitOrder(orderId);
  if (remembered !== undefined) return remembered;
  try {
    const response = await fetch(`/orders/${encodeURIComponent(orderId)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      !("order" in body) ||
      !isHelloFruitDemoOrder((body as { order: unknown }).order)
    ) {
      return undefined;
    }
    const order = (body as { order: HelloFruitDemoOrder }).order;
    rememberHelloFruitOrder(order);
    return order;
  } catch {
    return undefined;
  }
}

function orderStorageKey(orderId: string): string {
  return `${ORDER_STORAGE_KEY_PREFIX}${orderId}`;
}

function sessionStore(): Storage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

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
