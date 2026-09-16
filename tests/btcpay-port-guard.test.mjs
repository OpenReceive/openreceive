import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const guard = new URL("../packages/dotnet/docker/port-guard.sh", import.meta.url).pathname;

/** Runs the guard for `project` with a fake `docker ps` that reports `holder` on port 14180. */
function run(t, project, holder) {
  const bin = mkdtempSync(path.join(tmpdir(), "openreceive-port-guard-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(holder)}\n`, {
    mode: 0o700,
  });
  return spawnSync(
    "bash",
    ["-c", `source "${guard}"; require_btcpay_port_free "${project}"; echo proceeded`],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );
}

test("a free port lets the stack start", (t) => {
  const result = run(t, "openreceive-btcpay-live", "");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proceeded/);
});

test("the caller's own BTCPay container is not a conflict", (t) => {
  const result = run(t, "openreceive-btcpay", "openreceive-btcpay-btcpayserver-1");
  assert.equal(result.status, 0, result.stderr);
});

test("the live demo names the testkit stop command when the regtest stack holds the port", (t) => {
  const result = run(t, "openreceive-btcpay-live", "openreceive-btcpay-btcpayserver-1");
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /proceeded/);
  assert.match(result.stderr, /14180 is held by openreceive-btcpay-btcpayserver-1/);
  assert.match(result.stderr, /npm run demo btcpayserver -- --testkit --stop/);
});

test("the regtest stack names the live stop command when the demo holds the port", (t) => {
  const result = run(t, "openreceive-btcpay", "openreceive-btcpay-live-btcpayserver-1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm run demo btcpayserver -- --stop/);
});

test("an unrelated container gets a plain docker stop hint", (t) => {
  const result = run(t, "openreceive-btcpay", "someone-elses-btcpay");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docker stop someone-elses-btcpay/);
});
