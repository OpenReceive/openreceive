import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCli } from "../packages/js/node/src/cli.ts";
import { paymentsSchemaSql } from "../packages/js/http/src/sql-payments.ts";

const VALID_NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;

function receiveOnlyWallet() {
  return {
    preflight: async () => ({
      methods: ["make_invoice", "list_transactions"],
      spendCapabilityAdvertised: false,
      warnings: [],
    }),
    close: async () => {},
  };
}

async function doctor({ argv = [], env = {}, walletClientFactory, cwd = process.cwd() } = {}) {
  const out = [];
  const err = [];
  const code = await runCli({
    argv: ["doctor", ...argv],
    env,
    cwd,
    stdout: { write: (message) => out.push(message) },
    stderr: { write: (message) => err.push(message) },
    walletClientFactory,
  });
  return { code, out: out.join(""), err: err.join("") };
}

test("doctor --offline passes on a valid NWC_URI and skips the probe", async () => {
  const { code, out } = await doctor({ argv: ["--offline"], env: { NWC_URI: VALID_NWC } });
  assert.equal(code, 0);
  assert.match(out, /NWC_URI: present-redacted/);
  assert.match(out, /wallet: probe skipped \(--offline\)/);
  assert.match(out, /database: skipped/);
  assert.match(out, /routes: skipped/);
});

test("doctor probes the wallet and reports receive-only", async () => {
  const { code, out } = await doctor({
    env: { NWC_URI: VALID_NWC },
    walletClientFactory: receiveOnlyWallet,
  });
  assert.equal(code, 0);
  assert.match(out, /wallet: reachable, receive-only \(make_invoice, list_transactions\)/);
});

test("doctor fails when preflight refuses the wallet", async () => {
  const { code, out } = await doctor({
    env: { NWC_URI: VALID_NWC },
    walletClientFactory: () => ({
      preflight: async () => {
        throw new Error("This NWC connection is NOT receive-only.");
      },
      close: async () => {},
    }),
  });
  assert.equal(code, 1);
  assert.match(out, /wallet: This NWC connection is NOT receive-only\./);
});

test("doctor flags a spend-capable wallet reachable through the override", async () => {
  let sawOverride;
  const { code, out } = await doctor({
    env: { NWC_URI: VALID_NWC, OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC: "true" },
    walletClientFactory: (options) => {
      sawOverride = options.allowSpendCapableWallet;
      return {
        preflight: async () => ({
          methods: ["make_invoice", "pay_invoice"],
          spendCapabilityAdvertised: true,
          warnings: [],
        }),
        close: async () => {},
      };
    },
  });
  assert.equal(sawOverride, true);
  assert.equal(code, 1);
  assert.match(out, /wallet: reachable but SPEND-CAPABLE \(override active\)/);
  assert.match(out, /get_a_nwc_code_to_receive_payments/);
});

test("doctor --db reports migrated tables and missing ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-"));
  try {
    const migrated = path.join(dir, "migrated.sqlite");
    const database = new DatabaseSync(migrated);
    database.exec(paymentsSchemaSql("sqlite"));
    database.close();
    const good = await doctor({
      argv: ["--offline", "--db", migrated],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(good.code, 0);
    assert.match(good.out, /database: openreceive_payments and openreceive_meta present/);

    const empty = path.join(dir, "empty.sqlite");
    await writeFile(empty, "");
    const bad = await doctor({
      argv: ["--offline", "--db", empty],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /database: .*missing — the migration has not run/);
    assert.match(bad.out, /openreceive scaffold payments/);
    assert.match(bad.out, /guides\/storage\.md/);

    const gone = await doctor({
      argv: ["--offline", "--db", path.join(dir, "nope.sqlite")],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(gone.code, 1);
    assert.match(gone.out, /database: no SQLite database at/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor --url recognizes the OpenReceive router's own 404", async () => {
  const mounted = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        code: "NOT_FOUND",
        message: "No OpenReceive route matched this method and path.",
        request_id: "doctor-probe",
      }),
    );
  });
  await new Promise((resolve) => mounted.listen(0, "127.0.0.1", resolve));
  const port = mounted.address().port;
  try {
    const { code, out } = await doctor({
      argv: ["--offline", "--url", `http://127.0.0.1:${port}`],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(code, 0);
    assert.match(out, /routes: OpenReceive router answering at .*\/openreceive/);
  } finally {
    mounted.close();
  }
});

test("doctor --url fails when only the framework answers", async () => {
  const bare = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/html" });
    response.end("<h1>Cannot GET</h1>");
  });
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  const port = bare.address().port;
  try {
    const { code, out } = await doctor({
      argv: ["--offline", "--url", `http://127.0.0.1:${port}`, "--prefix", "payments"],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(code, 1);
    assert.match(out, /routes: nothing OpenReceive answered at .*\/payments \(HTTP 404\)/);
    assert.match(out, /mount the router/);
  } finally {
    bare.close();
  }
});

test("doctor rejects unknown options with help pointer", async () => {
  const { code, err } = await doctor({ argv: ["--wat"], env: { NWC_URI: VALID_NWC } });
  assert.equal(code, 1);
  assert.match(err, /Unexpected option: --wat/);
});

test("debug-report always exits 0, even with nothing configured", async () => {
  const out = [];
  const code = await runCli({
    argv: ["debug-report", "--offline"],
    env: {},
    cwd: process.cwd(),
    stdout: { write: (message) => out.push(message) },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  assert.match(out.join(""), /NWC_URI: missing/);
});
