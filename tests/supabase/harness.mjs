import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { supabasePaymentsMigrationSql } from "../../packages/js/core/src/index.ts";

// Shared by the Supabase lane: a clean database with the scaffold migration
// applied, a host order table and openreceive_on_paid, and a stand-in for
// Supabase's API gateway in front of PostgREST.
//
//   docker compose -f tests/supabase/compose.yml up -d --wait
//   npm run test:supabase

export const databaseUrl = process.env.OPENRECEIVE_TEST_SUPABASE_DB_URL;
export const restUrl = process.env.OPENRECEIVE_TEST_SUPABASE_REST_URL;
const jwtSecret = process.env.OPENRECEIVE_TEST_SUPABASE_JWT_SECRET;
export const skip =
  (!databaseUrl || !restUrl || !jwtSecret) &&
  "Set OPENRECEIVE_TEST_SUPABASE_DB_URL, _REST_URL and _JWT_SECRET (see tests/supabase/harness.mjs)";

/** A secret key in the new format, which the gateway stand-in accepts in `apikey`. */
export const SECRET_KEY = "sb_secret_openreceive_test_key";

/**
 * A fresh Supabase-style JWT for `role`. Each one is distinct, so a repository
 * built with it never reuses another's passed storage check.
 */
export function jwt(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = encode({ role, iss: "supabase", iat: now, exp: now + 3600, jti: randomUUID() });
  const signature = createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

export async function sql(text, values) {
  const client = new pg.Client(databaseUrl);
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

/**
 * The host's side of a Supabase app: an orders table and the fulfillment
 * function, written as a host would in a later migration (CREATE OR REPLACE,
 * no search_path of its own, an unqualified table name). Each call is logged
 * in shop_fulfillments so a test can count them, and a reference starting
 * with "explode" raises after its update, to prove the rollback.
 */
const HOST_SQL = `
create table shop_orders (id text primary key, state text not null default 'awaiting_payment');
create table shop_fulfillments (reference text not null, payment_hash text not null, paid_at bigint not null);
revoke all on table shop_orders, shop_fulfillments from anon, authenticated;
create or replace function public.openreceive_on_paid(p_reference text, p_payment_hash text, p_paid_at bigint)
returns void language plpgsql as $$
begin
  update shop_orders set state = 'paid' where id = p_reference and state = 'awaiting_payment';
  insert into shop_fulfillments values (p_reference, p_payment_hash, p_paid_at);
  if p_reference like 'explode%' then
    raise exception 'the shop could not fulfill %', p_reference;
  end if;
end
$$;
`;

/** Drop everything OpenReceive and the host made, then migrate from scratch. */
export async function freshDatabase({ host = true } = {}) {
  const functions = await sql(
    "select p.oid::regprocedure::text as signature from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'openreceive\\_%'",
  );
  const drops = [
    ...functions.rows.map((row) => `drop function if exists ${row.signature};`),
    "drop table if exists openreceive_payments, openreceive_meta, shop_orders, shop_fulfillments;",
  ];
  await sql(drops.join("\n"));
  await sql(supabasePaymentsMigrationSql());
  if (host) await sql(HOST_SQL);
  await reloadSchema();
}

/** Empty the tables between tests; the schema stays. */
export async function emptyTables() {
  await sql(
    "truncate openreceive_payments, shop_orders, shop_fulfillments; delete from openreceive_meta where key <> 'schema_version';",
  );
}

/**
 * Wait until PostgREST's schema cache reflects every change made so far.
 * Supabase's image reloads the cache on each DDL statement, so a cache taken
 * between a drop and a create can still be loading. A function with a new
 * name each time is visible only in a cache loaded after this call began.
 */
export async function reloadSchema() {
  const marker = `test_schema_marker_${randomUUID().replaceAll("-", "")}`;
  const old = await sql(
    "select p.oid::regprocedure::text as signature from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'test\\_schema\\_marker\\_%'",
  );
  await sql(
    [
      ...old.rows.map((row) => `drop function ${row.signature};`),
      `create function public.${marker}() returns int language sql as 'select 1';`,
      "notify pgrst, 'reload schema';",
    ].join("\n"),
  );
  const token = jwt("service_role");
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`${restUrl}/rpc/${marker}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (response.ok) return;
    if (Date.now() > deadline)
      throw new Error(`PostgREST never reloaded its schema: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A stand-in for Supabase's API gateway: `/rest/v1` goes to PostgREST. A new
 * secret key must arrive in `apikey` alone; the gateway swaps it for a
 * service_role token, refuses it from a browser, and refuses a non-JWT in
 * Authorization, as Supabase does. A legacy JWT key passes through with its
 * Authorization header.
 */
export async function startGateway() {
  const requests = [];
  const serviceToken = jwt("service_role");
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
    if (!request.url.startsWith("/rest/v1/")) return reply(404, { message: "no route" });
    const apikey = request.headers.apikey;
    if (typeof apikey !== "string") return reply(401, { message: "No API key found in request" });
    let authorization = request.headers.authorization;
    if (apikey.startsWith("sb_")) {
      if (apikey !== SECRET_KEY) return reply(401, { message: "Invalid API key" });
      if (/Mozilla/.test(request.headers["user-agent"] ?? ""))
        return reply(401, { message: "Secret keys are not allowed from a browser" });
      if (authorization !== undefined)
        return reply(401, { message: "Authorization is not a JWT; send the key in apikey" });
      authorization = `Bearer ${serviceToken}`;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const forwarded = await fetch(`${restUrl}${request.url.slice("/rest/v1".length)}`, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries({
          authorization,
          accept: request.headers.accept,
          "content-type": request.headers["content-type"],
          prefer: request.headers.prefer,
        }).filter(([, value]) => value !== undefined),
      ),
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    const headers = {};
    for (const name of ["content-type", "content-range"]) {
      const value = forwarded.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    response.writeHead(forwarded.status, headers);
    response.end(Buffer.from(await forwarded.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
