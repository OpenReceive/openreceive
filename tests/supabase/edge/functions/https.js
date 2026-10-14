// A Supabase Edge Function on Supabase's HTTPS API: the Lovable recipe's
// handler, with payments and orders reached through the gateway with the
// project's secret key, and one stack per request.
import { createStack } from "@openreceive/http";
import { currentBuyer, orderAmount, routed } from "./shop.js";

const env = (name) => Deno.env.get(name) ?? "";

async function findOrder(id) {
  const url = new URL(`${env("SUPABASE_URL")}/rest/v1/shop_orders`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("select", "id,state,amount,buyer_token");
  const response = await fetch(url, { headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY") } });
  if (!response.ok) throw new Error(`Reading the order failed: ${response.status}`);
  return (await response.json())[0];
}

Deno.serve(async (request) => {
  const incoming = routed(request);
  if (incoming === null) return new Response("ok\n");
  const stack = createStack({
    wallet: { nwc: env("NWC_URI") },
    storage: { supabase: { url: env("SUPABASE_URL"), key: env("SUPABASE_SERVICE_ROLE_KEY") } },
    amountFor: async (reference) => orderAmount(await findOrder(reference)),
    authorize: async ({ request: native, resource }) => {
      const order = resource.reference ? await findOrder(resource.reference) : undefined;
      const buyer = currentBuyer(native);
      return Boolean(order && buyer && order.buyer_token === buyer);
    },
    rateLimiting: {
      ip: ({ request: native }) => native.headers.get("x-forwarded-for") ?? undefined,
    },
  });
  try {
    return await stack.handler(incoming, { native: incoming });
  } finally {
    await stack.close();
  }
});
