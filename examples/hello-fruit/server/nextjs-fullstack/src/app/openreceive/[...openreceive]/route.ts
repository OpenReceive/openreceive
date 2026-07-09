import { openReceiveNextHandlers } from "@openreceive/next";
import { openReceiveHttpOptions } from "../../../server/openreceive.ts";

// Mount the SHIPPED OpenReceive routes as a Next.js App Router catch-all. The app writes NO
// invoice/status/swap handlers: this one catch-all serves POST /openreceive/checkouts,
// POST /openreceive/orders/:id, GET /openreceive/rates, etc. Handlers are built per request so
// the (test-overridable) cached OpenReceive service is always the current one.

export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  const { GET, POST } = openReceiveNextHandlers(await openReceiveHttpOptions());
  return request.method.toUpperCase() === "GET" ? await GET(request) : await POST(request);
}

export { handle as GET, handle as POST };
