import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupBuild, testLatestBtcpay } from "../tools/dotnet/test-latest.mjs";

import { latestBtcpayRelease } from "../tools/dotnet/upstream.mjs";

const stable = { tag_name: "v2.4.5", draft: false, prerelease: false };
const response =
  (release = stable) =>
  async (url) => {
    assert.equal(url, "https://api.github.com/repos/btcpayserver/btcpayserver/releases/latest");
    return { ok: true, json: async () => release };
  };

test("latest BTCPay lookup selects a matching stable image and fails rather than falling back", async () => {
  assert.deepEqual(await latestBtcpayRelease(response()), {
    tag: "v2.4.5",
    version: "2.4.5",
    image: "btcpayserver/btcpayserver:2.4.5",
  });
  for (const invalid of [
    { ...stable, draft: true },
    { ...stable, prerelease: true },
    { ...stable, tag_name: "v2.5.0-rc1" },
    { ...stable, tag_name: "master" },
  ]) {
    await assert.rejects(latestBtcpayRelease(response(invalid)), /stable|Unsupported/);
  }
  await assert.rejects(
    latestBtcpayRelease(async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
});

test("demo startup refreshes upstream despite a stale override and stops when resolution or pull fails", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "docker.log");
  writeFileSync(
    path.join(root, "node"),
    '#!/bin/sh\n[ "$FAIL_LOOKUP" = "1" ] && exit 23\nprintf "%s\\n" btcpayserver/btcpayserver:2.5.0\n',
    { mode: 0o700 },
  );
  writeFileSync(
    path.join(root, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nexit "${FAIL_PULL:-0}"\n',
    { mode: 0o700 },
  );
  const run = (file, args = [], extra = {}) =>
    spawnSync(
      "/bin/bash",
      [new URL(`../packages/dotnet/docker/${file}`, import.meta.url).pathname, ...args],
      {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TEST_LOG: log,
          BTCPAY_IMAGE: "btcpayserver/btcpayserver:2.4.2",
          FAIL_LOOKUP: "0",
          FAIL_PULL: "0",
          ...extra,
        },
        encoding: "utf8",
      },
    );
  assert.equal(run("refresh-btcpay.sh").status, 0);
  assert.equal(readFileSync(log, "utf8"), "pull btcpayserver/btcpayserver:2.5.0\n");
  rmSync(log);
  assert.equal(run("refresh-btcpay.sh", [], { FAIL_LOOKUP: "1" }).status, 23);
  assert(!existsSync(log));
  assert.equal(run("refresh-btcpay.sh", [], { FAIL_PULL: "24" }).status, 24);
  rmSync(log);
  assert.equal(run("live.sh", ["--stop"], { FAIL_LOOKUP: "1" }).status, 0);
  assert.match(readFileSync(log, "utf8"), /down --remove-orphans/);
  assert.doesNotMatch(readFileSync(log, "utf8"), /pull/);
});

