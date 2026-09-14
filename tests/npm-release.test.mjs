import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const prepare = fileURLToPath(new URL("../tools/release/npm-release.mjs", import.meta.url));

test("general release preparation preserves the independent BTCPay version", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-release-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "release-fixture", version: "1.2.3", private: true }),
  );
  const plugin = path.join(
    root,
    "packages/dotnet/BTCPayServer.Plugins.OpenReceive/BTCPayServer.Plugins.OpenReceive.csproj",
  );
  mkdirSync(path.dirname(plugin), { recursive: true });
  const source = "<Project><PropertyGroup><Version>0.4.7</Version></PropertyGroup></Project>\n";
  writeFileSync(plugin, source);
  const run = (...extra) =>
    execFileSync(
      process.execPath,
      [prepare, "prepare", "--root", root, "--version", "patch", "--allow-dirty", ...extra],
      { encoding: "utf8", env: { ...process.env, npm_config_offline: "true" } },
    );
  assert.doesNotMatch(run("--dry-run"), /BTCPayServer/);
  run();
  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"))).version, "1.2.4");
  assert.equal(readFileSync(plugin, "utf8"), source);
});
