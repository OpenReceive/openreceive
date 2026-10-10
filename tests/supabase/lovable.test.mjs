import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startTlsWallet, startWorker } from "../workers/harness.mjs";
import {
  freshDatabase,
  reloadSchema,
  SECRET_KEY,
  skip as databaseSkip,
  sql,
  startGateway,
} from "./harness.mjs";

// The shape of a Lovable app's checkout: the TanStack Start recipe's Supabase
// route in a Worker, a wallet on the local relay, payments and orders in
// Supabase over its HTTPS API, the buyer known by a cookie, and fulfillment
// in the database's openreceive_on_paid. Needs the relay from
// tests/workers/compose.yml besides this lane's stack:
//
//   docker compose -f tests/workers/compose.yml up -d --wait
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:57777 (with the harness's variables)

const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "lovable-worker");
const wrangler = path.join(workerDir, "..", "..", "workers", "node_modules", ".bin", "wrangler");
const skip =
  databaseSkip ||
  (!relayUrl && "Set OPENRECEIVE_TEST_RELAY_URL (see tests/workers/workers.test.mjs)") ||
  (!existsSync(wrangler) && "Run npm ci --prefix tests/workers to install wrangler");

let gateway;
let relay;
let worker;
let scratch;

before(async () => {
  if (skip) return;
  gateway = await startGateway();
  await freshDatabase();
  await sql(
    "alter table shop_orders add column amount text not null default '2100', add column buyer_token text",
  );
  await reloadSchema();
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-lovable-"));
  relay = await startTlsWallet(relayUrl, scratch);
  worker = await startWorker({
    workerDir,
    vars: {
      NWC_URI: relay.wallet.nwcUri,
      SUPABASE_URL: gateway.url,
      SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
    },
    ca: relay.ca,
    scratch,
  });
});

after(async () => {
  await worker?.stop();
  relay?.close();
  await gateway?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** An order as the shop's server function makes it: the buyer's cookie value on the row. */
async function placeOrder() {
  const order = { id: randomUUID(), buyer: randomUUID() };
  await sql("insert into shop_orders (id, buyer_token) values ($1, $2)", [order.id, order.buyer]);
  return order;
}

async function post(route, body, buyer) {
  const response = await fetch(`${worker.base}/openreceive/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...(buyer === undefined ? {} : { cookie: `buyer=${buyer}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("a buyer gets a Lightning invoice, and a later request reuses it", { skip }, async () => {
  const order = await placeOrder();
  const first = await post("checkouts", { reference: order.id }, order.buyer);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.checkout.bolt11, /^lnbcrt2100000workers/);
  const again = await post("checkouts", { reference: order.id }, order.buyer);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.checkout.payment_hash, first.body.checkout.payment_hash);
});

test("a stranger is refused the buyer's order", { skip }, async () => {
  const order = await placeOrder();
  assert.equal((await post("checkouts", { reference: order.id }, randomUUID())).status, 403);
  assert.equal((await post("checkouts", { reference: order.id })).status, 403);
});

test("concurrent requests for one order leave one live attempt", { skip }, async () => {
  const order = await placeOrder();
  const results = await Promise.all(
    [1, 2, 3].map(() => post("checkouts", { reference: order.id }, order.buyer)),
  );
  const committed = results.filter((result) => result.status === 201);
  const refused = results.filter((result) => result.status === 409);
  assert.equal(committed.length + refused.length, 3, JSON.stringify(results));
  assert.equal(new Set(committed.map((result) => result.body.checkout.payment_hash)).size, 1);
  const rows = await sql(
    "select count(*)::int as n from openreceive_payments where reference = $1",
    [order.id],
  );
  assert.equal(rows.rows[0].n, 1);
});

test("a paid invoice settles and openreceive_on_paid marks the order paid", { skip }, async () => {
  const order = await placeOrder();
  const created = await post("checkouts", { reference: order.id }, order.buyer);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const paymentHash = created.body.checkout.payment_hash;
  relay.wallet.settle(paymentHash);

  // The reconcile gate allows one wallet scan every few seconds; until the
  // next one, payments/check answers from the stored row.
  let check;
  const deadline = Date.now() + 30_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check = await post(
      "payments/check",
      { reference: order.id, payment_hash: paymentHash },
      order.buyer,
    );
    assert.equal(check.status, 200, JSON.stringify(check.body));
  } while (check.body.status !== "settled" && Date.now() < deadline);
  assert.equal(check.body.status, "settled");
  const state = await sql("select state from shop_orders where id = $1", [order.id]);
  assert.equal(state.rows[0].state, "paid");
  const fulfilled = await sql(
    "select count(*)::int as n from shop_fulfillments where reference = $1",
    [order.id],
  );
  assert.equal(fulfilled.rows[0].n, 1);
});
