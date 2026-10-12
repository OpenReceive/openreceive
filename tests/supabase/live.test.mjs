import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { supabasePaymentsMigrationSql } from "../../packages/js/core/src/index.ts";
import {
  createHost,
  createHttpHandler,
  createSqlPayments,
  createSupabasePayments,
  maybeReconcilePayments,
} from "../../packages/js/http/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { createTestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";

// A real Supabase project, where the rest of this lane has only Supabase's
// images and a stand-in gateway: Supavisor in transaction mode with
// Supabase's own certificate authority, the real API gateway with an
// sb_secret_ key, and the default grants a new project gives anon. It
// replaces the project's OpenReceive tables, so point it at a throwaway
// project.
//
//   npm run test:live:supabase
//
// Reads SUPABASE_TRIAL_URL, _SECRET_KEY, _PUBLISHABLE_KEY and _POOLER_URL
// (the transaction pooler, port 6543, with the password) from the
// repo-root .env.

const here = path.dirname(fileURLToPath(import.meta.url));
// Only the SUPABASE_TRIAL_ values: the wallet and swap codes beside them
// would turn on the engine's live swap providers.
const trial = (() => {
  if (process.env.OPENRECEIVE_LIVE_SUPABASE !== "1") return {};
  try {
    return Object.fromEntries(
      readFileSync(path.join(here, "../../.env"), "utf8")
        .split("\n")
        .map((line) => line.match(/^(SUPABASE_TRIAL_[A-Z_]+)=(.*)$/))
        .filter(Boolean)
        .map(([, name, value]) => [name, value.trim()]),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {};
  }
})();
const projectUrl = trial.SUPABASE_TRIAL_URL;
const secretKey = trial.SUPABASE_TRIAL_SECRET_KEY;
const publishableKey = trial.SUPABASE_TRIAL_PUBLISHABLE_KEY;
const poolerUrl = trial.SUPABASE_TRIAL_POOLER_URL;
const skip =
  process.env.OPENRECEIVE_LIVE_SUPABASE !== "1"
    ? "Run with npm run test:live:supabase"
    : (!projectUrl || !secretKey || !publishableKey || !poolerUrl) &&
      "Set SUPABASE_TRIAL_URL, _SECRET_KEY, _PUBLISHABLE_KEY and _POOLER_URL in the repo-root .env";

// The guide's Node connection: no sslmode in the URL, Supabase's CA as ssl.ca.
const ca = readFileSync(path.join(here, "prod-ca-2021.crt"), "utf8");
function poolConfig() {
  const url = new URL(poolerUrl);
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: { ca } };
}

const NOW = 1_000;
const run = randomUUID().slice(0, 8);
const ref = (name) => `live-${run}-${name}`;
// Payment hashes are unique across the table, and the table outlives a run.
const hash = (reference, character) =>
  createHash("sha256").update(`${reference}:${character}`).digest("hex");
let pool;

async function sql(text, values) {
  return pool.query(text, values);
}

