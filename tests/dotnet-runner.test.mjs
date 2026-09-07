import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../tools/dotnet/test.mjs", import.meta.url));

function runFixture(t, overrides = {}, args = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "dotnet runner "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, "custom BTCPay checkout");
  mkdirSync(path.join(checkout, "BTCPayServer"), { recursive: true });
  writeFileSync(path.join(checkout, "BTCPayServer/BTCPayServer.csproj"), "<Project />");
  const probe = path.join(directory, "probe.cjs");
  const report = path.join(directory, "docker-args.json");
  writeFileSync(
    probe,
    `
const args = process.argv.slice(2);
if (args[0] === "info") process.exit(Number(process.env.TEST_DOCKER_INFO_STATUS ?? 0));
require("node:fs").writeFileSync(process.env.TEST_DOCKER_REPORT, JSON.stringify(args));
process.exit(Number(process.env.TEST_DOCKER_STATUS ?? 0));
`,
  );
  writeFileSync(
    path.join(directory, "docker"),
    '#!/bin/sh\nexec "$TEST_NODE" "$TEST_DOCKER_PROBE" "$@"\n',
    { mode: 0o700 },
  );
  // No host SDK should ever be consulted, even when one exists on PATH.
  writeFileSync(path.join(directory, "dotnet"), "#!/bin/sh\necho HOST_SDK_USED >&2\nexit 99\n", {
    mode: 0o700,
  });
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      BTCPAY_SERVER_ROOT: checkout,
      TEST_NODE: process.execPath,
      TEST_DOCKER_PROBE: probe,
      TEST_DOCKER_REPORT: report,
      SDK_IMAGE: "test-sdk:10",
      NUGET_VOLUME: "test-dotnet-cache",
      ...overrides,
    },
  });
  assert.doesNotMatch(result.stdout + result.stderr, /HOST_SDK_USED|SKIPPED/);
  return { result, report, checkout };
}

test(".NET runner mounts a custom checkout and forwards filters intact without a host SDK", (t) => {
  const filter = "FullyQualifiedName~Vectors | FullyQualifiedName~Money";
  const { result, report, checkout } = runFixture(t, {}, ["--filter", filter]);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.ok(args.includes(`${checkout}:/work/packages/dotnet/submodules/btcpayserver`));
  assert.ok(args.includes("BTCPAY_SERVER_ROOT=/work/packages/dotnet/submodules/btcpayserver"));
  assert.ok(args.includes("test-dotnet-cache:/root/.nuget"));
  assert.ok(args.includes("test-sdk:10"));
  assert.deepEqual(args.slice(-2), ["--filter", filter]);
});

test(".NET runner preserves a failing Docker/test exit status", (t) => {
  const { result } = runFixture(t, { TEST_DOCKER_STATUS: "37" });
  assert.equal(result.status, 37, result.stderr);
});

test(".NET runner fails clearly when Docker is stopped", (t) => {
  const { result, report } = runFixture(t, { TEST_DOCKER_INFO_STATUS: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Start Docker Desktop/);
  assert.throws(() => readFileSync(report), { code: "ENOENT" });
});

test(".NET runner fails with setup instructions when BTCPay source is missing", (t) => {
  const { result, report } = runFixture(t, { BTCPAY_SERVER_ROOT: "/missing-btcpay-source" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git submodule update --init/);
  assert.throws(() => readFileSync(report), { code: "ENOENT" });
});
