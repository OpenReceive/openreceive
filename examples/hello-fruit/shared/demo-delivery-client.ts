/**
 * Browser-safe Hello Fruit delivery helpers. Polls the server summary until
 * `onPaid` marks the order paid, then fetches gated sticker bytes with the
 * per-order capability token (cookie is path-scoped to OpenReceive routes).
 */

import {
  getOrderAccessToken,
  requestOrderSummary,
} from "@openreceive/browser";
import { isHelloFruitDemoOrder, type HelloFruitDemoOrder } from "./demo-order.ts";

export function helloFruitDeliveryPath(orderId: string, productId: string): string {
  return `/delivery/${encodeURIComponent(orderId)}/${encodeURIComponent(productId)}`;
}

export interface WaitForHelloFruitPaidSummaryOptions {
  readonly orderId: string;
  readonly prefix?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Max attempts including the first. Default 20. */
  readonly attempts?: number;
  /** Delay between attempts in ms. Default 150. */
  readonly delayMs?: number;
}

/**
 * Refetch `GET …/orders/:id/summary` until the host summary is `status: "paid"`.
 * Handles the race where browser `onSettled` fires before server `onPaid` finishes.
 */
export async function waitForHelloFruitPaidSummary(
  options: WaitForHelloFruitPaidSummaryOptions,
): Promise<HelloFruitDemoOrder> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 150;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }
    try {
      const result = await requestOrderSummary({
        orderId: options.orderId,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (result === undefined || !isHelloFruitDemoOrder(result.summary)) {
        lastError = new Error("Order summary not found.");
        continue;
      }
      if (result.summary.status === "paid") {
        return result.summary;
      }
      lastError = new Error("Order is not fulfilled yet.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Timed out waiting for paid order summary.");
}

/**
 * Fetch a fulfilled sticker with the stored capability token and return an object URL.
 * Caller should `URL.revokeObjectURL` when done.
 */
export async function fetchHelloFruitDeliveryObjectUrl(
  orderId: string,
  productId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const token = getOrderAccessToken(orderId);
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(helloFruitDeliveryPath(orderId, productId), {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`Delivery failed: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