// Supabase reloads PostgREST's schema cache on DDL; wait until a function
// created after the migration answers over the gateway.
async function reloadSchema() {
  const marker = `test_schema_marker_${randomUUID().replaceAll("-", "")}`;
  const old = await sql(
    "select p.oid::regprocedure::text as signature from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'test\\_schema\\_marker\\_%'",
  );
  await sql(
    [
      ...old.rows.map((row) => `drop function ${row.signature};`),
      `create function public.${marker}() returns int language sql as 'select 1';`,
      `revoke all on function public.${marker}() from public, anon, authenticated;`,
      "notify pgrst, 'reload schema';",
    ].join("\n"),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${projectUrl}/rest/v1/rpc/${marker}`, {
      method: "POST",
      headers: { apikey: secretKey, "content-type": "application/json" },
      body: "{}",
    });
    if (response.ok) return;
    if (Date.now() > deadline)
      throw new Error(`PostgREST never reloaded its schema: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  if (skip) return;
  pool = new pg.Pool({ ...poolConfig(), max: 4 });
  const functions = await sql(
    "select p.oid::regprocedure::text as signature from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'openreceive\\_%'",
  );
  await sql(
    [
      ...functions.rows.map((row) => `drop function if exists ${row.signature};`),
      "drop table if exists openreceive_payments, openreceive_meta, live_orders;",
    ].join("\n"),
  );
  await sql(supabasePaymentsMigrationSql());
  // The host's side, as the guide writes it: an orders table the Data API
  // cannot reach, and fulfillment that marks the order paid.
  await sql(`
create table live_orders (id text primary key, status text not null default 'pending', fulfilled integer not null default 0);
alter table live_orders enable row level security;
revoke all on table live_orders from anon, authenticated;
create or replace function public.openreceive_on_paid(p_reference text, p_payment_hash text, p_paid_at bigint)
returns void language plpgsql as $$
begin
  update live_orders set status = 'paid', fulfilled = fulfilled + 1 where id = p_reference and status = 'pending';
end
$$;
`);
  await reloadSchema();
});

after(async () => {
  await pool?.end();
});

