import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freePort, startTlsWallet } from "../workers/harness.mjs";

// OpenReceive on Vercel Functions with no framework, as
// docs/recipes/vercel-functions.md writes it. The recipe's own files (the
// function, the pool, the signed guest cookie, the table script and
// vercel.json) are copied out of the markdown unchanged and served by
// vercel-local.mjs, which routes and invokes them as a Vercel deployment did
// when we measured one. Two servers stand in for two instances of the
// function, each with its own stack, on one database through PgBouncer in
// transaction mode, as Neon's pooler works. The wallet is the fake one on the
// local relay, behind TLS with a throwaway CA that Node is told to trust.
//
//   docker compose -f tests/orms/pooler/compose.yml up -d --wait
//   docker compose -f tests/workers/compose.yml up -d --wait
//   npm ci --prefix tests/workers && npm ci --prefix tests/vercel-functions
//   npm run build:packages
//   OPENRECEIVE_TEST_POOLER_URL=postgresql://openreceive:openreceive@127.0.0.1:56432/openreceive_test \
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:57777 \
//     npm run test:vercel-functions

const poolerUrl = process.env.OPENRECEIVE_TEST_POOLER_URL;
const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const skip =
  (!poolerUrl || !relayUrl) &&
  "Set OPENRECEIVE_TEST_POOLER_URL and OPENRECEIVE_TEST_RELAY_URL (see tests/vercel-functions/vercel-functions.test.mjs)";

const here = path.dirname(fileURLToPath(import.meta.url));
const recipe = path.join(here, "..", "..", "docs", "recipes", "vercel-functions.md");
// Inside this directory, so the app resolves @vercel/functions from here and
// @openreceive/http and pg from the repository's own node_modules.
const app = path.join(here, `.app-${process.pid}`);
const SESSION_SECRET = "vercel-functions-test-secret";
const REFERENCE_PREFIX = "vf-test-";

/** The recipe's files, keyed by the path its first comment names. */
function recipeFiles() {
  const markdown = readFileSync(recipe, "utf8");
  const files = new Map();
  for (const [, language, body] of markdown.matchAll(/```(\w+)\n([\s\S]*?)```/g)) {
    const named = body.split("\n")[0].match(/^\/\/ ([\w./-]+\.m?js)\b/)?.[1];
    if (named) files.set(named, body);
    else if (language === "json" && body.includes('"rewrites"')) files.set("vercel.json", body);
  }
  for (const file of [
    "api/openreceive.js",
    "lib/db.js",
    "lib/orders.js",
    "scripts/openreceive-tables.mjs",
    "vercel.json",
  ]) {
    assert.ok(files.has(file), `${path.relative(process.cwd(), recipe)} has no ${file} block`);
  }
  return files;
}

let scratch;
let relay;
let wallet;
let db;
const instances = [];

function write(relative, text) {
  mkdirSync(path.dirname(path.join(app, relative)), { recursive: true });
  writeFileSync(path.join(app, relative), text);
}