function fixture(t, { sameCommit = false, failBrowser = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-btcpay-latest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dotnet = path.join(root, "packages/dotnet");
  const pinnedSource = path.join(dotnet, "submodules/btcpayserver");
  mkdirSync(pinnedSource, { recursive: true });
  writeFileSync(path.join(pinnedSource, "source.txt"), "pinned source");
  mkdirSync(path.join(dotnet, "Plugin/bin-docker"), { recursive: true });
  mkdirSync(path.join(dotnet, "Plugin/obj-docker"), { recursive: true });
  writeFileSync(path.join(dotnet, "Plugin/code.cs"), "current plugin source");
  writeFileSync(path.join(dotnet, "Plugin/bin-docker/old.dll"), "old build");
  writeFileSync(path.join(dotnet, "Plugin/obj-docker/old.cache"), "old cache");
  const commands = [];
  const sourceCommit = "a".repeat(40);
  const pinnedCommit = sameCommit ? sourceCommit : "b".repeat(40);
  const image = `btcpayserver/btcpayserver@sha256:${"c".repeat(64)}`;
  const run = async (command, args, options) => {
    commands.push({ command, args, options });
    if (command === "docker" && args[0] === "image") return image;
    if (command === "git" && args[0] === "clone") {
      assert(args.includes(stable.tag_name));
      mkdirSync(args.at(-1), { recursive: true });
    }
    if (command === "git" && args[0] === "rev-parse") {
      return options.cwd === pinnedSource ? pinnedCommit : sourceCommit;
    }
    if (command === "bash") {
      const directory = options.env.BTCPAY_DOTNET_ROOT;
      assert.notEqual(directory, dotnet);
      assert.equal(
        readFileSync(path.join(directory, "Plugin/code.cs"), "utf8"),
        "current plugin source",
      );
      assert(!existsSync(path.join(directory, "Plugin/bin-docker/old.dll")));
      assert(!existsSync(path.join(directory, "Plugin/obj-docker/old.cache")));
      assert(!existsSync(path.join(directory, "submodules")));
      assert.equal(options.env.BTCPAY_IMAGE, image);
      if (failBrowser && args[0].endsWith("browser-smoke.sh"))
        throw new Error("browser save failed");
    }
    return "";
  };
  return {
    root,
    commands,
    pinnedSource,
    input: {
      root,
      run,
      fetch: response(),
      log: () => {},
      summaryFile: path.join(root, "summary.md"),
    },
  };
}

test("upstream checks exercise latest build and pinned binary against one image without changing the checkout", async (t) => {
  const { input, commands, pinnedSource, root } = fixture(t);
  const result = await testLatestBtcpay(input);
  assert.equal(result.status, "passed");
  const checks = commands.filter(({ command }) => command === "bash");
  assert.deepEqual(
    checks.map(({ args }) => path.basename(args[0])),
    ["test-unit.sh", "browser-smoke.sh", "browser-smoke.sh"],
  );
  assert.equal(checks[0].options.env.BTCPAY_SERVER_ROOT, checks[1].options.env.BTCPAY_SERVER_ROOT);
  assert.equal(checks[2].options.env.BTCPAY_SERVER_ROOT, pinnedSource);
  assert.notEqual(
    checks[1].options.env.BTCPAY_DOTNET_ROOT,
    checks[2].options.env.BTCPAY_DOTNET_ROOT,
  );
  assert.equal(readFileSync(path.join(pinnedSource, "source.txt"), "utf8"), "pinned source");
  assert.equal(
    readFileSync(path.join(root, "packages/dotnet/Plugin/bin-docker/old.dll"), "utf8"),
    "old build",
  );
  assert(!existsSync(checks[0].options.env.BTCPAY_DOTNET_ROOT));
  assert.equal(
    JSON.parse(readFileSync(path.join(root, ".release/btcpay-compatibility/latest.json"))).status,
    "passed",
  );
});

test("identical pinned and latest commits share the runtime check", async (t) => {
  const { input, commands } = fixture(t, { sameCommit: true });
  const result = await testLatestBtcpay(input);
  assert.equal(result.checks.length, 3);
  assert.equal(commands.filter(({ command }) => command === "bash").length, 2);
});

test("Linux cleanup confines root-owned build removal to the disposable directory", async () => {
  let attempts = 0;
  let calls = 0;
  await cleanupBuild(
    "/fixture/.release/btcpay-compatibility/work-test",
    async (command, args) => {
      calls++;
      assert.equal(command, "docker");
      assert.equal(args[3], "/fixture/.release/btcpay-compatibility/work-test:/cleanup");
      assert.equal(args.filter((arg) => arg.includes(":/cleanup")).length, 1);
      assert(args.at(-1).startsWith("rm -rf /cleanup/"));
    },
    () => {
      if (attempts++ === 0)
        throw Object.assign(new Error("root-owned directory"), { code: "EACCES" });
    },
  );
  assert.equal(calls, 1);
  assert.equal(attempts, 2);
});

test("a browser failure fails compatibility, records the failure and cleans the isolated builds", async (t) => {
  const { input, commands, root } = fixture(t, { failBrowser: true });
  await assert.rejects(testLatestBtcpay(input), /browser save failed/);
  const report = JSON.parse(
    readFileSync(path.join(root, ".release/btcpay-compatibility/latest.json")),
  );
  assert.equal(report.status, "failed");
  assert.deepEqual(report.checks, ["latest-source-unit-tests"]);
  const checks = commands.filter(({ command }) => command === "bash");
  assert.equal(checks.length, 2);
  assert(!existsSync(checks[0].options.env.BTCPAY_DOTNET_ROOT));
});
