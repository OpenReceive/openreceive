import { orderAccessTokenHeaders } from "./order-token.ts";
import type { CheckoutInvoiceSnapshot } from "./ui.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readResponseMessage(value: unknown): string | undefined {
  return nonEmptyString(asRecord(value).message);
}

/**
 * POST JSON to an OpenReceive endpoint and return the parsed body, throwing the
 * server-provided message on a non-2xx response. `fetcher` is injectable so React
 * can pass a test fetch while the custom element uses the global `fetch`.
 *
 * `headers` forwards caller-supplied headers (e.g. an order capability token as
 * `Authorization: Bearer <token>` or `X-OpenReceive-Order-Token`). This is the seam that
 * lets swap start/quote/refund reads carry the same token the create/status calls do —
 * previously this choke point sent no custom headers.
 */
export async function postOpenReceiveJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headers?: Readonly<Record<string, string>>,
): Promise<unknown> {
  // Auto-attach the per-order capability token so swap quote/start/refund carry it with no
  // caller change, keyed by the `order_id` already present in the body. Placed before the
  // caller-provided `headers` so an explicit override still wins; omitted when no token is
  // stored for this order.
  const orderId = typeof body.order_id === "string" ? body.order_id : undefined;
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...orderAccessTokenHeaders(orderId),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) {
    throw new Error(readResponseMessage(parsed) ?? "OpenReceive request failed.");
  }
  return parsed;
}

/**
 * Normalize a swap start/refund response to the Lightning invoice snapshot the UI
 * renders. A swap start/refund returns `{ attempt }`; the backing invoice (which
 * carries the swap block) is `attempt.shadow_invoice`.
 */
export function normalizeSwapStartInvoice(body: unknown): CheckoutInvoiceSnapshot {
  const record = asRecord(body);
  const invoice = asRecord(asRecord(record.attempt).shadow_invoice ?? record.invoice ?? body);
  if (
    nonEmptyString(invoice.invoice_id) === undefined ||
    asRecord(invoice.swap).provider === undefined
  ) {
    throw new Error("Swap response did not include an attempt.");
  }
  return invoice as unknown as CheckoutInvoiceSnapshot;
}
