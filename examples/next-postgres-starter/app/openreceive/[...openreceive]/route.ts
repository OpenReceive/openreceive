import { openReceiveNextHandlers } from "@openreceive/next";
import { walletConfigured } from "@/lib/config";
import { db } from "@/lib/db";
import { findOrder, VISITOR_COOKIE } from "@/lib/orders";

// The wallet relay and the database driver need Node, and payment routes must
// never be cached or prerendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function visitorFrom(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
}

let handlers: ReturnType<typeof openReceiveNextHandlers> | undefined;

// Built on the first request, not at import, so `next build` needs no
// wallet code. Settlement runs during these requests; no worker is needed.
function openReceive() {
  handlers ??= openReceiveNextHandlers({
    wallet: { nwc: process.env.NWC_URI?.trim() ?? "" },
    storage: {
      db: db(),
      // Runs once, inside the settlement transaction. `$1` placeholders.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order && order.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.product_name }
        : null;
    },
    // Only the browser that created the order may pay for it.
    authorize: async ({ request, resource }) => {
      const visitor = visitorFrom(request);
      const order = resource.reference ? await findOrder(resource.reference) : null;
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Vercel sets x-forwarded-for, so the limiter can see each payer's IP.
    rateLimiting: true,
    trustProxyIpHeader: true,
  });
  return handlers;
}

// Until NWC_URI is set, the routes answer with a clear error instead of
// failing to reach a wallet. The pages show the setup steps meanwhile.
const notConfigured = () =>
  Response.json(
    {
      code: "WALLET_UNAVAILABLE",
      message: "The shop has no wallet code yet. Set NWC_URI and redeploy.",
      retryable: false,
    },
    { status: 503 },
  );

export const GET = (request: Request) =>
  walletConfigured() ? openReceive().GET(request) : notConfigured();
export const POST = (request: Request) =>
  walletConfigured() ? openReceive().POST(request) : notConfigured();
