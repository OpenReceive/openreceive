import { openReceiveNextHandlers } from "@openreceive/next";
import { httpOptions } from "../../../server/openreceive.ts";
import { readHelloFruitHostOrder } from "../../../../../../shared/openreceive-store.ts";

// Mount the SHIPPED OpenReceive routes as a Next.js App Router catch-all. The app writes NO
// invoice/status/swap handlers: this one catch-all serves POST /openreceive/checkouts,
// POST /openreceive/payments/check, GET /openreceive/rates, etc. Handlers are built per request from
// the cached storage-agnostic OpenReceive service.

export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  // rateLimiting is left off in this demo. On Next it additionally needs an
  // explicit IP source (trustProxyIpHeader) — see the rate-limiting guide.
  const { GET, POST } = openReceiveNextHandlers(await httpOptions());
  if (request.method.toUpperCase() === "GET") return GET(request);
  return POST(await withHelloFruitOrderMemo(request));
}

export { handle as GET, handle as POST };

/**
 * The payer's checkout component only knows the order id; the invoice
 * description is host data. Rebuild checkout/swap create requests with the
 * memo stored at order time (`checkout.create` and `swap.create` both accept
 * an optional `memo`) so minted invoices carry the order's description.
 */
async function withHelloFruitOrderMemo(request: Request): Promise<Request> {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/openreceive/checkouts" && pathname !== "/openreceive/swaps") return request;

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return request;
  }
  if (typeof body !== "object" || body === null) return request;
  const record = { ...(body as Record<string, unknown>) };
  if (typeof record.order_id !== "string" || record.memo !== undefined) return request;
  // httpOptions() booted the host store before this runs.
  const memo = readHelloFruitHostOrder(record.order_id)?.memo;
  if (memo === undefined) return request;

  record.memo = memo;
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(record),
  });
}
