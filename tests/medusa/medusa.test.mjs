import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { freePort, startTlsWallet } from "../workers/harness.mjs";

// @openreceive/medusa in a real Medusa 2: the Medusa trial's Widget Shop
// server (trials/platforms/medusa/fixture/medusa, Medusa 2.21.2), with the
// plugin and the packages it needs packed from this tree, on PostgreSQL, and
// a receive-only wallet on a local relay. The store API makes the carts, as a
// storefront does.
//
//   docker compose -f tests/medusa/compose.yml up -d --wait
//   npm ci && npm run build:packages
//   OPENRECEIVE_TEST_MEDUSA_DB_URL=postgres://medusa:medusa@127.0.0.1:19154/medusa \
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:19177 \
//     npm run test:medusa

const databaseUrl = process.env.OPENRECEIVE_TEST_MEDUSA_DB_URL;
const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const skip =
  (!databaseUrl || !relayUrl) &&
  "Set OPENRECEIVE_TEST_MEDUSA_DB_URL and OPENRECEIVE_TEST_RELAY_URL (see tests/medusa/medusa.test.mjs)";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(repoRoot, "trials/platforms/medusa/fixture/medusa");
const PROVIDER = "pp_openreceive_openreceive";
const ADMIN = { email: "admin@example.test", password: "widget-shop-local" };
// The storefront's key, which the fixture's seed gives the store.
const publishableKey = readFileSync(path.join(fixture, "src/scripts/seed.ts"), "utf8").match(
  /PUBLISHABLE_KEY =\s*"(pk_[0-9a-f]+)"/,
)?.[1];

// The quickstart's medusa-config: the plugin and its payment provider, next
// to the fixture's own settings.
const MEDUSA_CONFIG = `import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  admin: { disable: true },
  plugins: [{ resolve: "@openreceive/medusa", options: {} }],
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [{ resolve: "@openreceive/medusa/providers/openreceive", id: "openreceive" }],
      },
    },
  ],
})
`;

let scratch;
let app;
let env;
let relay;
let wallet;
let medusa;
let base;
let db;
const output = [];

/** A command in the Medusa app; on failure, its output's tail. */
async function run(command, args, options = {}) {
  try {
    await execFileAsync(command, args, {
      cwd: app,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60_000,
      ...options,
    });
  } catch (error) {
    const tail = `${error.stdout ?? ""}${error.stderr ?? ""}`.split("\n").slice(-40).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed:\n${tail}`);
  }
}

async function waitForMedusa() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (medusa.exitCode !== null) throw new Error(`medusa start exited:\n${output.join("")}`);
    const up = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Medusa did not answer within 120 s:\n${output.join("")}`);
}

before(
  async () => {
    if (skip) return;
    assert.ok(publishableKey, "the fixture's seed names the storefront's publishable key");
    scratch = mkdtempSync(path.join(tmpdir(), "openreceive-medusa-"));
    app = path.join(scratch, "medusa");
    cpSync(fixture, app, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("node_modules"),
    });
    writeFileSync(path.join(app, "medusa-config.ts"), MEDUSA_CONFIG);

    relay = await startTlsWallet(relayUrl, scratch);
    wallet = relay.wallet;
    const url = new URL(databaseUrl);
    url.searchParams.set("sslmode", "disable");
    env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      NWC_URI: wallet.nwcUri,
      NODE_EXTRA_CA_CERTS: relay.ca,
      STORE_CORS: "http://localhost:8000",
      ADMIN_CORS: "http://localhost:9000",
      AUTH_CORS: "http://localhost:9000",
      JWT_SECRET: "medusa-test-jwt",
      COOKIE_SECRET: "medusa-test-cookie",
      MEDUSA_DISABLE_TELEMETRY: "true",
    };

    // A fresh store on every run.
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");

    const packs = path.join(scratch, "packs");
    mkdirSync(packs);
    await run(
      "npm",
      [
        "pack",
        "--silent",
        "--ignore-scripts",
        "--pack-destination",
        packs,
        ...["core", "node", "http", "medusa"].flatMap((name) => ["-w", `@openreceive/${name}`]),
      ],
      { cwd: repoRoot },
    );
    await run("npm", ["ci", "--no-audit", "--no-fund"]);
    await run("npm", [
      "install",
      "--no-audit",
      "--no-fund",
      ...readdirSync(packs).map((file) => path.join(packs, file)),
    ]);
    await run("npx", ["medusa", "db:migrate"]);
    await run("npx", ["medusa", "exec", "./src/scripts/seed.ts"]);
    await run("npx", [
      "medusa",
      "exec",
      "./node_modules/@openreceive/medusa/dist/enable-openreceive.js",
    ]);
    await run("npx", ["medusa", "user", "-e", ADMIN.email, "-p", ADMIN.password]);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // Medusa's own bin, not npx: the signal below reaches the server itself.
    medusa = spawn(path.join(app, "node_modules/.bin/medusa"), ["start", "--port", String(port)], {
      cwd: app,
      env,
    });
    medusa.stdout.on("data", (chunk) => output.push(String(chunk)));
    medusa.stderr.on("data", (chunk) => output.push(String(chunk)));
    await waitForMedusa();
  },
  { timeout: 20 * 60_000 },
);

