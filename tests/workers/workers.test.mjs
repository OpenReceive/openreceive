import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { startFakeWallet } from "./fake-wallet.mjs";

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
let wallet;
let worker;
let tlsFront;
let scratch;
let base;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A CA and a localhost certificate it signed, made fresh with openssl. */
function makeCertificates(directory) {
  const file = (name) => path.join(directory, name);
  const openssl = (...args) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(
    "req",
    "-x509",
    ...ec,
    "-days",
    "1",
    "-subj",
    "/CN=OpenReceive workers test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
  );
  openssl(
    "req",
    ...ec,
    "-subj",
    "/CN=localhost",
    "-keyout",
    file("relay.key"),
    "-out",
    file("relay.csr"),
  );
  writeFileSync(
    file("relay.ext"),
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    file("relay.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    file("relay.ext"),
    "-out",
    file("relay.pem"),
  );
  return {
    ca: file("ca.pem"),
    key: readFileSync(file("relay.key")),
    cert: readFileSync(file("relay.pem")),
  };
}

/** wss:// in front of the plain relay: TLS ends here, bytes pass through. */
async function startTlsFront({ key, cert }, upstream) {
  const server = tls.createServer({ key, cert }, (socket) => {
    const relay = net.connect(Number(upstream.port), upstream.hostname);
    socket.pipe(relay).pipe(socket);
    socket.on("error", () => relay.destroy());
    relay.on("error", () => socket.destroy());
  });
  return { server, port: await listen(server) };
}

async function waitForWorker(output) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited:\n${output.join("")}`);
    const up = await fetch(base).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not answer within 90 s:\n${output.join("")}`);
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-workers-"));
  const certificates = makeCertificates(scratch);
  tlsFront = await startTlsFront(certificates, new URL(relayUrl));
  wallet = await startFakeWallet(relayUrl, {
    advertisedRelayUrl: `wss://localhost:${tlsFront.port}`,
  });
  // Values go through an env file: `--var KEY:VALUE` would split a URL's colons.
  const varsFile = path.join(scratch, "worker.env");
  writeFileSync(varsFile, `NWC_URI=${wallet.nwcUri}\nDATABASE_URL=${poolerUrl}\n`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const output = [];
  worker = spawn(
    path.join(workerDir, "..", "node_modules", ".bin", "wrangler"),
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--env-file", varsFile],
    {
      cwd: workerDir,
      env: {
        ...process.env,
        // wrangler hands this CA to workerd, which verifies relay certificates.
        NODE_EXTRA_CA_CERTS: certificates.ca,
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
    },
  );
  worker.stdout.on("data", (chunk) => output.push(String(chunk)));
  worker.stderr.on("data", (chunk) => output.push(String(chunk)));
  await waitForWorker(output);
  const setup = await fetch(`${base}/setup`, { method: "POST" });
  assert.equal(setup.status, 204, output.join(""));
});

after(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await exited;
  }
  wallet?.close();
  tlsFront?.server.close();
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
