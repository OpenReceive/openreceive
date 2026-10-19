import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort, startTlsWallet } from "../workers/harness.mjs";

// The Vendure plugin against a real Vendure 3 server on PostgreSQL. server.mjs
// runs as its own process with the built @openreceive/vendure, reaching a
// receive-only wallet on a local relay through a TLS front (OpenReceive
// accepts wss relays only). The test pays as a guest through the Shop API and
// the plugin's routes, with the guest's bearer token.
//
//   docker compose -f tests/workers/compose.yml up -d --wait
//   npm ci --prefix tests/vendure && npm run build:packages
//   OPENRECEIVE_TEST_VENDURE_POSTGRES_URL=postgresql://openreceive:openreceive@127.0.0.1:5432/openreceive_vendure \
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:57777 \
//     npm run test:vendure

const postgresUrl = process.env.OPENRECEIVE_TEST_VENDURE_POSTGRES_URL;
const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const skip =
  (!postgresUrl || !relayUrl) &&
  "Set OPENRECEIVE_TEST_VENDURE_POSTGRES_URL and OPENRECEIVE_TEST_RELAY_URL (see tests/vendure/vendure.test.mjs)";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "../../packages/js/vendure");
let relay;
let server;
let scratch;
let base;
const output = [];

/** The built plugin, where server.mjs resolves it beside this lane's Vendure. */
function installPlugin() {
  const target = path.join(here, "node_modules", "@openreceive", "vendure");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(path.join(pluginDir, "package.json"), path.join(target, "package.json"));
  cpSync(path.join(pluginDir, "dist"), path.join(target, "dist"), { recursive: true });
}

/** A fresh public schema, so every run seeds and migrates from nothing. */
async function resetDatabase() {
  const { Client } = createRequire(path.join(here, "package.json"))("pg");
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  await client.end();
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(here, "server.mjs")], {
    cwd: here,
    env: { ...process.env, ...env, PORT: String(port), VENDURE_DISABLE_TELEMETRY: "true" },
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 180_000;
  while (!output.join("").includes("vendure test server ready")) {
    if (child.exitCode !== null) throw new Error(`server.mjs exited:\n${output.join("")}`);
    if (Date.now() > deadline) throw new Error(`server.mjs did not start:\n${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { child, base: `http://127.0.0.1:${port}` };
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-vendure-"));
  installPlugin();
  await resetDatabase();
  relay = await startTlsWallet(relayUrl, scratch);
  ({ child: server, base } = await startServer({
    NWC_URI: relay.wallet.nwcUri,
    NODE_EXTRA_CA_CERTS: relay.ca,
  }));
  const enable = spawnSync(
    process.execPath,
    [path.join(pluginDir, "dist", "enable-openreceive.js"), "--admin-api", `${base}/admin-api`],
    {
      cwd: scratch,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPERADMIN_USERNAME: "superadmin",
        SUPERADMIN_PASSWORD: "superadmin-test",
      },
    },
  );
  assert.equal(enable.status, 0, `${enable.stdout}${enable.stderr}`);
  assert.match(enable.stdout, /created payment method "Bitcoin Lightning" \(openreceive\)/);
});

