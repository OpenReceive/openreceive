import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { freshDatabase, SECRET_KEY, skip as databaseSkip, sql, startGateway } from "./harness.mjs";

// The Supabase repository inside workerd, which is why it exists: a Worker
// cannot open a Postgres connection to Supabase, so this one reaches
// PostgREST over HTTP through the gateway stand-in. worker/src/index.js runs
// one order's life per request. Needs wrangler and built packages:
//
//   npm ci --prefix tests/workers && npm run build:packages

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker");
const wrangler = path.join(workerDir, "..", "..", "workers", "node_modules", ".bin", "wrangler");
const skip =
  databaseSkip ||
  (!existsSync(wrangler) && "Run npm ci --prefix tests/workers to install wrangler");

let gateway;
let worker;
let scratch;
let base;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  if (skip) return;
  gateway = await startGateway();
  await freshDatabase();
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-supabase-worker-"));
  const varsFile = path.join(scratch, "worker.env");
  writeFileSync(varsFile, `SUPABASE_URL=${gateway.url}\nSUPABASE_KEY=${SECRET_KEY}\n`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const output = [];
  worker = spawn(
    wrangler,
    ["dev", "--ip", "127.0.0.1", "--port", String(port), "--env-file", varsFile],
    { cwd: workerDir, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  worker.stdout.on("data", (chunk) => output.push(String(chunk)));
  worker.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited:\n${output.join("")}`);
    if (
      await fetch(base).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    if (Date.now() > deadline) throw new Error(`wrangler dev never answered:\n${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

after(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await exited;
  }
  await gateway?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function runOrder(reference, lightning, swap, now) {
  await sql("insert into shop_orders (id) values ($1)", [reference]);
  const seen = gateway.requests.length;
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference, lightning, swap, now }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { body, sent: gateway.requests.slice(seen) };
}

test("a Worker commits, settles and fulfills once over Supabase's HTTPS API", {
  skip,
}, async () => {
  const first = await runOrder("worker-1", "a".repeat(64), "b".repeat(64), 1_000);
  assert.deepEqual(first.body, {
    claimed: true,
    released: true,
    first: true,
    second: false,
    fromIp: 2,
    rows: [
      ["b".repeat(64), "settled", "duplicate_settlement"],
      ["a".repeat(64), "settled", null],
    ].sort((left, right) => (left[0] < right[0] ? 1 : -1)),
  });
  assert.ok(first.sent.some((request) => request.url.includes("openreceive_supabase_status")));
  for (const request of first.sent) {
    assert.equal(request.headers.apikey, SECRET_KEY);
    assert.equal(request.headers.authorization, undefined);
  }
  assert.equal(
    (await sql("select state from shop_orders where id = 'worker-1'")).rows[0].state,
    "paid",
  );
  assert.equal(
    (await sql("select count(*)::int as n from shop_fulfillments where reference = 'worker-1'"))
      .rows[0].n,
    1,
  );

  // The next request builds a new repository but reuses the passed check.
  const second = await runOrder("worker-2", "c".repeat(64), "d".repeat(64), 1_010);
  assert.equal(second.body.first, true);
  assert.ok(
    !second.sent.some((request) => request.url.includes("openreceive_supabase_status")),
    "the storage check is reused within the isolate",
  );
});
