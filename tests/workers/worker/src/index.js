// OpenReceive inside a Cloudflare Worker with Node compatibility, the runtime
// Lovable's TanStack Start apps deploy to. tests/workers/workers.test.mjs runs
// it under `wrangler dev` against PgBouncer and a wallet on a local relay.
//
// Workers ties every socket to the request that opened it and forbids I/O at
// import. So each request builds its own database pool and wallet connection,
// and closes both before its response returns. A stack kept in module scope
// fails: at import its wallet check is refused, and on a later request its
// sockets hang.
import { createStack, paymentsSchemaSql } from "@openreceive/http";
import pg from "pg";

function visitorFrom(request) {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "visitor")?.[1];
}

async function findOrder(pool, id) {
  const { rows } = await pool.query("SELECT * FROM worker_orders WHERE id = $1", [id]);
  return rows[0];
}

async function openReceive(request, env) {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const stack = createStack({
    wallet: { nwc: env.NWC_URI },
    storage: {
      db: pool,
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE worker_orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    amountFor: async (reference) => {
      const order = await findOrder(pool, reference);
      return order?.state === "awaiting_payment"
        ? { currency: "SAT", value: order.amount, description: "Worker order" }
        : null;
    },
    authorize: async ({ request: incoming, resource }) => {
      const order = resource.reference ? await findOrder(pool, resource.reference) : undefined;
      const visitor = visitorFrom(incoming);
      return Boolean(order && visitor && order.visitor === visitor);
    },
    // Cloudflare sets cf-connecting-ip on every request; a client cannot.
    rateLimiting: {
      ip: ({ request: incoming }) => incoming.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  try {
    return await stack.handler(request, { native: request });
  } finally {
    await stack.close();
    await pool.end();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/openreceive/")) return openReceive(request, env);

    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      if (url.pathname === "/setup" && request.method === "POST") {
        await pool.query(paymentsSchemaSql("postgres"));
        await pool.query(`CREATE TABLE IF NOT EXISTS worker_orders (
          id TEXT PRIMARY KEY, visitor TEXT NOT NULL, amount TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'awaiting_payment', paid_at BIGINT)`);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/orders" && request.method === "POST") {
        const id = crypto.randomUUID();
        const visitor = crypto.randomUUID();
        await pool.query(
          "INSERT INTO worker_orders (id, visitor, amount) VALUES ($1, $2, '2100')",
          [id, visitor],
        );
        return Response.json({ id, visitor });
      }
      const order = url.pathname.match(/^\/orders\/([^/]+)$/);
      if (order) {
        const row = await findOrder(pool, order[1]);
        return row ? Response.json({ state: row.state }) : new Response(null, { status: 404 });
      }
      return new Response("ok\n");
    } finally {
      await pool.end();
    }
  },
};
