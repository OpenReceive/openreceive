import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { paymentsSchemaSql } from "../packages/js/http/src/sql-payments.ts";
import { runCli } from "../packages/js/node/src/cli.ts";

const VALID_NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;

function receiveOnlyWallet() {
  return {
    preflight: async () => ({
      methods: ["make_invoice", "list_transactions"],
      spendCapabilityAdvertised: false,
      warnings: [],
    }),
    listTransactions: async () => ({ transactions: [] }),
    close: async () => {},
  };
}

// Doctor reads Next's env files from its cwd, and the repo root keeps live
// codes in .env. Every test runs from an empty directory unless it says otherwise.
const EMPTY_CWD = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-cwd-"));
test.after(() => rm(EMPTY_CWD, { recursive: true, force: true }));

async function doctor({ argv = [], env = {}, walletClientFactory, cwd = EMPTY_CWD } = {}) {
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

test("doctor reads .env.local, then .env, without overriding the environment", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-env-"));
  try {
    const lsc = "lightning+swapconnect://swap.example.com/v1?key=k&secret=s";
    const otherNwc = VALID_NWC.replace("a".repeat(64), "c".repeat(64));
    // Unquoted, with the `&` that splits a value when the file is sourced.
    await writeFile(path.join(dir, ".env.local"), `NWC_URI=${VALID_NWC}\nOTHER=1\n`);
    await writeFile(path.join(dir, ".env"), `NWC_URI=${otherNwc}\nLSC_URI_PRIMARY=${lsc}\n`);
    let probed;
    const { code, out } = await doctor({
      cwd: dir,
      walletClientFactory: (options) => {
        probed = options.connectionString;
        return receiveOnlyWallet();
      },
    });
    assert.equal(code, 0);
    assert.equal(probed, VALID_NWC);
    assert.match(out, /env files: \.env\.local, \.env\n/);
    assert.match(out, /NWC_URI: present-redacted/);
    assert.match(out, /LSC_URI connections: 1/);
    assert.doesNotMatch(out, /secret=|walletconnect:\/\/|swapconnect:\/\//);

    const fromEnv = await doctor({
      cwd: dir,
      env: { NWC_URI: otherNwc, LSC_URI_PRIMARY: "" },
      walletClientFactory: (options) => {
        probed = options.connectionString;
        return receiveOnlyWallet();
      },
    });
    assert.equal(probed, otherNwc);
    assert.match(fromEnv.out, /LSC_URI connections: 0/);
    assert.match(
      fromEnv.out,
      /env files: none used \(checked \.env\.development\.local, \.env\.local, \.env\.development, \.env\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// v0 writes a project's variables to .env.development.local and no .env.local.
test("doctor reads .env.development.local before .env.local, as Next does", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-env-"));
  try {
    const otherNwc = VALID_NWC.replace("a".repeat(64), "c".repeat(64));
    await writeFile(path.join(dir, ".env.development.local"), `NWC_URI=${VALID_NWC}\n`);
    let probed;
    const walletClientFactory = (options) => {
      probed = options.connectionString;
      return receiveOnlyWallet();
    };
    const v0 = await doctor({ cwd: dir, walletClientFactory });
    assert.equal(v0.code, 0);
    assert.equal(probed, VALID_NWC);
    assert.match(v0.out, /env files: \.env\.development\.local\n/);

    await writeFile(path.join(dir, ".env.local"), `NWC_URI=${otherNwc}\n`);
    await doctor({ cwd: dir, walletClientFactory });
    assert.equal(probed, VALID_NWC);

    // A production build reads the production files and never the development ones.
    const production = await doctor({
      cwd: dir,
      env: { NODE_ENV: "production" },
      walletClientFactory,
    });
    assert.equal(probed, otherNwc);
    assert.match(production.out, /env files: \.env\.local\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// A wallet publishes its methods for anyone to read, so a wrong secret passes
// the preflight. A FOSSBilling trial looped on UNAUTHORIZED after doctor passed.
test("doctor fails when the wallet refuses the code behind a readable preflight", async () => {
  const { code, out } = await doctor({
    env: { NWC_URI: VALID_NWC },
    walletClientFactory: () => ({
      ...receiveOnlyWallet(),
      listTransactions: async () => {
        throw Object.assign(new Error("this public key has no wallet connected"), {
          code: "UNAUTHORIZED",
        });
      },
    }),
  });
  assert.equal(code, 1);
  assert.match(out, /wallet: the wallet refused this code \(UNAUTHORIZED\)/);
  assert.match(out, /get_a_nwc_code_to_receive_payments/);
  assert.doesNotMatch(out, /wallet: reachable/);
});

test("doctor fails when the wallet never answers a signed request", async () => {
  const { code, out } = await doctor({
    env: { NWC_URI: VALID_NWC },
    walletClientFactory: () => ({
      ...receiveOnlyWallet(),
      listTransactions: async () => {
        throw Object.assign(new Error("reply timeout"), { code: "TIMEOUT" });
      },
    }),
  });
  assert.equal(code, 1);
  assert.match(out, /did not answer a signed request/);
  assert.doesNotMatch(out, /wallet: reachable/);
});

test("doctor's proof reads one history row and makes nothing", async () => {
  const calls = [];
  const { code } = await doctor({
    env: { NWC_URI: VALID_NWC },
    walletClientFactory: () => ({
      ...receiveOnlyWallet(),
      makeInvoice: async () => {
        calls.push("makeInvoice");
        return {};
      },
      listTransactions: async (request) => {
        calls.push(request);
        return { transactions: [] };
      },
    }),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ limit: 1 }]);
});

// These four run inside store software no test here boots. The library's own
// proof is tested in DoctorProofTest; this keeps each of them calling it.
test("every store platform's doctor proves the wallet accepts the code", async () => {
  for (const file of [
    "packages/php/wordpress/src/Plugin.php",
    "packages/php/fossbilling/src/modules/Openreceive/Commands/Doctor.php",
    "packages/php/paymenter/Support/Commands/DoctorCommand.php",
    "packages/php/prestashop/openreceive/src/Commands/Doctor.php",
  ]) {
    const source = await readFile(path.join(import.meta.dirname, "..", file), "utf8");
    assert.match(
      source,
      /'Wallet preflight'.{0,200}?proveCodeAccepted\(\$service->nwcClient\(\)\)/s,
      `${file} must make the signed request`,
    );
    // The WordPress build renames bundled classes in `use` lines only.
    assert.doesNotMatch(source, /\\OpenReceive\\Server\\Doctor::/, `${file} must import it`);
  }
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

// Video 12 (2026-11-06): on Node 22.12 node:sqlite sits behind a flag, so an
// app there uses better-sqlite3, and doctor failed a check the app passed.
// Doctor reads the file with the app's own better-sqlite3 instead. Node
// 22.13+ turns node:sqlite off with --no-experimental-sqlite, which stands in
// for the older Node here.
test("doctor --db reads SQLite with the app's better-sqlite3 when node:sqlite is off", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const probe = execFileSync(
    process.execPath,
    [
      "--no-experimental-sqlite",
      "--input-type=module",
      "-e",
      'import("node:sqlite").then(() => console.log("on"), () => console.log("off"))',
    ],
    { encoding: "utf8" },
  ).trim();
  if (probe !== "off") {
    t.skip("this Node cannot turn node:sqlite off");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-"));
  try {
    const migrated = path.join(dir, "migrated.sqlite");
    const database = new DatabaseSync(migrated);
    database.exec(paymentsSchemaSql("sqlite"));
    database.close();
    const cli = new URL("../packages/js/node/src/cli.ts", import.meta.url).href;
    const script = `
      const { runCli } = await import(${JSON.stringify(cli)});
      const out = [];
      const code = await runCli({
        argv: ["doctor", "--offline", "--db", ${JSON.stringify(migrated)}],
        env: { NWC_URI: ${JSON.stringify(VALID_NWC)} },
        cwd: process.cwd(),
        stdout: { write: (message) => out.push(message) },
        stderr: { write: () => {} },
      });
      console.log(JSON.stringify({ code, out: out.join("") }));
    `;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--no-experimental-sqlite", "--import", "tsx", "--input-type=module", "-e", script],
        { encoding: "utf8" },
      ),
    );
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /database: openreceive_payments and openreceive_meta present/);
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

// The router answers GET without a JSON body parser in front of it, so only a
// POST shows that every checkout create would 500.
test("doctor --url fails when no JSON body parser runs before the router", async () => {
  const unparsed = http.createServer((request, response) => {
    response.writeHead(request.method === "POST" ? 500 : 404, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(
      JSON.stringify(
        request.method === "POST"
          ? {
              code: "INTERNAL",
              message:
                "OpenReceive received a JSON request body that no body parser had read. Mount your " +
                "framework's JSON body parser (Express: app.use(express.json())) before the OpenReceive " +
                "middleware.",
            }
          : { code: "NOT_FOUND", message: "No OpenReceive route matched this method and path." },
      ),
    );
  });
  await new Promise((resolve) => unparsed.listen(0, "127.0.0.1", resolve));
  const port = unparsed.address().port;
  try {
    const { code, out } = await doctor({
      argv: ["--offline", "--url", `http://127.0.0.1:${port}`],
      env: { NWC_URI: VALID_NWC },
    });
    assert.equal(code, 1);
    assert.match(out, /routes: the router answers at .*\/openreceive, but every POST fails/);
    assert.match(out, /app\.use\(express\.json\(\)\)/);
  } finally {
    unparsed.close();
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

// A merchant who installed the Claude Code plugin saw doctor tell them to
// install the skills again.
test("doctor suggests the skills install only when no skill is installed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-skills-"));
  const home = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-home-"));
  const skillsLine = async (env = {}) =>
    (await doctor({ argv: ["--offline"], env: { NWC_URI: VALID_NWC, ...env }, cwd: dir })).out
      .split("\n")
      .find((line) => line.startsWith("Agent skills:"));
  const enable = (file, enabled) =>
    writeFile(file, JSON.stringify({ enabledPlugins: { "openreceive@openreceive": enabled } }));
  try {
    assert.match(await skillsLine(), /optional — .*run `npx openreceive skills install`/);
    await mkdir(path.join(home, ".claude"));
    await enable(path.join(home, ".claude/settings.json"), true);
    assert.equal(
      await skillsLine({ HOME: home }),
      "Agent skills: installed (~/.claude/settings.json enables the openreceive plugin)",
    );
    await mkdir(path.join(dir, ".claude"));
    await enable(path.join(dir, ".claude/settings.local.json"), false);
    assert.match(await skillsLine(), /optional/);
    await enable(path.join(dir, ".claude/settings.json"), true);
    assert.equal(
      await skillsLine(),
      "Agent skills: installed (.claude/settings.json enables the openreceive plugin)",
    );
    await mkdir(path.join(dir, ".agents/skills/integrate-openreceive"), { recursive: true });
    await writeFile(path.join(dir, ".agents/skills/integrate-openreceive/SKILL.md"), "---\n");
    assert.equal(
      await skillsLine(),
      "Agent skills: installed (.agents/skills/integrate-openreceive)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("debug-report always exits 0, even with nothing configured", async () => {
  const out = [];
  const code = await runCli({
    argv: ["debug-report", "--offline"],
    env: {},
    cwd: EMPTY_CWD,
    stdout: { write: (message) => out.push(message) },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  assert.match(out.join(""), /NWC_URI: missing/);
});

// Trial agents ran `npx openreceive@0.4.21 doctor --help` to read its usage;
// it answered "Unexpected option: --help" and exit 1.
test("doctor --help prints the usage and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const out = [];
    const code = await runCli({
      argv: ["doctor", "--db", "shop.sqlite", flag],
      env: {},
      cwd: EMPTY_CWD,
      stdout: { write: (message) => out.push(message) },
      stderr: { write: () => undefined },
    });
    assert.equal(code, 0, flag);
    assert.match(out.join(""), /--offline/, flag);
  }
});

// A Nuxt trial agent checked its build for leaks by passing 16-character
// prefixes of both codes to grep, which put them in the shell history and the
// process list. Every code here is random and built at runtime from parts.
function fakeCodes() {
  const hex = () => randomBytes(32).toString("hex");
  const nwcSecret = hex();
  const lscKey = hex();
  const lscSecret = hex();
  return {
    nwcSecret,
    lscKey,
    lscSecret,
    nwc: [
      "nostr+wallet",
      "connect://",
      hex(),
      "?relay=wss%3A%2F%2Frelay.example.com&",
      "secret=",
      nwcSecret,
    ].join(""),
    lsc: [
      "lightning+swap",
      "connect://swap.example.com/v1?",
      `key=${lscKey}&`,
      "secret=",
      lscSecret,
    ].join(""),
  };
}

async function withBuild(files, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "openreceive-doctor-scan-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const scan = (cwd, env, target = ".output") => doctor({ argv: ["--scan-build", target], env, cwd });
const JS_FILE = ".output/public/_nuxt/abc.js";

test("doctor --scan-build finds a whole code and names only the code and the file", async () => {
  const codes = fakeCodes();
  await withBuild(
    { [JS_FILE]: `const a="${codes.nwc}";`, ".output/public/ok.js": "1" },
    async (cwd) => {
      const { code, out } = await scan(cwd, { NWC_URI: codes.nwc, LSC_URI_PRIMARY: codes.lsc });
      assert.equal(code, 1);
      assert.deepEqual(out.trim().split("\n").slice(0, -1), [`NWC_URI found in ${JS_FILE}`]);
      assert.match(out, /keep these codes out of browser code/);
    },
  );
});

test("doctor --scan-build finds a credential value that was split from its URI", async () => {
  const codes = fakeCodes();
  const hit = async (env, content) => withBuild({ [JS_FILE]: content }, (cwd) => scan(cwd, env));
  const secret = await hit({ NWC_URI: codes.nwc }, `const s="${codes.nwcSecret}"`);
  assert.equal(secret.code, 1);
  assert.match(secret.out, /^NWC_URI found in /);
  // A serializer that escapes `&` breaks the whole URI but not the value after it.
  const escaped = await hit({ NWC_URI: codes.nwc }, codes.nwc.replace("&", "\\u0026"));
  assert.equal(escaped.code, 1);
  assert.match(escaped.out, /^NWC_URI found in /);
  const percent = await hit({ NWC_URI: codes.nwc }, encodeURIComponent(codes.nwc));
  assert.equal(percent.code, 1);
  const key = await hit({ LSC_URI_BACKUP: codes.lsc }, `k="${codes.lscKey}"`);
  assert.equal(key.code, 1);
  assert.match(key.out, /^LSC_URI_BACKUP found in /);
  const bare = await hit({ LSC_URI: codes.lsc }, `k="${codes.lscSecret}"`);
  assert.equal(bare.code, 1);
  assert.match(bare.out, /^LSC_URI found in /);
});

test("doctor --scan-build searches source maps, external and inline", async () => {
  const codes = fakeCodes();
  const map = JSON.stringify({ version: 3, sourcesContent: [`x="${codes.nwc}"`] });
  await withBuild({ ".output/public/_nuxt/abc.js.map": map }, async (cwd) => {
    const { code, out } = await scan(cwd, { NWC_URI: codes.nwc });
    assert.equal(code, 1);
    assert.match(out, /^NWC_URI found in \.output\/public\/_nuxt\/abc\.js\.map\n/);
  });
  // The secret lands at every base64 offset across these three prefixes.
  for (const prefix of ["", "x", "xy"]) {
    const inline = Buffer.from(`${prefix}"${codes.nwcSecret}"`).toString("base64");
    await withBuild(
      { [JS_FILE]: `//# sourceMappingURL=data:application/json;base64,${inline}` },
      async (cwd) => {
        const { code } = await scan(cwd, { NWC_URI: codes.nwc });
        assert.equal(code, 1, `prefix ${JSON.stringify(prefix)}`);
      },
    );
  }
});

test("doctor --scan-build passes a clean build with one plain line", async () => {
  const codes = fakeCodes();
  await withBuild({ [JS_FILE]: "const a=1;", ".output/public/a.css": "a{}" }, async (cwd) => {
    const { code, out } = await scan(cwd, { NWC_URI: codes.nwc, LSC_URI_PRIMARY: codes.lsc });
    assert.equal(code, 0);
    assert.equal(
      out,
      "scan-build: no code found in 2 files under .output (NWC_URI, LSC_URI_PRIMARY)\n",
    );
  });
});

test("doctor --scan-build fails when there is no code, no directory, or an empty one", async () => {
  await withBuild({ [JS_FILE]: "const a=1;" }, async (cwd) => {
    const none = await scan(cwd, {});
    assert.equal(none.code, 1);
    assert.match(none.out, /no NWC_URI or LSC_URI_\* code is set here/);

    const codes = fakeCodes();
    const missing = await scan(cwd, { NWC_URI: codes.nwc }, "nope");
    assert.equal(missing.code, 1);
    assert.match(missing.out, /no directory at nope\./);

    await mkdir(path.join(cwd, "empty"));
    const empty = await scan(cwd, { NWC_URI: codes.nwc }, "empty");
    assert.equal(empty.code, 1);
    assert.match(empty.out, /no files in empty\./);

    // A code passed by mistake where the directory goes is not echoed back.
    const misuse = await scan(cwd, { NWC_URI: codes.nwc }, codes.nwc);
    assert.equal(misuse.code, 1);
    assert.equal(misuse.out.includes(codes.nwcSecret), false);
  });
});

test("doctor --scan-build reads codes from every env file, in either mode", async () => {
  const codes = fakeCodes();
  const other = fakeCodes();
  await withBuild(
    {
      ".env.development.local": `NWC_URI=${other.nwc}\n`,
      ".env.production": `NWC_URI=${codes.nwc}\nLSC_URI_PRIMARY=${codes.lsc}\n`,
      [JS_FILE]: `a="${codes.nwcSecret}";b="${codes.lscSecret}"`,
    },
    async (cwd) => {
      const { code, out } = await scan(cwd, {});
      assert.equal(code, 1);
      assert.match(out, /^LSC_URI_PRIMARY found in .*\nNWC_URI found in /);
    },
  );
});

test("doctor --scan-build skips node_modules and symlinks, and reads binary files", async () => {
  const codes = fakeCodes();
  const secret = `s="${codes.nwcSecret}"`;
  await withBuild(
    {
      "outside.js": secret,
      ".output/public/a.js": "1",
      ".output/server/node_modules/x.js": secret,
    },
    async (cwd) => {
      await symlink(path.join(cwd, "outside.js"), path.join(cwd, ".output/public/link.js"));
      const { code, out } = await scan(cwd, { NWC_URI: codes.nwc });
      assert.equal(code, 0, out);
    },
  );
  await withBuild(
    {
      ".output/public/a.bin": Buffer.concat([
        Buffer.from([0xff, 0xfe, 0x00, 0xc3]),
        Buffer.from(codes.nwcSecret),
        Buffer.from([0x00, 0xff]),
      ]),
    },
    async (cwd) => assert.equal((await scan(cwd, { NWC_URI: codes.nwc })).code, 1),
  );
});

test("doctor --scan-build finds a value that straddles two read chunks", async () => {
  const codes = fakeCodes();
  const before = Buffer.alloc(1024 * 1024 - 10, 0x20);
  await withBuild(
    { [JS_FILE]: Buffer.concat([before, Buffer.from(codes.nwcSecret), before]) },
    async (cwd) => assert.equal((await scan(cwd, { NWC_URI: codes.nwc })).code, 1),
  );
});

test("doctor --scan-build never prints a code or a piece of one", async () => {
  const codes = fakeCodes();
  const env = { NWC_URI: codes.nwc, LSC_URI_PRIMARY: codes.lsc };
  const files = { [JS_FILE]: `${codes.nwc}\n${codes.lsc}`, ".output/a.js.map": codes.nwcSecret };
  await withBuild(files, async (cwd) => {
    const runs = [await scan(cwd, env), await scan(cwd, env, "nope"), await scan(cwd, {})];
    assert.equal(runs[0].code, 1);
    const printed = runs.map((run) => run.out + run.err).join("");
    for (const value of [codes.nwc, codes.lsc, codes.nwcSecret, codes.lscKey, codes.lscSecret]) {
      for (let start = 0; start + 8 <= value.length; start += 1) {
        const piece = value.slice(start, start + 8);
        if (/^[0-9a-f]{8}$/.test(piece)) assert.equal(printed.includes(piece), false);
      }
    }
    assert.doesNotMatch(printed, /secret=|walletconnect|swapconnect/);
  });
});

test("doctor --scan-build runs alone and only under doctor", async () => {
  const report = [];
  const code = await runCli({
    argv: ["debug-report", "--scan-build", "x"],
    env: {},
    cwd: EMPTY_CWD,
    stdout: { write: () => {} },
    stderr: { write: (message) => report.push(message) },
  });
  assert.equal(code, 1);
  assert.match(report.join(""), /--scan-build runs alone/);
  const withDb = await doctor({ argv: ["--scan-build", "x", "--db", "y"], env: {} });
  assert.equal(withDb.code, 1);
  assert.match(withDb.err, /--scan-build runs alone/);
});
