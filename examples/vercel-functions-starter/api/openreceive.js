// api/openreceive.js — every route under /openreceive/, through the rewrite
import { createStack } from "@openreceive/http";
import { pool } from "../lib/db.js";
import { findOrder, visitorFrom } from "../lib/orders.js"; // your own orders

let stack;

// Built on the first request, then kept for the instance's later requests.
// createStack connects to the wallet as soon as it is built, and Vercel can
// load a function well before a request arrives, so never build it at import.
function openReceive() {
  stack ??= createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: pool,
      // Runs once, inside the transaction that records the payment.
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
      return order?.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.title }
        : null;
    },
    // Only the buyer may pay for their order.
    authorize: async ({ request, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      const visitor = visitorFrom(request);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Vercel replaces any x-forwarded-for a client sends, so its first
    // address is the payer's.
    rateLimiting: {
      ip: ({ request }) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    },
  });
  return stack;
}

export function GET(request) {
  return openReceive().handler(request);
}

export function POST(request) {
  return openReceive().handler(request);
}
