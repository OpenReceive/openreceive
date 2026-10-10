// A Lovable app's payment route in miniature: docs/recipes/tanstack-start.md's
// Supabase handler, under `wrangler dev`. Payments live in Supabase and are
// reached over its HTTPS API; orders are read the same way, as Lovable's
// generated supabaseAdmin client reads them. The buyer is the `buyer` cookie
// the shop set when it created the order. There is no onPaid: the database's
// openreceive_on_paid marks the order paid.
import { createStack } from "@openreceive/http";

function currentBuyer(request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "buyer")?.[1];
}

async function findOrder(id) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/shop_orders`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("select", "id,state,amount,buyer_token");
  const response = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY },
  });
  if (!response.ok) throw new Error(`Reading the order failed: ${response.status}`);
  return (await response.json())[0];
}

async function handleOpenReceive(request) {
  // Read process.env inside the handler: on Workers it is empty at import.
  const stack = createStack({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      supabase: {
        url: process.env.SUPABASE_URL ?? "",
        key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      },
    },
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.state === "awaiting_payment"
        ? { currency: "SAT", value: order.amount, description: "Lovable-shape order" }
        : null;
    },
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      const buyer = currentBuyer(incoming);
      return Boolean(order && buyer && order.buyer_token === buyer);
    },
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/openreceive/")) return handleOpenReceive(request);
    return new Response("ok\n");
  },
};
