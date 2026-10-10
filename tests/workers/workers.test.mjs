import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startTlsWallet, startWorker } from "./harness.mjs";

// OpenReceive on Cloudflare Workers, the runtime Lovable's TanStack Start apps
// deploy to. worker/src/index.js runs under `wrangler dev` (workerd, Node
// compatibility on) and reaches a wallet on a local relay and PostgreSQL
// through PgBouncer in transaction mode, as a Worker reaches a pooled Postgres
// such as Neon. OpenReceive only accepts wss relays, so the Worker reaches the
// relay through a TLS front with a throwaway CA that workerd is told to trust.
//
//   docker compose -f tests/orms/pooler/compose.yml up -d --wait
//   docker compose -f tests/workers/compose.yml up -d --wait
//   npm ci --prefix tests/workers && npm run build:packages
//   OPENRECEIVE_TEST_POOLER_URL=postgresql://openreceive:openreceive@127.0.0.1:56432/openreceive_test \
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:57777 \
//     npm run test:workers

const poolerUrl = process.env.OPENRECEIVE_TEST_POOLER_URL;
const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const skip =
  (!poolerUrl || !relayUrl) &&
  "Set OPENRECEIVE_TEST_POOLER_URL and OPENRECEIVE_TEST_RELAY_URL (see tests/workers/workers.test.mjs)";

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker");
let relay;
let wallet;
let worker;
let scratch;
let base;

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-workers-"));
  relay = await startTlsWallet(relayUrl, scratch);
  wallet = relay.wallet;
  worker = await startWorker({
    workerDir,
    vars: { NWC_URI: wallet.nwcUri, DATABASE_URL: poolerUrl },
    ca: relay.ca,
    scratch,
  });
  base = worker.base;
  const setup = await fetch(`${base}/setup`, { method: "POST" });
  assert.equal(setup.status, 204, worker.output.join(""));
});

after(async () => {
  await worker?.stop();
  relay?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function placeOrder() {
  const response = await fetch(`${base}/orders`, { method: "POST" });
  assert.equal(response.status, 200);
  return await response.json();
}

async function post(route, body, visitor) {
  const response = await fetch(`${base}/openreceive/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...(visitor === undefined ? {} : { cookie: `visitor=${visitor}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("a buyer gets a Lightning invoice, and a later request reuses it", { skip }, async () => {
  const order = await placeOrder();
  const first = await post("checkouts", { reference: order.id }, order.visitor);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.match(first.body.checkout.bolt11, /^lnbcrt2100000workers/);
  assert.equal(first.body.checkout.amount_msats, 2_100_000);

  // A new request builds a new stack: nothing from the first one is reused.
  const again = await post("checkouts", { reference: order.id }, order.visitor);
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.checkout.payment_hash, first.body.checkout.payment_hash);
});

test("a stranger is refused the buyer's order", { skip }, async () => {
  const order = await placeOrder();
  const stranger = await post("checkouts", { reference: order.id }, "someone-else");
  assert.equal(stranger.status, 403);
  const anonymous = await post("checkouts", { reference: order.id });
  assert.equal(anonymous.status, 403);
});

test("concurrent requests for one order leave one live attempt", { skip }, async () => {
  const order = await placeOrder();
  const results = await Promise.all(
    [1, 2, 3].map(() => post("checkouts", { reference: order.id }, order.visitor)),
  );
  // Each request mints in its own stack; the lock in the database lets one
  // commit. The others are refused before their invoice reaches the payer.
  const committed = results.filter((result) => result.status === 201);
  const refused = results.filter((result) => result.status === 409);
  assert.equal(committed.length + refused.length, 3, JSON.stringify(results));
  assert.ok(committed.length >= 1, JSON.stringify(results));
  const hashes = new Set(committed.map((result) => result.body.checkout.payment_hash));
  assert.equal(hashes.size, 1);
  for (const result of refused) assert.equal(result.body.code, "CONFLICT");

  const retry = await post("checkouts", { reference: order.id }, order.visitor);
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.checkout.payment_hash, [...hashes][0]);
});

test("a paid invoice settles and runs onPaid through the pooler", { skip }, async () => {
  const order = await placeOrder();
  const created = await post("checkouts", { reference: order.id }, order.visitor);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const paymentHash = created.body.checkout.payment_hash;
  wallet.settle(paymentHash);

  // The reconcile gate allows one wallet scan every few seconds; until the
  // next one, payments/check answers from the stored row.
  let check;
  const deadline = Date.now() + 30_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check = await post(
      "payments/check",
      { reference: order.id, payment_hash: paymentHash },
      order.visitor,
    );
    assert.equal(check.status, 200, JSON.stringify(check.body));
  } while (check.body.status !== "settled" && Date.now() < deadline);
  assert.equal(check.body.status, "settled");

  const row = await (await fetch(`${base}/orders/${order.id}`)).json();
  assert.equal(row.state, "paid");
});