after(async () => {
  if (server !== undefined && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  relay?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A guest of the shop: a Vendure session that holds its bearer token. */
class Guest {
  token = undefined;

  async gql(query, variables = {}) {
    const response = await fetch(`${base}/shop-api`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    this.token = response.headers.get("vendure-auth-token") ?? this.token;
    return response.json();
  }

  async route(route, body) {
    const response = await fetch(`${base}/openreceive${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  /** A cart of one product, at the payment step. */
  async cart(slug) {
    const { data } = await this.gql(
      "query ($slug: String!) { product(slug: $slug) { variants { id } } }",
      { slug },
    );
    const added = await this.gql(
      "mutation ($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { code } } }",
      { id: data.product.variants[0].id },
    );
    await this.gql(
      "mutation ($input: CreateCustomerInput!) { setCustomerForOrder(input: $input) { __typename } }",
      {
        input: {
          emailAddress: `guest-${Date.now()}-${Math.random()}@shop.test`,
          firstName: "G",
          lastName: "B",
        },
      },
    );
    await this.gql(
      "mutation ($input: CreateAddressInput!) { setOrderShippingAddress(input: $input) { __typename } }",
      {
        input: {
          streetLine1: "1 Main Street",
          city: "Springfield",
          postalCode: "62701",
          countryCode: "US",
        },
      },
    );
    const methods = await this.gql("query { eligibleShippingMethods { id } }");
    await this.gql(
      "mutation ($ids: [ID!]!) { setOrderShippingMethod(shippingMethodId: $ids) { __typename } }",
      {
        ids: [methods.data.eligibleShippingMethods[0].id],
      },
    );
    return added.data.addItemToOrder.code;
  }

  /** The order as Vendure lets its guest see it once placed; undefined before. */
  async placed(code) {
    const { data } = await this.gql(
      "query ($code: String!) { orderByCode(code: $code) { state payments { method state amount transactionId } } }",
      { code },
    );
    return data?.orderByCode ?? undefined;
  }
}

async function until(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

test("a guest pays an order: the plugin adds a settled payment and Vendure places it", {
  skip,
}, async () => {
  const guest = new Guest();
  const code = await guest.cart("bezel");
  const started = await guest.route("/order", {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body, {
    reference: `${code}:USD:1200`,
    order_code: code,
    amount: "12.00",
    currency: "USD",
  });
  const { reference } = started.body;
  const created = await guest.route("/checkouts", { reference });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hash = created.body.checkout.payment_hash;
  const again = await guest.route("/checkouts", { reference });
  assert.equal(again.body.checkout.payment_hash, hash, "a second ask resumes the same invoice");

  relay.wallet.settle(hash);
  const settled = await until(async () => {
    const check = await guest.route("/payments/check", { reference, payment_hash: hash });
    return check.body.status === "settled" ? check : undefined;
  }, 60_000);
  assert.ok(settled, "the checkout's poll saw the payment settle");
  const order = await guest.placed(code);
  assert.equal(order?.state, "PaymentSettled", output.join("").slice(-2000));
  assert.deepEqual(order.payments, [
    { method: "openreceive", state: "Settled", amount: 1200, transactionId: hash },
  ]);
});

test("only the guest's session may pay its order, at the order's own price", { skip }, async () => {
  const guest = new Guest();
  const code = await guest.cart("facet");
  const { body } = await guest.route("/order", {});
  assert.equal(body.reference, `${code}:USD:700`);
  const stranger = new Guest();
  await stranger.cart("bezel");
  assert.equal((await stranger.route("/checkouts", { reference: body.reference })).status, 403);
  assert.equal((await new Guest().route("/checkouts", { reference: body.reference })).status, 403);
  assert.equal((await guest.route("/checkouts", { reference: `${code}:USD:100` })).status, 404);
  assert.equal((await new Guest().route("/order", {})).status, 404, "no session, no active order");
  const sneaky = await guest.gql(
    'mutation { addPaymentToOrder(input: { method: "openreceive", metadata: {} }) { __typename } }',
  );
  assert.match(JSON.stringify(sneaky.errors ?? []), /adds its payments to orders itself/);
  assert.equal(await guest.placed(code), undefined, "the order is still unpaid");
});

test("a payment whose buyer left is placed by the scheduled task", { skip }, async () => {
  const guest = new Guest();
  const code = await guest.cart("bezel");
  const { body } = await guest.route("/order", {});
  const created = await guest.route("/checkouts", { reference: body.reference });
  const hash = created.body.checkout.payment_hash;
  // The guest closes the page: nothing asks the routes about this payment again.
  relay.wallet.settle(hash);
  const order = await until(() => guest.placed(code).catch(() => undefined), 150_000);
  assert.equal(order?.state, "PaymentSettled", output.join("").slice(-2000));
  assert.equal(order.payments[0].transactionId, hash);
});
