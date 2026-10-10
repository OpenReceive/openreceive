import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import {
  OPENRECEIVE_ON_PAID_STUB_MARKER,
  supabasePaymentsMigrationSql,
} from "../../packages/js/core/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import {
  createHost,
  createHttpHandler,
  createStack,
  createSupabasePayments,
  maybeReconcilePayments,
} from "../../packages/js/http/src/index.ts";
import { createTestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";
import {
  emptyTables,
  freshDatabase,
  jwt,
  reloadSchema,
  restUrl,
  SECRET_KEY,
  skip,
  sql,
  startGateway,
} from "./harness.mjs";

// The Supabase repository against Supabase's own Postgres image and PostgREST,
// through a stand-in for Supabase's API gateway: the path a Lovable app on
// Cloudflare Workers takes to its database. Each write goes through one of the
// scaffold migration's SQL functions, so these tests run the real locking,
// snapshot checks and the host's openreceive_on_paid.

const hash = (character) => character.repeat(64);
const NOW = 1_000;

let gateway;

before(async () => {
  if (skip) return;
  gateway = await startGateway();
  await freshDatabase();
});

after(async () => {
  await gateway?.close();
});

beforeEach(async () => {
  if (skip) return;
  await emptyTables();
});

/** A repository with its own service_role JWT, so no storage check is shared. */
function repository({ clock = () => NOW, fetch, key = jwt("service_role") } = {}) {
  return createSupabasePayments({
    url: gateway.url,
    key,
    clock,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

function swapData(asset, expiresAt = 1_600) {
  return {
    version: 1,
    providerOrder: {
      provider: "test",
      provider_order_id: `provider-${asset}`,
      provider_token: "server-only",
      pay_in_asset: asset,
      deposit_address: "T-address",
      deposit_amount: "1",
      expires_at: expiresAt,
      state: "awaiting_deposit",
    },
  };
}

function attempt(
  reference,
  character,
  { createdAt = 900, expiresAt = 1_600, swap, clientIp } = {},
) {
  const paymentHash = hash(character);
  return {
    reference,
    paymentHash,
    checkout: {
      reference,
      paymentHash,
      bolt11: `lnbc-${character}`,
      amountMsats: 1_000,
      createdAt,
      expiresAt,
      fiatQuote: null,
    },
    ...(swap === undefined ? {} : { swapData: swap }),
    ...(clientIp === undefined ? {} : { clientIp }),
  };
}

async function order(reference) {
  await sql("insert into shop_orders (id) values ($1)", [reference]);
}

async function orderState(reference) {
  return (await sql("select state from shop_orders where id = $1", [reference])).rows[0]?.state;
}

async function fulfillments(reference) {
  return (await sql("select payment_hash from shop_fulfillments where reference = $1", [reference]))
    .rows;
}

async function rejectsWith(promise, pattern, status) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, pattern);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test("commitAttempt follows the SQL repository's rules for one reference", { skip }, async () => {
  const payments = repository();
  await payments.commitAttempt(attempt("order-1", "a"));
  await payments.commitAttempt(attempt("order-1", "a"));
  let rows = await payments.listForReference("order-1");
  assert.equal(rows.length, 1, "a repeated payment hash is a no-op");
  assert.deepEqual(rows[0].checkout, attempt("order-1", "a").checkout);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].statusReason, null);

  await rejectsWith(
    payments.commitAttempt(attempt("order-1", "b")),
    /already in progress for this reference/,
    409,
  );
  await payments.commitAttempt(attempt("order-1", "c", { swap: swapData("USDT_TRON") }));
  assert.equal((await payments.listForReference("order-1")).length, 2, "another rail stays live");

  // 30 seconds of life left is inside the reuse buffer: superseded, not closed.
  await payments.commitAttempt(attempt("order-2", "d", { expiresAt: NOW + 30 }));
  await payments.commitAttempt(attempt("order-2", "e"));
  rows = await payments.listForReference("order-2");
  const old = rows.find((row) => row.paymentHash === hash("d"));
  assert.equal(old.status, "pending");
  assert.equal(old.statusReason, "superseded");
  assert.deepEqual(
    rows.map((row) => row.paymentHash),
    [hash("e"), hash("d")],
    "newest first, as the SQL repository lists them",
  );
});

test("the first settlement runs openreceive_on_paid in its transaction, once", {
  skip,
}, async () => {
  const payments = repository();
  await order("order-3");
  await payments.commitAttempt(attempt("order-3", "a"));
  await payments.commitAttempt(attempt("order-3", "b", { swap: swapData("USDC_SOL") }));

  assert.equal(await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }), true);
  assert.equal(await orderState("order-3"), "paid");
  assert.equal(await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 991 }), false);
  // A genuine second payment on a sibling is recorded, never fulfilled again.
  assert.equal(await payments.recordSettlement({ paymentHash: hash("b"), paidAt: 995 }), false);
  assert.equal(await payments.recordSettlement({ paymentHash: hash("f"), paidAt: 995 }), false);
  assert.deepEqual(await fulfillments("order-3"), [{ payment_hash: hash("a") }]);

  const rows = await payments.listForReference("order-3");
  const first = rows.find((row) => row.paymentHash === hash("a"));
  const second = rows.find((row) => row.paymentHash === hash("b"));
  assert.deepEqual([first.status, first.statusReason, first.paidAt], ["settled", null, 990]);
  assert.deepEqual(
    [second.status, second.statusReason, second.paidAt],
    ["settled", "duplicate_settlement", 995],
  );
  await rejectsWith(payments.commitAttempt(attempt("order-3", "g")), /already paid/, 409);
});