async function startInstance() {
  const port = await freePort();
  const output = [];
  const child = spawn(
    process.execPath,
    [path.join(here, "vercel-local.mjs"), "--root", app, "--port", String(port)],
    {
      env: {
        PATH: process.env.PATH,
        NWC_URI: wallet.nwcUri,
        DATABASE_URL: poolerUrl,
        SESSION_SECRET,
        NODE_EXTRA_CA_CERTS: relay.ca,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vercel-local exited:\n${output.join("")}`);
    const up = await fetch(`${base}/health-of-vercel-local`).then(
      () => true,
      () => false,
    );
    if (up) return { base, child, output };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`vercel-local did not answer:\n${output.join("")}`);
}

before(async () => {
  if (skip) return;
  const files = recipeFiles();
  rmSync(app, { recursive: true, force: true });
  write("package.json", '{ "type": "module" }\n');
  for (const [file, text] of files) write(file, text);
  // The recipe's orders module stops at the cookie; the order lookup is the
  // app's own, and this is the test app's.
  write(
    "lib/orders.js",
    `${files.get("lib/orders.js")}
import { pool } from "./db.js";

export async function findOrder(id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  return rows[0];
}
`,
  );
  // How this test app creates an order: the guest cookie from the recipe.
  write(
    "api/orders.js",
    `import { randomUUID } from "node:crypto";
import { pool } from "../lib/db.js";
import { visitorCookie } from "../lib/orders.js";

export async function POST() {
  const id = "${REFERENCE_PREFIX}" + randomUUID();
  const visitor = randomUUID();
  await pool.query(
    "INSERT INTO orders (id, visitor, title, amount, currency) VALUES ($1, $2, 'Widget', '2100', 'SAT')",
    [id, visitor],
  );
  return Response.json({ id }, { headers: { "set-cookie": visitorCookie(visitor) } });
}
`,
  );

  db = new pg.Pool({ connectionString: poolerUrl, max: 2 });
  await db.query(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, visitor TEXT NOT NULL, title TEXT NOT NULL, amount TEXT NOT NULL,
    currency TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'awaiting_payment', paid_at BIGINT)`);
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS swap_payment_hash TEXT");
  // One row per UPDATE statement on orders, even one that changes no row:
  // onPaid running twice would show as two.
  await db.query(
    `CREATE TABLE IF NOT EXISTS orders_update_statements (at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  await db.query(`CREATE OR REPLACE FUNCTION orders_count_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO orders_update_statements DEFAULT VALUES; RETURN NULL; END $$`);
  await db.query("DROP TRIGGER IF EXISTS orders_count_update ON orders");
  await db.query(
    "CREATE TRIGGER orders_count_update AFTER UPDATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION orders_count_update()",
  );

  // The recipe's table script, run twice: every deploy runs it.
  for (let run = 0; run < 2; run += 1) {
    const tables = spawnSync(process.execPath, [path.join(app, "scripts/openreceive-tables.mjs")], {
      env: { PATH: process.env.PATH, DATABASE_URL: poolerUrl },
      encoding: "utf8",
    });
    assert.equal(tables.status, 0, tables.stderr);
  }
  // Earlier local runs' attempts would count against the per-IP limit.
  await db.query("DELETE FROM openreceive_payments WHERE reference LIKE $1", [
    `${REFERENCE_PREFIX}%`,
  ]);
  await db.query("DELETE FROM orders WHERE id LIKE $1", [`${REFERENCE_PREFIX}%`]);

  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-vercel-functions-"));
  relay = await startTlsWallet(relayUrl, scratch);
  wallet = relay.wallet;
  instances.push(await startInstance(), await startInstance());
});

after(async () => {
  for (const instance of instances) instance.child.kill("SIGTERM");
  relay?.close();
  await db?.end();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  rmSync(app, { recursive: true, force: true });
});

async function placeOrder(instance = instances[0]) {
  const response = await fetch(`${instance.base}/api/orders`, { method: "POST" });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const cookie = response.headers.getSetCookie()[0].split(";")[0];
  return { id, cookie };
}

async function post(instance, route, body, cookie, headers = {}) {
  const response = await fetch(`${instance.base}/openreceive/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, body: json, text, type: response.headers.get("content-type") };
}

const log = () => instances.map((instance) => instance.output.join("")).join("\n---\n");

test("the recipe's check: a stranger gets OpenReceive's JSON 403", { skip }, async () => {
  const order = await placeOrder();
  const stranger = await post(instances[0], "checkouts/prepare", { reference: order.id });
  assert.equal(stranger.status, 403, `${stranger.text}\n${log()}`);
  assert.match(stranger.type ?? "", /application\/json/);
  assert.equal(stranger.body.code, "FORBIDDEN");

  const other = await placeOrder();
  const wrongBuyer = await post(instances[1], "checkouts", { reference: order.id }, other.cookie);
  assert.equal(wrongBuyer.status, 403);
  const visitor = order.cookie.split("=")[1].split(".")[0];
  const forged = await post(
    instances[1],
    "checkouts",
    { reference: order.id },
    `visitor=${visitor}.forged`,
  );
  assert.equal(forged.status, 403);
});

test("the rewrite reaches the handler: doctor's probe gets OpenReceive's JSON 404", {
  skip,
}, async () => {
  const response = await fetch(`${instances[0].base}/openreceive/__doctor-probe__`, {
    method: "POST",
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await response.json()).code, "NOT_FOUND");
});

test("a buyer gets a Lightning invoice, and the other instance resumes it", { skip }, async () => {
  const order = await placeOrder();
  const prepared = await post(
    instances[0],
    "checkouts/prepare",
    { reference: order.id },
    order.cookie,
  );
  assert.equal(prepared.status, 200, `${prepared.text}\n${log()}`);
  const created = await post(instances[0], "checkouts", { reference: order.id }, order.cookie);
  assert.equal(created.status, 201, `${created.text}\n${log()}`);
  assert.match(created.body.checkout.bolt11, /^lnbcrt2100000workers/);
  assert.equal(created.body.checkout.amount_msats, 2_100_000);
  const again = await post(instances[1], "checkouts", { reference: order.id }, order.cookie);
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.checkout.payment_hash, created.body.checkout.payment_hash);
});

test("an amount from the browser is refused", { skip }, async () => {
  const order = await placeOrder();
  const priced = await post(
    instances[0],
    "checkouts",
    { reference: order.id, amount: "1" },
    order.cookie,
  );
  assert.equal(priced.status, 400, priced.text);
});

test("concurrent creates on two instances leave one live attempt", { skip }, async () => {
  const order = await placeOrder();
  const results = await Promise.all(
    [0, 1, 0, 1, 0, 1].map((index) =>
      post(instances[index], "checkouts", { reference: order.id }, order.cookie),
    ),
  );
  const committed = results.filter((result) => result.status === 201);
  const refused = results.filter((result) => result.status === 409);
  assert.equal(committed.length + refused.length, results.length, JSON.stringify(results));
  assert.ok(committed.length >= 1, JSON.stringify(results));
  const hashes = new Set(committed.map((result) => result.body.checkout.payment_hash));
  assert.equal(hashes.size, 1);
  for (const result of refused) assert.equal(result.body.code, "CONFLICT");
  const { rows } = await db.query(
    "SELECT payment_hash FROM openreceive_payments WHERE reference = $1 AND status = 'pending'",
    [order.id],
  );
  assert.deepEqual(
    rows.map((row) => row.payment_hash),
    [...hashes],
  );
});

test("the recipe's order-swap function keeps a swap's hash for the order's own buyer", {
  skip,
}, async () => {
  const order = await placeOrder();
  const other = await placeOrder();
  const save = (cookie, body) =>
    fetch(`${instances[0].base}/api/order-swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }).then((response) => response.status);
  const hash = "ab".repeat(32);
  assert.equal(await save(undefined, { reference: order.id, payment_hash: hash }), 403);
  assert.equal(await save(other.cookie, { reference: order.id, payment_hash: hash }), 403);
  assert.equal(await save(order.cookie, { reference: order.id, payment_hash: "not-a-hash" }), 403);
  assert.equal(await save(order.cookie, { reference: order.id, payment_hash: hash }), 204);
  const { rows } = await db.query("SELECT swap_payment_hash FROM orders WHERE id = $1", [order.id]);
  assert.equal(rows[0].swap_payment_hash, hash);
});

test("a paid invoice runs onPaid exactly once, and the row keeps the connection's IP", {
  skip,
}, async () => {
  const order = await placeOrder();
  // A client's own x-forwarded-for: Vercel replaces it, so must vercel-local.
  const spoof = { "x-forwarded-for": "198.51.100.77" };
  const created = await post(
    instances[0],
    "checkouts",
    { reference: order.id },
    order.cookie,
    spoof,
  );
  assert.equal(created.status, 201, created.text);
  const paymentHash = created.body.checkout.payment_hash;
  await db.query("DELETE FROM orders_update_statements");
  wallet.settle(paymentHash);

  // The reconcile gate allows one wallet scan every few seconds; until the
  // next one, payments/check answers from the stored row.
  let check;
  let turn = 0;
  const deadline = Date.now() + 40_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check = await post(
      instances[turn++ % 2],
      "payments/check",
      { reference: order.id, payment_hash: paymentHash },
      order.cookie,
      spoof,
    );
    assert.equal(check.status, 200, check.text);
  } while (check.body.status !== "settled" && Date.now() < deadline);
  assert.equal(check.body.status, "settled", log());

  // Both instances see it settled; neither fulfills it again.
  for (const instance of [...instances, ...instances]) {
    const later = await post(
      instance,
      "payments/check",
      { reference: order.id, payment_hash: paymentHash },
      order.cookie,
    );
    assert.equal(later.body.status, "settled");
  }
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  await post(
    instances[1],
    "payments/check",
    { reference: order.id, payment_hash: paymentHash },
    order.cookie,
  );

  const { rows: orderRows } = await db.query("SELECT state, paid_at FROM orders WHERE id = $1", [
    order.id,
  ]);
  assert.equal(orderRows[0].state, "paid");
  assert.ok(Number(orderRows[0].paid_at) > 0);
  const { rows: statements } = await db.query(
    "SELECT count(*)::int AS n FROM orders_update_statements",
  );
  assert.equal(statements[0].n, 1, "onPaid ran more than once");
  const { rows: attempts } = await db.query(
    "SELECT status, client_ip FROM openreceive_payments WHERE payment_hash = $1",
    [paymentHash],
  );
  assert.equal(attempts[0].status, "settled");
  assert.equal(attempts[0].client_ip, "127.0.0.1");
});