function repository({ fetch } = {}) {
  return createSupabasePayments({
    url: projectUrl,
    key: secretKey,
    clock: () => NOW,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

function attempt(reference, character, { swap } = {}) {
  const paymentHash = hash(reference, character);
  return {
    reference,
    paymentHash,
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt: 900,
      expiresAt: 1_600,
      fiatQuote: null,
    },
    ...(swap === undefined
      ? {}
      : {
          swapData: {
            version: 1,
            providerOrder: {
              provider: "test",
              provider_order_id: `provider-${swap}`,
              provider_token: "server-only",
              pay_in_asset: swap,
              deposit_address: "T-address",
              deposit_amount: "1",
              expires_at: 1_600,
              state: "awaiting_deposit",
            },
          },
        }),
  };
}

async function order(reference) {
  await sql("insert into live_orders (id) values ($1)", [reference]);
}

async function orderRow(reference) {
  return (await sql("select status, fulfilled from live_orders where id = $1", [reference]))
    .rows[0];
}

test("the gateway takes the secret key in apikey alone and refuses another", {
  skip,
}, async () => {
  const sent = [];
  const payments = repository({
    fetch: (url, init) => {
      sent.push(new Headers(init.headers));
      return fetch(url, init);
    },
  });
  await payments.commitAttempt(attempt(ref("key"), "a"));
  assert.equal((await payments.listForReference(ref("key"))).length, 1);
  assert.ok(sent.length > 0);
  for (const headers of sent) {
    assert.equal(headers.get("apikey"), secretKey);
    assert.equal(headers.get("authorization"), null);
  }
  const wrong = createSupabasePayments({
    url: projectUrl,
    key: `sb_secret_${"x".repeat(32)}`,
    clock: () => NOW,
  });
  await assert.rejects(wrong.listForReference(ref("key")), (error) => {
    assert.match(error.message, /Supabase refused the key/);
    assert.equal(error.status, 503);
    return true;
  });
});

test("the publishable key reaches no OpenReceive table or function", { skip }, async () => {
  const headers = { apikey: publishableKey, "content-type": "application/json" };
  for (const table of ["openreceive_payments", "openreceive_meta", "live_orders"]) {
    const response = await fetch(`${projectUrl}/rest/v1/${table}?select=*`, { headers });
    assert.equal(response.status, 401, `${table}: ${await response.text()}`);
  }
  const functions = (
    await sql(
      "select proname, coalesce(proargnames, '{}') as args from pg_proc where pronamespace = 'public'::regnamespace and proname like 'openreceive\\_%'",
    )
  ).rows;
  assert.ok(functions.some((row) => row.proname === "openreceive_on_paid"));
  for (const { proname, args } of functions) {
    const response = await fetch(`${projectUrl}/rest/v1/rpc/${proname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(Object.fromEntries(args.map((name) => [name, null]))),
    });
    const body = await response.json();
    assert.equal(response.status, 401, `${proname}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "42501", `${proname}: ${JSON.stringify(body)}`);
  }
});

test("concurrent creates for one reference leave one live attempt", { skip }, async () => {
  const results = await Promise.allSettled(
    "abcdef"
      .split("")
      .map((character) => repository().commitAttempt(attempt(ref("race"), character))),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected"))
    assert.equal(result.reason.status, 409, String(result.reason));
  assert.equal((await repository().listForReference(ref("race"))).length, 1);
});

test("concurrent settlements of sibling attempts fulfill once", { skip }, async () => {
  const reference = ref("settle");
  const payments = repository();
  await order(reference);
  await payments.commitAttempt(attempt(reference, "a"));
  await payments.commitAttempt(attempt(reference, "b", { swap: "USDT_TRON" }));
  await payments.commitAttempt(attempt(reference, "c", { swap: "USDC_SOL" }));
  const won = await Promise.all(
    ["a", "b", "c", "a", "b", "c"].map((character) =>
      repository().recordSettlement({ paymentHash: hash(reference, character), paidAt: 990 }),
    ),
  );
  assert.equal(won.filter(Boolean).length, 1);
  assert.deepEqual(await orderRow(reference), { status: "paid", fulfilled: 1 });
  const rows = await payments.listForReference(reference);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["settled", "settled", "settled"],
  );
  assert.equal(rows.filter((row) => row.statusReason === null).length, 1);
});

test("a server on the pooler and one over HTTPS share the reference lock", {
  skip,
}, async () => {
  const sqlPayments = createSqlPayments(pool, { clock: () => NOW });
  // Each reference gets one attempt through the pooler and one over HTTPS, at
  // once. Both are Lightning, so only one may stay live.
  const references = Array.from({ length: 8 }, (_, n) => ref(`mixed-${n}`));
  const results = await Promise.all(
    references.map(async (reference, n) => {
      const settled = await Promise.allSettled([
        sqlPayments.commitAttempt(attempt(reference, "01234567"[n])),
        repository().commitAttempt(attempt(reference, "89abcdef"[n])),
      ]);
      return {
        won: settled.filter((result) => result.status === "fulfilled").length,
        rows: (await sqlPayments.listForReference(reference)).length,
      };
    }),
  );
  for (const result of results) assert.deepEqual(result, { won: 1, rows: 1 });
});

test("the mounted routes create, settle and fulfill through the project", {
  skip,
}, async () => {
  const reference = ref("shop");
  let now = NOW;
  const clock = () => now;
  const wallet = createTestkitReceiveClient({ now: clock });
  const service = await createOpenReceive({ client: wallet, clock });
  await order(reference);
  const host = createHost({
    supabase: { url: projectUrl, key: secretKey },
    amountFor: async (id) => ((await orderRow(id)) ? { sats: 21 } : null),
    clock,
  });
  const handler = createHttpHandler({ service, host, authorize: () => true, clock });
  const post = (route, body) =>
    handler(
      new Request(`http://shop.test/openreceive${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const created = await post("/checkouts", { reference });
  assert.equal(created.status, 201, await created.clone().text());
  const { checkout } = await created.json();
  wallet.settleInvoice({ payment_hash: checkout.payment_hash }, { settled_at: NOW + 5 });
  now = NOW + 10;
  assert.equal((await maybeReconcilePayments({ service, host, clock })).reason, "ran");
  assert.deepEqual(await orderRow(reference), { status: "paid", fulfilled: 1 });
  const check = await post("/payments/check", { reference, payment_hash: checkout.payment_hash });
  assert.equal((await check.json()).status, "settled");
  assert.equal((await post("/checkouts", { reference })).status, 409);
  await service.close?.();
});