test("a failing openreceive_on_paid records nothing, and the next pass retries", {
  skip,
}, async () => {
  const payments = repository();
  await order("explode-1");
  await payments.commitAttempt(attempt("explode-1", "a"));
  await rejectsWith(
    payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }),
    /Settlement was not recorded.*could not fulfill explode-1/,
  );
  const [row] = await payments.listForReference("explode-1");
  assert.equal(row.status, "pending");
  assert.equal(row.paidAt, null);
  assert.equal(await orderState("explode-1"), "awaiting_payment", "the order update rolled back");
  assert.deepEqual(await fulfillments("explode-1"), []);
  assert.equal((await payments.findPendingAttempt(hash("a"))).paymentHash, hash("a"));
});

test("reconciliation applies only while pending and never settles", { skip }, async () => {
  const payments = repository();
  await order("order-4");
  await payments.commitAttempt(attempt("order-4", "a"));
  await payments.commitAttempt(attempt("order-4", "b", { swap: swapData("USDT_TRON") }));
  await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 });
  const expire = (character) => ({
    paymentHash: hash(character),
    status: "expired",
    observedAt: 2_600,
    reason: "not_found_after_expiry",
  });
  await payments.recordReconciliation(expire("a"));
  await payments.recordReconciliation(expire("b"));
  await payments.recordReconciliation(expire("c"));
  const rows = await payments.listForReference("order-4");
  assert.equal(rows.find((row) => row.paymentHash === hash("a")).status, "settled");
  assert.deepEqual(
    [rows.find((row) => row.paymentHash === hash("b")).status],
    ["expired"],
    "a pending attempt closes",
  );
  await payments.commitAttempt(attempt("order-5", "d"));
  await rejectsWith(
    payments.recordReconciliation({ ...expire("d"), status: "settled" }),
    /cannot set status settled/,
  );
  assert.equal((await payments.findByPaymentHash(hash("d"))).status, "pending");
});

