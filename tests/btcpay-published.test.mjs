import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { demoBtcpayVersion, stagePublishedPlugin } from "../tools/dotnet/published-plugin.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-published-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from("fixture published package");
  const metadata = {
    projectSlug: "openreceive",
    version: "0.4.8.0",
    buildId: 3,
    manifestInfo: { Identifier: "BTCPayServer.Plugins.OpenReceive", Version: "0.4.8.0" },
    buildInfo: {
      url: "https://artifacts.example.test/plugin.btcpay",
      buildHash: createHash("sha256").update(archive).digest("hex"),
      gitCommit: "fixture-commit",
    },
  };
  const calls = [];
  return {
    root,
    archive,
    metadata,
    calls,
    fetchApi: async (url) => {
      calls.push(url);
      return url.startsWith("https://plugin-builder.btcpayserver.org/")
        ? { ok: true, json: async () => metadata }
        : { ok: true, arrayBuffer: async () => archive };
    },
  };
}

test("published mode selects a compatible stable package and stages BTCPay's native install with its provenance", async (t) => {
  const setup = fixture(t);
  const receipt = await stagePublishedPlugin({ ...setup, btcpayVersion: "2.4.4" });
  assert.equal(
    setup.calls[0],
    "https://plugin-builder.btcpayserver.org/api/v1/plugins/directory/openreceive?btcpayVersion=2.4.4",
  );
  assert.equal(setup.calls[1], setup.metadata.buildInfo.url);
  const dir = path.join(setup.root, "packages/dotnet/docker/.state/published-plugins");
  assert.deepEqual(
    readFileSync(path.join(dir, "BTCPayServer.Plugins.OpenReceive.btcpay")),
    setup.archive,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "BTCPayServer.Plugins.OpenReceive.json"))),
    setup.metadata.manifestInfo,
  );
  assert.equal(
    readFileSync(path.join(dir, "commands"), "utf8"),
    "install:BTCPayServer.Plugins.OpenReceive\n",
  );
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "download.json"))), receipt);
  assert(!existsSync(path.join(setup.root, "packages/dotnet/docker/.state/plugins")));
  // An upstream download problem must leave the installed package and command queue intact.
  writeFileSync(path.join(dir, "commands"), "existing command\n");
  setup.metadata.buildInfo.buildHash = "0".repeat(64);
  await assert.rejects(
    stagePublishedPlugin({ ...setup, btcpayVersion: "2.4.4" }),
    /checksum mismatch/,
  );
  assert.equal(readFileSync(path.join(dir, "commands"), "utf8"), "existing command\n");
});

test("directory failures do not silently launch a source build or stage another plugin", async (t) => {
  const setup = fixture(t);
  await assert.rejects(
    stagePublishedPlugin({
      ...setup,
      btcpayVersion: "2.4.4",
      fetchApi: async () => ({ ok: false, status: 404 }),
    }),
    /lookup failed/,
  );
  setup.metadata.manifestInfo.Identifier = "Different.Plugin";
  await assert.rejects(
    stagePublishedPlugin({ ...setup, btcpayVersion: "2.4.4" }),
    /different plugin/,
  );
  assert(!existsSync(path.join(setup.root, "packages")));
});

test("published lookup uses the demo's actual BTCPay image version", () => {
  assert.throws(() => demoBtcpayVersion({}), /numeric version tag/);
  assert.equal(demoBtcpayVersion({ BTCPAY_IMAGE: "btcpayserver/btcpayserver:2.5.0" }), "2.5.0");
  assert.throws(
    () => demoBtcpayVersion({ BTCPAY_IMAGE: "btcpayserver/btcpayserver:latest" }),
    /numeric version tag/,
  );
});
