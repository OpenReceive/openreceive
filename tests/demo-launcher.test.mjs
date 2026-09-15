import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configureLiveDemo } from "../tools/dotnet/demo-live.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-demo-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "tools/shared"), { recursive: true });
  mkdirSync(path.join(root, "bin"));
  for (const name of ["run-demo.mjs", "shared/demo-catalog.mjs"]) {
    copyFileSync(new URL(`../tools/${name}`, import.meta.url), path.join(root, "tools", name));
  }
  const events = path.join(root, "events.jsonl");
  for (const command of ["git", "bash"]) {
    writeFileSync(
      path.join(root, "bin", command),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify({command: ${JSON.stringify(command)}, args: process.argv.slice(2)}) + '\\n');
process.exit(Number(process.env.TEST_FAIL_${command.toUpperCase()} ?? 0));
`,
      { mode: 0o700 },
    );
  }
  return {
    root,
    events: () =>
      existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").map(JSON.parse) : [],
    run: (args, env = {}) =>
      spawnSync(process.execPath, [path.join(root, "tools/run-demo.mjs"), ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
          NWC_URI: "",
          TEST_EVENTS: events,
          ...env,
        },
      }),
  };
}

test("BTCPay starts from an uninitialized checkout without a shop wallet, .env or compiled JS packages", (t) => {
  const setup = fixture(t);
  const result = setup.run(["btcpayserver", "--testkit"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(setup.events(), [
    {
      command: "git",
      args: [
        "submodule",
        "update",
        "--init",
        "--depth",
        "1",
        "packages/dotnet/submodules/btcpayserver",
      ],
    },
    { command: "bash", args: ["packages/dotnet/docker/up.sh"] },
  ]);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:14180/);
  assert.match(result.stdout, /--stop/);
  assert(!existsSync(path.join(setup.root, ".env")));
});

test("BTCPay stop preserves data and never bootstraps or rebuilds the stack", (t) => {
  const setup = fixture(t);
  const result = setup.run(["btcpay", "--", "--testkit", "--stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(setup.events(), [{ command: "bash", args: ["packages/dotnet/docker/down.sh"] }]);
  assert.doesNotMatch(result.stdout, /BTCPay is ready/);
});

test("BTCPay startup failures propagate and conflicting or unsupported options do nothing", (t) => {
  const setup = fixture(t);
  for (const args of [["--volumes"], ["--stop", "--no-build"]]) {
    assert.equal(setup.run(["btcpayserver", ...args]).status, 1);
  }
  assert.deepEqual(setup.events(), []);
  const result = setup.run(["btcpayserver", "--testkit"], { TEST_FAIL_BASH: "17" });
  assert.equal(result.status, 17);
  assert.doesNotMatch(result.stdout, /BTCPay is ready/);
});

test("live demo requires a wallet before starting Docker, but stop needs no .env", (t) => {
  const setup = fixture(t);
  const missing = setup.run(["btcpayserver"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Set NWC_URI/);
  assert.deepEqual(setup.events(), []);
  assert.equal(setup.run(["btcpayserver", "--stop"]).status, 0);
  assert.deepEqual(setup.events(), [
    { command: "bash", args: ["packages/dotnet/docker/live.sh", "--stop"] },
  ]);
});

test("live launcher loads root .env without compiled JS packages or putting credentials in command args", (t) => {
  const setup = fixture(t);
  mkdirSync(path.join(setup.root, "tools/dotnet"));
  writeFileSync(
    path.join(setup.root, "tools/dotnet/demo-live.mjs"),
    `
    import assert from 'node:assert/strict';
    export async function configureLiveDemo() {
      assert.equal(process.env.NWC_URI, 'fixture-wallet');
      assert.equal(process.env.LSC_URI_PRIMARY, 'fixture-primary');
      assert.equal(process.env.LSC_URI_BACKUP, 'fixture-backup');
      return { email: 'demo@example.test', stateFile: 'login.json', swapsEnabled: true };
    }
  `,
  );
  writeFileSync(
    path.join(setup.root, ".env"),
    "NWC_URI=fixture-wallet\nLSC_URI_PRIMARY=fixture-primary\nLSC_URI_BACKUP=fixture-backup\n",
  );
  const result = setup.run(["btcpayserver", "--no-build"], {
    NWC_URI: undefined,
    LSC_URI_PRIMARY: undefined,
    LSC_URI_BACKUP: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /swaps enabled/);
  assert.doesNotMatch(
    result.stdout + result.stderr + JSON.stringify(setup.events()),
    /fixture-wallet|fixture-primary|fixture-backup/,
  );
});

test("live setup reuses its account and store, updates providers, and never creates an invoice or swap", async (t) => {
  const setup = fixture(t);
  const requests = [];
  const fetchApi = async (url, options = {}) => {
    const route = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    requests.push({ route, method: options.method, body });
    let result = {};
    if (route === "/api/v1/api-keys") result = { apiKey: "fixture-key" };
    else if (route === "/api/v1/stores") result = options.method === "GET" ? [] : { id: "store-1" };
    else if (route.endsWith("/openreceive/settings"))
      result = { lightningNodeIsOpenReceive: true, swapsEnabled: body.swapsEnabled };
    else assert(["/login", "/api/v1/users"].includes(route), `Unexpected endpoint: ${route}`);
    return { ok: true, json: async () => result };
  };
  const configured = await configureLiveDemo({
    root: setup.root,
    env: {
      NWC_URI: "fixture-wallet",
      LSC_URI_PRIMARY: "fixture-provider",
      LSC_URI_BACKUP: "fixture-backup",
    },
    fetchApi,
  });
  assert.equal(configured.swapsEnabled, true);
  const saved = readFileSync(configured.stateFile, "utf8");
  assert.doesNotMatch(saved, /fixture-wallet|fixture-provider|fixture-backup/);
  assert.deepEqual(requests.at(-1).body, {
    nwcUri: "fixture-wallet",
    allowSpendCapableWallet: false,
    lscPrimary: "fixture-provider",
    lscBackup: "fixture-backup",
    swapsEnabled: true,
  });
  requests.length = 0;
  await configureLiveDemo({ root: setup.root, env: { NWC_URI: "replacement-wallet" }, fetchApi });
  assert.deepEqual(
    requests.map((r) => r.route),
    ["/login", "/api/v1/stores/store-1/openreceive/settings"],
  );
  assert.deepEqual(requests.at(-1).body, {
    nwcUri: "replacement-wallet",
    allowSpendCapableWallet: false,
    lscPrimary: "",
    lscBackup: "",
    swapsEnabled: false,
  });
  const refusingApi = async (url, options) =>
    url.endsWith("/settings")
      ? { ok: false, status: 422, json: async () => ({ message: "sensitive-response" }) }
      : fetchApi(url, options);
  await assert.rejects(
    configureLiveDemo({
      root: setup.root,
      env: { NWC_URI: "fixture-wallet" },
      fetchApi: refusingApi,
    }),
    (error) => {
      assert.match(error.message, /HTTP 422/);
      assert.doesNotMatch(error.message, /sensitive-response|fixture-wallet/);
      return true;
    },
  );
});