test("pending attempts page oldest first, by keyset", { skip }, async () => {
  const payments = repository();
  await payments.commitAttempt(attempt("page-1", "a", { createdAt: 700 }));
  await payments.commitAttempt(attempt("page-2", "b", { createdAt: 800 }));
  await payments.commitAttempt(attempt("page-3", "c", { createdAt: 800 }));
  await payments.commitAttempt(attempt("page-4", "d", { createdAt: 900 }));
  await payments.recordReconciliation({
    paymentHash: hash("d"),
    status: "failed",
    observedAt: 950,
    reason: "wallet_reported_failed",
  });
  const all = await payments.listReconcilableAttempts();
  assert.deepEqual(
    all.map((row) => [row.paymentHash, row.createdAt, row.expiresAt, row.createdAtSource]),
    [
      [hash("a"), 700, 1_600, "host"],
      [hash("b"), 800, 1_600, "host"],
      [hash("c"), 800, 1_600, "host"],
    ],
  );
  const next = await payments.listReconcilableAttempts({
    created_at: 800,
    payment_hash: hash("b"),
  });
  assert.deepEqual(
    next.map((row) => row.paymentHash),
    [hash("c")],
  );
  assert.equal(await payments.findPendingAttempt(hash("d")), undefined);
  await rejectsWith(
    payments.listReconcilableAttempts({ created_at: 1, payment_hash: "x),status.eq.settled" }),
    /malformed payment hash/,
  );
});

test("references with PostgREST's reserved characters round-trip", { skip }, async () => {
  const payments = repository();
  const reference = `a,b.c:(d)"e' &x=y%20/z`;
  await order(reference);
  await payments.commitAttempt(attempt(reference, "a"));
  await payments.commitAttempt(attempt("a", "b"));
  const rows = await payments.listForReference(reference);
  assert.deepEqual(
    rows.map((row) => row.reference),
    [reference],
  );
  assert.equal(await payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }), true);
  assert.equal(await orderState(reference), "paid");
});

test("the rate limit counts attempts by their insert stamp", { skip }, async () => {
  let now = NOW;
  const payments = repository({ clock: () => now });
  await payments.commitAttempt(attempt("ip-1", "a", { clientIp: "203.0.113.9" }));
  now = NOW + 100;
  await payments.commitAttempt(attempt("ip-2", "b", { clientIp: "203.0.113.9" }));
  await payments.commitAttempt(attempt("ip-3", "c", { clientIp: "2001:db8::1" }));
  assert.equal(await payments.countAttemptsFromIp("203.0.113.9", NOW), 2);
  assert.equal(await payments.countAttemptsFromIp("203.0.113.9", NOW + 50), 1);
  assert.equal(await payments.countAttemptsFromIp("2001:db8::1", 0), 1);
  assert.equal(await payments.countAttemptsFromIp("198.51.100.1", 0), 0);
});

test("the reconcile gate is one durable lease shared by every repository", { skip }, async () => {
  const first = repository();
  const second = repository();
  const claim = await first.claimReconcileGate({ now: NOW, intervalSeconds: 3, leaseSeconds: 10 });
  assert.ok(claim?.token);
  assert.equal(await second.claimReconcileGate({ now: NOW, intervalSeconds: 3 }), null);
  const scheduler = { cursor: { created_at: 900, payment_hash: hash("a") }, windows: [] };
  assert.equal(
    await first.checkpointReconcileGate({ claim, scheduler, now: NOW + 1, release: true }),
    true,
  );
  assert.equal(
    await second.checkpointReconcileGate({ claim, scheduler, now: NOW + 1 }),
    false,
    "a released lease takes no more progress",
  );
  // After the interval, the next claim carries the saved progress.
  const next = await second.claimReconcileGate({ now: NOW + 5, intervalSeconds: 3 });
  assert.deepEqual(next.scheduler, scheduler);
  // Racing claims: exactly one wins.
  const racers = await Promise.all(
    Array.from({ length: 6 }, () =>
      repository().claimReconcileGate({ now: NOW + 20, intervalSeconds: 3 }),
    ),
  );
  assert.equal(racers.filter((result) => result !== null).length, 1);
});

