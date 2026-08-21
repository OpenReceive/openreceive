/**
 * Browser-safe Hello Fruit delivery helpers. Polls the server summary until
 * `onPaid` marks the order paid, then fetches host-gated sticker bytes.
 */

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
 * Refetch the host's `GET …/orders/:id` route until its summary is `status: "paid"`.
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
      const fetcher = options.fetch ?? globalThis.fetch;
      const response = await fetcher(`/orders/${encodeURIComponent(options.orderId)}`);
      const result = response.ok ? await response.json() : undefined;
      if (!isHelloFruitDemoOrder(result)) {
        lastError = new Error("Order summary not found.");
        continue;
      }
      if (result.status === "paid") {
        return result;
      }
      lastError = new Error("Order is not fulfilled yet.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Timed out waiting for paid order summary.");
}

/**
 * Fetch a fulfilled sticker through the host application and return an object URL.
 * Caller should `URL.revokeObjectURL` when done.
 */
export async function fetchHelloFruitDeliveryObjectUrl(
  orderId: string,
  productId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(helloFruitDeliveryPath(orderId, productId), {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`Delivery failed: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export interface HelloFruitPurchasedSticker {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  /** Object URL for the delivered bytes; revoke through `revokeHelloFruitStickers`. */
  readonly objectUrl: string;
  readonly filename: string;
}

/**
 * Fetch every sticker on a paid order. Carts hold more than one line, so a
 * variant that reveals only `items[0]` silently withholds what the payer bought.
 */
export async function fetchHelloFruitPurchasedStickers(
  order: HelloFruitDemoOrder,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly HelloFruitPurchasedSticker[]> {
  const stickers: HelloFruitPurchasedSticker[] = [];
  try {
    for (const item of order.items) {
      stickers.push({
        productId: item.product_id,
        name: item.name,
        quantity: item.quantity,
        objectUrl: await fetchHelloFruitDeliveryObjectUrl(order.uuid, item.product_id, fetchImpl),
        filename: `${item.product_id}-sticker.svg`,
      });
    }
  } catch (error) {
    revokeHelloFruitStickers(stickers);
    throw error;
  }
  return stickers;
}

export function revokeHelloFruitStickers(
  stickers: readonly HelloFruitPurchasedSticker[] | undefined,
): void {
  for (const sticker of stickers ?? []) URL.revokeObjectURL(sticker.objectUrl);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
