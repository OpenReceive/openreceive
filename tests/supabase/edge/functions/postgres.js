// A Supabase Edge Function on Postgres, as Bolt's are: `pg` on the
// SUPABASE_DB_URL every function gets, and one stack per worker, built on its
// first request. onPaid marks the order paid in the settlement transaction.
import { createStack } from "@openreceive/http";
import pg from "pg";
import { currentBuyer, orderAmount, routed } from "./shop.js";

const env = (name) => Deno.env.get(name) ?? "";
let pool;
let stack;

async function findOrder(id) {
  const { rows } = await pool.query(
    "select id, state, amount, buyer_token from shop_orders where id = $1",
    [id],
  );
  return rows[0];
}

function openReceive() {
  pool ??= new pg.Pool({ connectionString: env("SUPABASE_DB_URL"), max: 2 });
  stack ??= createStack({
    wallet: { nwc: env("NWC_URI") },
    storage: {
      db: pool,
      onPaid: async ({ reference, query }) => {
        await query(
          "update shop_orders set state = 'paid' where id = $1 and state = 'awaiting_payment'",
          [reference],
        );
      },
    },
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
  return stack;
}

Deno.serve((request) => {
  const incoming = routed(request);
  if (incoming === null) return new Response("ok\n");
  return openReceive().handler(incoming, { native: incoming });
});