test("concurrent creates for one reference leave one live attempt", { skip }, async () => {
  const results = await Promise.allSettled(
    "abcdef".split("").map((character) => repository().commitAttempt(attempt("race-1", character))),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results.filter((entry) => entry.status === "rejected"))
    assert.equal(result.reason.status, 409, String(result.reason));
  assert.equal((await repository().listForReference("race-1")).length, 1);
});

test("concurrent settlements of sibling attempts fulfill once", { skip }, async () => {
  const payments = repository();
  await order("race-2");
  await payments.commitAttempt(attempt("race-2", "a"));
  await payments.commitAttempt(attempt("race-2", "b", { swap: swapData("USDT_TRON") }));
  await payments.commitAttempt(attempt("race-2", "c", { swap: swapData("USDC_SOL") }));
  const won = await Promise.all(
    ["a", "b", "c", "a", "b", "c"].map((character) =>
      repository().recordSettlement({ paymentHash: hash(character), paidAt: 990 }),
    ),
  );
  assert.equal(won.filter(Boolean).length, 1);
  assert.equal((await fulfillments("race-2")).length, 1);
  const rows = await payments.listForReference("race-2");
  assert.deepEqual(
    rows.map((row) => row.status),
    ["settled", "settled", "settled"],
  );
  assert.equal(rows.filter((row) => row.statusReason === null).length, 1);
});

test("a write between the read and the function makes the repository read again", {
  skip,
}, async () => {
  const intruder = repository();
  let intruded = false;
  const reads = [];
  const payments = repository({
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (init.method === "GET" && path.endsWith("/openreceive_payments")) reads.push(path);
      if (path.endsWith("/rpc/openreceive_commit_attempt") && !intruded) {
        intruded = true;
        await intruder.commitAttempt(attempt("stale-1", "b", { swap: swapData("USDT_TRON") }));
      }
      return fetch(url, init);
    },
  });
  await payments.commitAttempt(attempt("stale-1", "a"));
  assert.equal(reads.length, 2, "one read, a stale refusal, and a second read");
  assert.deepEqual(
    (await payments.listForReference("stale-1")).map((row) => row.paymentHash).sort(),
    [hash("a"), hash("b")],
  );

  // The same on settlement: a sibling settles first, so this one is a duplicate.
  await order("stale-2");
  await intruder.commitAttempt(attempt("stale-2", "c"));
  await intruder.commitAttempt(attempt("stale-2", "d", { swap: swapData("USDT_TRON") }));
  intruded = false;
  const settling = repository({
    fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith("/rpc/openreceive_record_settlement") && !intruded) {
        intruded = true;
        await intruder.recordSettlement({ paymentHash: hash("d"), paidAt: 980 });
      }
      return fetch(url, init);
    },
  });
  assert.equal(await settling.recordSettlement({ paymentHash: hash("c"), paidAt: 990 }), false);
  assert.deepEqual(await fulfillments("stale-2"), [{ payment_hash: hash("d") }]);
  assert.equal((await settling.findByPaymentHash(hash("c"))).statusReason, "duplicate_settlement");
});

test("the anon role reaches no table and no function", { skip }, async () => {
  const anon = jwt("anon");
  const headers = { authorization: `Bearer ${anon}`, "content-type": "application/json" };
  for (const table of ["openreceive_payments", "openreceive_meta"]) {
    const response = await fetch(`${restUrl}/${table}?select=*`, { headers });
    assert.equal(response.status, 401, `${table}: ${await response.text()}`);
  }
  const functions = (
    await sql(
      "select proname, coalesce(proargnames, '{}') as args from pg_proc where pronamespace = 'public'::regnamespace and proname like 'openreceive\\_%'",
    )
  ).rows;
  assert.ok(functions.some((row) => row.proname === "openreceive_on_paid"));
  for (const { proname, args } of functions) {
    // Every argument by name, so PostgREST resolves the function and only
    // the missing EXECUTE privilege can refuse the call.
    const response = await fetch(`${restUrl}/rpc/${proname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(Object.fromEntries(args.map((name) => [name, null]))),
    });
    const body = await response.json();
    assert.equal(response.status, 401, `${proname}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "42501", `${proname}: ${JSON.stringify(body)}`);
  }
});