after(async () => {
  if (medusa !== undefined && medusa.exitCode === null) {
    const exited = new Promise((resolve) => medusa.once("exit", resolve));
    medusa.kill("SIGTERM");
    // A graceful shutdown waits for idle keep-alive connections; do not wait long.
    const killer = setTimeout(() => medusa.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killer);
  }
  await db?.end();
  relay?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function store(route, { method = "GET", body, key = publishableKey, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { "x-publishable-api-key": key }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function must(result, label) {
  assert.ok(result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

/** A cart with one product, an address and the free shipping, and a payment session with `provider`. */
async function openCart(handle, provider = PROVIDER) {
  const { regions } = must(await store("/store/regions"), "regions");
  const region = regions[0];
  const { products } = must(
    await store(`/store/products?handle=${handle}&region_id=${region.id}`),
    "products",
  );
  const { cart } = must(
    await store("/store/carts", { method: "POST", body: { region_id: region.id } }),
    "cart",
  );
  must(
    await store(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      body: { variant_id: products[0].variants[0].id, quantity: 1 },
    }),
    "line item",
  );
  const address = {
    first_name: "Widget",
    last_name: "Buyer",
    address_1: "1 Main Street",
    city: "Portland",
    province: "OR",
    postal_code: "97201",
    country_code: "us",
  };
  must(
    await store(`/store/carts/${cart.id}`, {
      method: "POST",
      body: { email: "buyer@example.test", shipping_address: address, billing_address: address },
    }),
    "addresses",
  );
  const { shipping_options: options } = must(
    await store(`/store/shipping-options?cart_id=${cart.id}`),
    "shipping options",
  );
  must(
    await store(`/store/carts/${cart.id}/shipping-methods`, {
      method: "POST",
      body: { option_id: options[0].id },
    }),
    "shipping method",
  );
  const { payment_collection: collection } = must(
    await store("/store/payment-collections", { method: "POST", body: { cart_id: cart.id } }),
    "payment collection",
  );
  const { payment_collection: withSession } = must(
    await store(`/store/payment-collections/${collection.id}/payment-sessions`, {
      method: "POST",
      body: { provider_id: provider },
    }),
    "payment session",
  );
  const session = withSession.payment_sessions.find((item) => item.provider_id === provider);
  return { cartId: cart.id, sessionId: session.id };
}

function openreceive(route, body, options) {
  return store(`/store/openreceive/${route}`, { method: "POST", body, ...options });
}

async function settledCheck(reference, paymentHash) {
  const deadline = Date.now() + 60_000;
  let last;
  while (Date.now() < deadline) {
    last = await openreceive("payments/check", { reference, payment_hash: paymentHash });
    if (last.status === 200 && last.body.status === "settled") return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert.fail(`never settled: ${JSON.stringify(last)}`);
}

/** The order Medusa placed for a cart, with the payment's capture and data, or none yet. */
async function placedOrder(cartId, sessionId) {
  const { rows } = await db.query(
    `SELECT oc.order_id, p.captured_at, p.data
       FROM order_cart oc
       JOIN payment p ON p.payment_session_id = $2
      WHERE oc.cart_id = $1 AND oc.deleted_at IS NULL`,
    [cartId, sessionId],
  );
  return rows[0];
}

async function waitForOrder(cartId, sessionId, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const order = await placedOrder(cartId, sessionId);
    if (order !== undefined) return order;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return undefined;
}

let paid;

test("a payment session gets a Lightning invoice for the cart, and asking again returns it", {
  skip,
}, async () => {
  const cart = await openCart("facet");
  const first = await openreceive("checkouts", { reference: cart.sessionId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const checkout = first.body.checkout;
  assert.match(checkout.payment_hash, /^[0-9a-f]{64}$/);
  assert.match(checkout.bolt11, /^ln/);
  assert.equal(checkout.reference, cart.sessionId);
  // The Facet is $7, in the session's own currency.
  assert.deepEqual(checkout.fiat_quote.fiat, { currency: "USD", value: "7.00" });
  const again = await openreceive("checkouts", { reference: cart.sessionId });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.checkout.payment_hash, checkout.payment_hash);
  paid = { ...cart, paymentHash: checkout.payment_hash };
});

test("the routes refuse an unknown session, another provider's session and a call without the publishable key", {
  skip,
}, async () => {
  const unknown = await openreceive("checkouts", {
    reference: "payses_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  });
  assert.equal(unknown.status, 403, JSON.stringify(unknown.body));
  const manual = await openCart("hinge", "pp_system_default");
  const theirs = await openreceive("checkouts", { reference: manual.sessionId });
  assert.equal(theirs.status, 403, JSON.stringify(theirs.body));
  const keyless = await openreceive("checkouts", { reference: paid.sessionId }, { key: null });
  assert.equal(keyless.status, 400, JSON.stringify(keyless.body));
});

test("Medusa will not place the order before the invoice is paid", { skip }, async () => {
  const early = await store(`/store/carts/${paid.cartId}/complete`, { method: "POST" });
  assert.notEqual(early.body.type, "order", JSON.stringify(early.body));
  assert.equal(await placedOrder(paid.cartId, paid.sessionId), undefined);
});

test("once the wallet settles the invoice, the order is placed with its payment captured", {
  skip,
}, async () => {
  wallet.settle(paid.paymentHash);
  await settledCheck(paid.sessionId, paid.paymentHash);
  // The plugin hands the session to Medusa's process-payment workflow once the settlement commits.
  const order = await waitForOrder(paid.cartId, paid.sessionId, 30);
  assert.ok(order, `no order for cart ${paid.cartId}:\n${output.slice(-20).join("")}`);
  assert.ok(order.captured_at, "the payment is captured");
  assert.equal(order.data.payment_hash, paid.paymentHash);
});

test("a storefront that completes the cart once the checkout reports the payment gets the order", {
  skip,
}, async () => {
  const cart = await openCart("latch");
  const created = await openreceive("checkouts", { reference: cart.sessionId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  wallet.settle(created.body.checkout.payment_hash);
  await settledCheck(cart.sessionId, created.body.checkout.payment_hash);
  const completed = await store(`/store/carts/${cart.cartId}/complete`, { method: "POST" });
  assert.equal(completed.body.type, "order", JSON.stringify(completed.body));
  const order = await placedOrder(cart.cartId, cart.sessionId);
  assert.equal(order?.order_id, completed.body.order.id);
  assert.ok(order.captured_at, "the payment is captured");
});

test("an admin refund is recorded, and the plugin says to send it from the merchant's wallet", {
  skip,
}, async () => {
  const signedIn = must(
    await store("/auth/user/emailpass", { method: "POST", body: ADMIN, key: null }),
    "admin sign-in",
  );
  const { rows } = await db.query("SELECT id FROM payment WHERE payment_session_id = $1", [
    paid.sessionId,
  ]);
  const refunded = must(
    await store(`/admin/payments/${rows[0].id}/refund`, {
      method: "POST",
      body: { amount: 2 },
      key: null,
      headers: { authorization: `Bearer ${signedIn.token}` },
    }),
    "refund",
  );
  assert.equal(refunded.payment.refunds.length, 1);
  assert.match(output.join(""), /send it from your own wallet/);
});

// Last: no other request may run a reconcile pass meanwhile, so only the
// plugin's job, which runs every minute, can find this payment.
test("a payment whose buyer left is placed by the plugin's job", {
  skip,
  timeout: 150_000,
}, async () => {
  const cart = await openCart("knob");
  const created = await openreceive("checkouts", { reference: cart.sessionId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  wallet.settle(created.body.checkout.payment_hash);
  const order = await waitForOrder(cart.cartId, cart.sessionId, 130);
  assert.ok(
    order,
    `the job placed no order for cart ${cart.cartId}:\n${output.slice(-20).join("")}`,
  );
  assert.ok(order.captured_at, "the payment is captured");
});
