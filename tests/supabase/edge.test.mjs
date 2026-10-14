import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { freePort, startTlsWallet } from "../workers/harness.mjs";
import {
  databaseUrl,
  freshDatabase,
  reloadSchema,
  SECRET_KEY,
  skip as databaseSkip,
  sql,
  startGateway,
} from "./harness.mjs";

// Supabase Edge Functions, which Bolt's apps use, run on Deno inside
// Supabase's edge-runtime. This lane bundles this tree's @openreceive/http
// into two functions and runs them in that runtime, under the hosted limits:
// one on Supabase's HTTPS API (the Lovable shape), one on Postgres through
// SUPABASE_DB_URL with `pg` (Bolt's default). The wallet sits on the local
// relay behind TLS, as in lovable.test.mjs. Needs Docker, this lane's stack,
// the relay from tests/workers/compose.yml, and the image to run:
//
//   OPENRECEIVE_TEST_EDGE_RUNTIME=supabase/edge-runtime:v1.77.4

const image = process.env.OPENRECEIVE_TEST_EDGE_RUNTIME;
const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const edgeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "edge");
const dockerOk = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
const skip =
  databaseSkip ||
  (!image && "Set OPENRECEIVE_TEST_EDGE_RUNTIME to the edge-runtime image") ||
  (!relayUrl && "Set OPENRECEIVE_TEST_RELAY_URL (see tests/workers/workers.test.mjs)") ||
  (!dockerOk && "Docker is not available");

const container = `openreceive-edge-test-${process.pid}`;
let gateway;
let relay;
let scratch;
let base;

/**
 * One function directory for edge-runtime: the source bundled with this
 * tree's packages and their dependencies, so nothing is fetched at run time.
 * Node built-ins stay imports, which Deno serves, a CommonJS dependency's
 * require() goes through createRequire, and the Node globals that Deno gives
 * only to `npm:` imports (Buffer, process, global, setImmediate) are imported.
 */
async function bundle(name, functions) {
  await build({
    entryPoints: [path.join(edgeDir, "functions", `${name}.js`)],
    outfile: path.join(functions, name, "index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["pg-native"],
    banner: {
      js: [
        'import { createRequire } from "node:module";',
        'import { Buffer } from "node:buffer";',
        'import process from "node:process";',
        'import { setImmediate, clearImmediate } from "node:timers";',
        "const require = createRequire(import.meta.url);",
        "const global = globalThis;",
      ].join(" "),
    },
    logLevel: "silent",
  });
}

function logs() {
  return execFileSync("docker", ["logs", container], { encoding: "utf8", stdio: "pipe" });
}

before(async () => {
  if (skip) return;
  gateway = await startGateway();
  await freshDatabase();
  await sql(
    "alter table shop_orders add column amount text not null default '2100', add column buyer_token text",
  );
  await reloadSchema();
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-edge-"));
  relay = await startTlsWallet(relayUrl, scratch);

  const functions = path.join(scratch, "functions");
  mkdirSync(functions);
  cpSync(path.join(edgeDir, "main"), path.join(functions, "main"), { recursive: true });
  cpSync(path.join(edgeDir, "events"), path.join(functions, "events"), { recursive: true });
  await bundle("https", functions);
  await bundle("postgres", functions);
  // Deno reads the system store; this one adds the relay's private CA.
  const bundleFile = path.join(scratch, "ca-certificates.crt");
  writeFileSync(bundleFile, `${rootCertificates.join("\n")}\n${readFileSync(relay.ca, "utf8")}`);
  const envFile = path.join(scratch, "edge.env");
  writeFileSync(
    envFile,
    [
      `NWC_URI=${relay.wallet.nwcUri}`,
      `SUPABASE_URL=${gateway.url}`,
      `SUPABASE_SERVICE_ROLE_KEY=${SECRET_KEY}`,
      `SUPABASE_DB_URL=${databaseUrl}`,
      "DENO_TLS_CA_STORE=system",
      "",
    ].join("\n"),
  );

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    container,
    "--network",
    "host",
    "--env-file",
    envFile,
    "-v",
    `${bundleFile}:/etc/ssl/certs/ca-certificates.crt:ro`,
    "-v",
    `${functions}:/home/deno/functions:ro`,
    image,
    "start",
    "--main-service",
    "/home/deno/functions/main",
    "--event-worker",
    "/home/deno/functions/events",
    "--port",
    String(port),
  ]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(`${base}/`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) throw new Error(`edge-runtime did not answer:\n${logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

after(async () => {
  if (!skip) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  relay?.close();
  await gateway?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function placeOrder() {
  const order = { id: randomUUID(), buyer: randomUUID() };
  await sql("insert into shop_orders (id, buyer_token) values ($1, $2)", [order.id, order.buyer]);
  return order;
}

async function post(fn, route, body, buyer) {
  const response = await fetch(`${base}/${fn}/openreceive/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
      ...(buyer === undefined ? {} : { cookie: `buyer=${buyer}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** Pay the invoice on the wallet, then poll as the checkout does until it settles. */
async function payAndWait(fn, order, paymentHash) {
  relay.wallet.settle(paymentHash);
  let check;
  const deadline = Date.now() + 30_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    check = await post(
      fn,
      "payments/check",
      { reference: order.id, payment_hash: paymentHash },
      order.buyer,
    );
    assert.equal(check.status, 200, JSON.stringify(check.body));
  } while (check.body.status !== "settled" && Date.now() < deadline);
  assert.equal(check.body.status, "settled");
  const state = await sql("select state from shop_orders where id = $1", [order.id]);
  assert.equal(state.rows[0].state, "paid");
}

for (const fn of ["https", "postgres"]) {
  test(`an Edge Function on ${fn === "https" ? "Supabase's HTTPS API" : "Postgres"} issues the buyer's invoice and refuses a stranger`, {
    skip,
  }, async () => {
    const order = await placeOrder();
    const own = await post(fn, "checkouts", { reference: order.id }, order.buyer);
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.match(own.body.checkout.bolt11, /^lnbcrt2100000workers/);
    const stranger = await post(fn, "checkouts", { reference: order.id }, randomUUID());
    assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  });

  test(`an Edge Function on ${fn === "https" ? "Supabase's HTTPS API" : "Postgres"} marks a paid order paid`, {
    skip,
  }, async () => {
    const order = await placeOrder();
    const created = await post(fn, "checkouts", { reference: order.id }, order.buyer);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await payAndWait(fn, order, created.body.checkout.payment_hash);
  });
}

test("no Edge Function worker ran into the hosted CPU limit", { skip }, () => {
  const stopped = logs()
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.event_type === "Shutdown" && event.event.reason === "CPUTime");
  assert.deepEqual(stopped, []);
});