test("storage refuses to serve until the database is safe and fulfills", { skip }, async () => {
  const refuses = async (setup, pattern, undo) => {
    await sql(setup);
    await reloadSchema();
    try {
      await assert.rejects(repository().listForReference("x"), (error) => {
        assert.match(error.message, pattern);
        assert.equal(error.status, 503);
        assert.doesNotMatch(error.body.message, /anon|openreceive_on_paid|grant/i);
        return true;
      });
    } finally {
      await sql(undo);
      await reloadSchema();
    }
  };
  await refuses(
    "grant select on openreceive_payments to anon",
    /public roles can reach.*anon on table openreceive_payments/,
    "revoke select on openreceive_payments from anon",
  );
  await refuses(
    "grant execute on function openreceive_on_paid(text, text, bigint) to authenticated",
    /authenticated on function openreceive_on_paid/,
    "revoke execute on function openreceive_on_paid(text, text, bigint) from authenticated",
  );
  await refuses(
    "alter table openreceive_meta disable row level security",
    /Row level security is off on openreceive_meta/,
    "alter table openreceive_meta enable row level security",
  );
  await refuses(
    "update openreceive_meta set value = '2' where key = 'schema_version'",
    /schema version 2, newer than/,
    "update openreceive_meta set value = '1' where key = 'schema_version'",
  );
  // A host's own fulfillment survives the migration being applied again.
  await sql(supabasePaymentsMigrationSql());
  await reloadSchema();
  await repository().listForReference("x");

  await freshDatabase({ host: false });
  try {
    await rejectsWith(repository().listForReference("x"), /still the scaffold's placeholder/, 503);
    await sql("drop function openreceive_on_paid(text, text, bigint)");
    await reloadSchema();
    await rejectsWith(
      repository().listForReference("x"),
      /openreceive_on_paid.*does not exist/,
      503,
    );
    await sql(
      "drop function openreceive_record_settlement(text, text, jsonb, bigint, boolean, bigint)",
    );
    await rejectsWith(
      repository().listForReference("x"),
      /Missing functions:.*record_settlement/,
      503,
    );
    await sql("drop function openreceive_supabase_status()");
    await reloadSchema().catch(() => {});
    await rejectsWith(repository().listForReference("x"), /scaffold payments --supabase/, 503);
  } finally {
    await freshDatabase();
  }
});

test("a stub put back after the storage check still refuses settlement", { skip }, async () => {
  // A long-lived server checked storage before the stub came back.
  const payments = repository();
  await payments.commitAttempt(attempt("stub-2", "a"));
  await sql(
    `create or replace function openreceive_on_paid(p_reference text, p_payment_hash text, p_paid_at bigint) returns void language plpgsql as $$ begin raise exception '${OPENRECEIVE_ON_PAID_STUB_MARKER}: x'; end $$`,
  );
  try {
    await rejectsWith(
      payments.recordSettlement({ paymentHash: hash("a"), paidAt: 990 }),
      /still the scaffold's placeholder/,
    );
    assert.equal((await payments.findByPaymentHash(hash("a"))).status, "pending");
  } finally {
    await freshDatabase();
  }
});

test("keys and URLs that must not reach the server are refused up front", { skip }, () => {
  const build = (options) => () =>
    createSupabasePayments({ url: gateway.url, key: SECRET_KEY, ...options });
  assert.throws(build({ key: "sb_publishable_abc" }), /publishable key/);
  assert.throws(build({ key: jwt("anon") }), /anon key/);
  assert.throws(build({ key: jwt("authenticated") }), /role is authenticated/);
  assert.throws(build({ key: " " }), /secret key/);
  assert.throws(build({ url: "http://example.supabase.co" }), /https:\/\//);
  assert.throws(build({ url: "http://8.8.8.8:8000" }), /https:\/\//);
  assert.throws(build({ url: "http://172.32.0.1" }), /https:\/\//);
  for (const url of ["http://kong:8000", "http://10.1.2.3", "http://192.168.1.9:54321"])
    assert.doesNotThrow(build({ url }), url);
  assert.throws(build({ url: "not a url" }), /project URL/);
  assert.doesNotThrow(build({ url: "https://example.supabase.co/rest/v1/" }));
});

test("a new secret key travels in apikey alone", { skip }, async () => {
  const payments = repository({ key: SECRET_KEY });
  const seen = gateway.requests.length;
  await payments.commitAttempt(attempt("secret-1", "a"));
  assert.equal((await payments.listForReference("secret-1")).length, 1);
  const sent = gateway.requests.slice(seen);
  assert.ok(sent.length > 0);
  for (const request of sent) {
    assert.equal(request.headers.apikey, SECRET_KEY);
    assert.equal(request.headers.authorization, undefined);
  }
  const wrong = repository({ key: "sb_secret_not_this_project" });
  await rejectsWith(wrong.listForReference("secret-1"), /Supabase refused the key/, 503);
});

test("createHost takes supabase storage and refuses a JS onPaid", { skip }, () => {
  const amountFor = () => ({ sats: 21 });
  assert.throws(
    () =>
      createHost({
        supabase: { url: gateway.url, key: SECRET_KEY },
        amountFor,
        onPaid: async () => {},
      }),
    /takes no onPaid/,
  );
  assert.throws(
    () =>
      createHost({
        payments: createSupabasePayments({ url: gateway.url, key: SECRET_KEY }),
        amountFor,
        onPaid: async () => {},
      }),
    /fulfills in SQL/,
  );
});

test("the mounted routes create, settle and fulfill through Supabase", { skip }, async () => {
  let now = NOW;
  const clock = () => now;
  const wallet = createTestkitReceiveClient({ now: clock });
  const service = await createOpenReceive({ client: wallet, clock });
  await order("shop-1");
  const host = createHost({
    supabase: { url: gateway.url, key: SECRET_KEY },
    amountFor: async (reference) => ((await orderState(reference)) ? { sats: 21 } : null),
    clock,
  });
  const handler = createHttpHandler({ service, host, authorize: () => true, clock });
  const post = (path, body) =>
    handler(
      new Request(`http://shop.test/openreceive${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const created = await post("/checkouts", { reference: "shop-1" });
  assert.equal(created.status, 201, await created.clone().text());
  const { checkout } = await created.json();
  assert.equal((await post("/checkouts", { reference: "nope" })).status, 404);

  wallet.settleInvoice({ payment_hash: checkout.payment_hash }, { settled_at: NOW + 5 });
  now = NOW + 10;
  const result = await maybeReconcilePayments({ service, host, clock });
  assert.equal(result.reason, "ran");
  assert.equal(await orderState("shop-1"), "paid");
  const check = await post("/payments/check", {
    reference: "shop-1",
    payment_hash: checkout.payment_hash,
  });
  assert.equal((await check.json()).status, "settled");
  assert.equal((await post("/checkouts", { reference: "shop-1" })).status, 409);
  await service.close?.();
});

test("createStack takes { supabase } storage", { skip }, async () => {
  const wallet = createTestkitReceiveClient({ now: () => NOW });
  await order("stack-1");
  const stack = createStack({
    wallet: { service: createOpenReceive({ client: wallet, clock: () => NOW }) },
    storage: { supabase: { url: gateway.url, key: jwt("service_role") } },
    amountFor: () => ({ sats: 21 }),
    authorize: () => true,
    clock: () => NOW,
  });
  const response = await stack.handler(
    new Request("http://shop.test/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "stack-1" }),
    }),
  );
  assert.equal(response.status, 201, await response.clone().text());
  await stack.close();
});
