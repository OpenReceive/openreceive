import { openReceiveNextHandlers } from "@openreceive/next";
import { httpOptions } from "../../../server/shop.ts";

/**
 * The SHIPPED OpenReceive routes, as one App Router catch-all. This app writes
 * NO invoice, status or swap handlers: this file serves POST
 * /openreceive/checkouts, POST /openreceive/payments/check, GET
 * /openreceive/rates and the rest.
 *
 * There is no memo injection here, unlike the Hello Fruit demo it replaces.
 * `amountFor` returns a `description` beside the price, so the invoice memo is
 * host data that never travels through a request body at all.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  // rateLimiting is left off here. On Next it additionally needs an explicit IP
  // source (trustProxyIpHeader) — see the rate-limiting guide.
  const { GET, POST } = openReceiveNextHandlers(await httpOptions());
  return request.method.toUpperCase() === "GET" ? GET(request) : POST(request);
}

export { handle as GET, handle as POST };
