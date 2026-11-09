#!/usr/bin/env node

// The bug zoo: for every past fix, undo the fix at HEAD, keep the tests, and see
// that some test fails. A fix nothing would catch can come back silently.
//
//   npm run test:bug-zoo                       # v0.4.30..HEAD, every engine
//   npm run test:bug-zoo -- v0.4.25..HEAD
//   npm run test:bug-zoo -- --only 46dd9917,e96d1fe1 --engine python --jobs 2
//   npm run test:bug-zoo -- --plan             # just the reversibility pass
//
// Every commit in the range whose subject starts with `fix` and that touches
// packages/** is one zoo exhibit. In a temp copy of the checkout (HEAD plus any
// uncommitted files, so new tests count), the commit's non-test changes are
// reversed one engine at a time and that engine's suite runs. Each engine slice
// of a commit gets its own copy and its own verdict: undoing Ruby's half of a
// fix and seeing a Ruby test fail says nothing about Python's half.
//
//   CAUGHT          a named test failed with the fix undone (confirmed by a
//                   second run on the failing tests, against a clean baseline).
//                   [load-only] means only import failures: the name the test
//                   imports is gone, which is weaker than a failed assertion.
//   NOT CAUGHT      every test passed with the fix undone.
//   NOT REVERSIBLE  the fix cannot be undone at HEAD, or undoing it does not
//                   build; the reason says why. The overrides file holds
//                   hand-made undos for the cases where the fix is still there.
//   NOT RUN         the engine's suite could not start on this machine at all
//                   (its baseline failed to run); says nothing about the fix.
//
// The PHP suite stops at the first failing package, so its named test is the
// first catch found, not every test that would catch. Ruby and JS list them all. Commits that
// made several separate fixes also get one row per part (VARIANTS in the
// overrides file); --per-file instead tries each reversed file alone.
//
// Output: a table on stdout and JSON at tmp/bug-zoo.json (gitignored; --json
// sets another path). Everything else lives in one temp directory that is
// removed on exit, including ^C; Docker containers carry a run-specific name
// and are removed too. Node's memory-safety wrapper (systemd-run scope) is
// used when available.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OUT_OF_SCOPE, OVERRIDES, VARIANTS } from "./bug-zoo-overrides.mjs";

const HELP = `Usage: bug-zoo [git-range] [options]

  git-range            commits to examine (default v0.4.30..HEAD)
  --only <sha,...>     just these commits (prefix match)
  --engine <e,...>     just these engines: js, python, odoo, ruby, php
  --jobs <n>           suites running at once (default 4)
  --js-concurrency <n> node --test concurrency per JS suite (default 3)
  --json <path>        where to write the JSON (default tmp/bug-zoo.json)
  --plan               only report which fixes still reverse at HEAD
  --per-file           instead of whole commits, undo each reversed file alone
                       (exploratory: finds a file a commit-level catch hides;
                       a file that needs its neighbours shows as NOT
                       REVERSIBLE or a load failure)
  --keep               keep the temp directory, for debugging
`;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(THIS_DIR, "../..");
const REPORTER = pathToFileURL(path.join(THIS_DIR, "bug-zoo-reporter.mjs")).href;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    engine: { type: "string" },
    jobs: { type: "string", default: "4" },
    "js-concurrency": { type: "string", default: "3" },
    json: { type: "string", default: path.join(ROOT, "tmp", "bug-zoo.json") },
    plan: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "per-file": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
const RANGE = positionals[0] ?? "v0.4.30..HEAD";
const JOBS = Number(opts.jobs);
const JS_CONCURRENCY = Number(opts["js-concurrency"]);
if (!Number.isInteger(JOBS) || JOBS < 1) throw new Error("--jobs must be a positive integer");
const ONLY = opts.only?.split(",").map((s) => s.trim());
const ENGINE_FILTER = opts.engine ? new Set(opts.engine.split(",").map((s) => s.trim())) : null;

// --- what counts as "the fix" and which suite tests it ------------------------

// Never reversed: the tests themselves and their fixtures. Beyond the
// instructions' list (tests, test vectors, docs, changelog) this also keeps:
// spec/ whole (the OpenAPI document is the contract the tests hold the code
// to); trials/, tools/live-nwc-test/ and tools/validate/ (test harnesses and
// their snapshots); README/markdown; and root package.json and lock files
// (node_modules stays as installed, and package.json's script wiring is the
// test runner, not the product).
const NOT_THE_FIX = [
  /^tests\//,
  /^spec\//,
  /^packages\/.*\/tests?\//,
  /(^|\/)[^/]*\.test\.[^/]+$/,
  /^docs\//,
  /(^|\/)CHANGELOG[^/]*$/i,
  /(^|\/)README[^/]*$/i,
  /\.md$/i,
  /^trials\//,
  /^skills\//,
  /^tools\/live-nwc-test\//,
  /^tools\/validate\//,
  /^package\.json$/,
  /(^|\/)(package-lock\.json|uv\.lock|composer\.lock|Gemfile\.lock)$/,
];

const isFixFile = (file) => !NOT_THE_FIX.some((pattern) => pattern.test(file));

/** Which engine's suite covers a reversed file. null = reversed in every slice. */
function engineFor(file) {
  if (file.startsWith("packages/js/") || file.startsWith("tools/package/")) return "js";
  if (file.startsWith("packages/python/odoo/")) return "odoo";
  if (file.startsWith("packages/python/")) return "python";
  if (file.startsWith("packages/ruby/")) return "ruby";
  if (file.startsWith("packages/php/")) return "php";
  if (file.startsWith("packages/dotnet/")) return "dotnet";
  return null;
}

// --- plumbing ------------------------------------------------------------------

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256e6, ...options });
}

function blob(spec) {
  const result = spawnSync("git", ["cat-file", "-p", spec], { cwd: ROOT, maxBuffer: 256e6 });
  return result.status === 0 ? result.stdout : null;
}

const BASE = mkdtempSync(path.join(tmpdir(), "bug-zoo-"));
const RUN_ID = `bug-zoo-${process.pid}`;
const children = new Set();
const containers = new Set();
const composeProjects = new Set();
const dockerImages = new Set();
let cleaned = false;

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) killTree(child);
  for (const name of containers) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  for (const name of composeProjects) {
    spawnSync("docker", ["compose", "-p", name, "down", "-v", "--remove-orphans"], {
      stdio: "ignore",
    });
  }
  for (const name of dockerImages) {
    spawnSync("docker", ["image", "rm", "-f", name], { stdio: "ignore" });
  }
  if (opts.keep) {
    console.error(`bug-zoo: keeping ${BASE}`);
    return;
  }
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.error(`bug-zoo: ${signal}, cleaning up`);
    cleanup();
    process.exit(130);
  });
}
process.on("uncaughtException", (error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});

/** Spawn in its own process group, with output to a log file. */
function exec(argv, { cwd, env, timeoutMs, logPath }) {
  return new Promise((resolve) => {
    const fd = openSync(logPath, "w");
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    children.add(child);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (code, signal, spawnError) => {
      clearTimeout(timer);
      children.delete(child);
      closeSync(fd);
      resolve({ code, signal, timedOut, log: readFileSync(logPath, "utf8"), spawnError });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, signal) => finish(code, signal));
  });
}

const SECRET_ENV = /^(NWC_URI|LSC_URI|OPENRECEIVE_|DATABASE_URL|NODE_OPTIONS$)/;

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

const hasSystemdRun =
  spawnSync("systemd-run", ["--user", "--scope", "--collect", "-q", "true"], { stdio: "ignore" })
    .status === 0;

/** Node's assert can OOM the machine on a failing DOM comparison; a memory-capped scope stops it. */
function scoped(argv) {
  if (!hasSystemdRun) return argv;
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    "-q",
    "-p",
    "MemoryMax=20G",
    "-p",
    "MemorySwapMax=0",
    ...argv,
  ];
}

function makePool(limit) {
  const waiting = [];
  let running = 0;
  const release = () => {
    running--;
    const next = waiting.shift();
    if (next) next();
  };
  return async function pooled(work) {
    if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
    running++;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

/** First line of output that reads like the reason something failed. */
function firstReason(output) {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const interesting = lines.filter((line) =>
    /(error|cannot|not found|failed|undefined|fatal|exception)/i.test(line),
  );
  return (interesting[0] ?? lines[0] ?? "").trim().slice(0, 300);
}

// --- temp copies ---------------------------------------------------------------

const TEMPLATE = path.join(BASE, "template");

function shell(script, env = {}) {
  execFileSync("bash", ["-c", script], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
}

/** The checkout as it stands: tracked files plus uncommitted ones, node_modules hard-linked. */
function makeTemplate() {
  mkdirSync(TEMPLATE, { recursive: true });
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter((file) => file && existsSync(path.join(ROOT, file)));
  const list = path.join(BASE, "files.lst");
  writeFileSync(list, listed.join("\0"));
  shell('set -euo pipefail; tar -cf - --null -T "$LIST" | tar -xf - -C "$T"', {
    LIST: list,
    T: TEMPLATE,
  });
  // Hard links are safe: nothing the suites run rewrites a file inside
  // node_modules in place. Fall back to a real copy across filesystems.
  const nodeModules = path.join(ROOT, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error("node_modules is missing: run `npm ci` first");
  }
  shell('cp -al "$S" "$D/" || cp -a "$S" "$D/"', { S: nodeModules, D: TEMPLATE });
  // The two workspace node_modules that live beside their package. Small; copy.
  const nested = spawnSync(
    "bash",
    ["-c", "find packages examples -name node_modules -type d -prune"],
    { cwd: ROOT, encoding: "utf8" },
  );
  for (const rel of nested.stdout.split("\n").filter(Boolean)) {
    mkdirSync(path.dirname(path.join(TEMPLATE, rel)), { recursive: true });
    execFileSync("cp", ["-a", path.join(ROOT, rel), path.join(TEMPLATE, path.dirname(rel))]);
  }
}

/** Build what `npm test` builds, so packages tests import by name exist. */
async function buildJs(dir, name) {
  const logPath = path.join(BASE, `${name}.build.log`);
  const result = await exec(["npm", "run", "pretest:js"], {
    cwd: dir,
    env: cleanEnv(),
    timeoutMs: 10 * 60_000,
    logPath,
  });
  return result.code === 0 ? null : firstReason(result.log);
}

function copyOfTemplate(name) {
  const dir = path.join(BASE, name);
  mkdirSync(dir);
  shell('set -euo pipefail; tar -cf - --exclude=./node_modules -C "$T" . | tar -xf - -C "$D"', {
    T: TEMPLATE,
    D: dir,
  });
  shell('cp -al "$T/node_modules" "$D/" || cp -a "$T/node_modules" "$D/"', {
    T: TEMPLATE,
    D: dir,
  });
  return dir;
}

// --- undoing a fix ---------------------------------------------------------------

function undoFile(commit, rel, dir, { ours = false } = {}) {
  const target = path.join(dir, rel);
  const fixed = blob(`${commit.sha}:${rel}`);
  const before = blob(`${commit.sha}^:${rel}`);
  const current = existsSync(target) ? readFileSync(target) : null;
  if (before === null) {
    if (current === null) return { ok: true, note: "gone at HEAD" };
    if (fixed !== null && current.equals(fixed)) {
      unlinkSync(target);
      return { ok: true, changed: true };
    }
    return { ok: false, why: `${rel}: the fix added it and it has changed since` };
  }
  if (fixed === null) {
    if (current !== null)
      return { ok: false, why: `${rel}: the fix deleted it but it exists again` };
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, before);
    return { ok: true, changed: true };
  }
  if (current === null) return { ok: false, why: `${rel}: no longer exists at HEAD` };

  // Three-way: the file now, with the fix's own change reversed.
  const work = mkdtempSync(path.join(BASE, "merge-"));
  try {
    const oursPath = path.join(work, "ours");
    const base = path.join(work, "base");
    const theirs = path.join(work, "theirs");
    writeFileSync(oursPath, current);
    writeFileSync(base, fixed);
    writeFileSync(theirs, before);
    const args = ["merge-file", "-q", "-p", ...(ours ? ["--ours"] : []), oursPath, base, theirs];
    const result = spawnSync("git", args, { cwd: work, maxBuffer: 256e6 });
    if (result.status !== 0) {
      return {
        ok: false,
        why:
          result.status === 255
            ? `${rel}: cannot merge (binary?)`
            : `${rel}: ${result.status} hunk(s) no longer apply at HEAD`,
      };
    }
    if (result.stdout.equals(current)) return { ok: true, note: `${rel}: already the same` };
    writeFileSync(target, result.stdout);
    return { ok: true, changed: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function applyOverrideEdits(commit, rel, spec, dir) {
  const target = path.join(dir, rel);
  if (spec === "auto") return undoFile(commit, rel, dir);
  if (spec === "keep") return { ok: true, note: `${rel}: kept as at HEAD`, kept: true };
  if (!existsSync(target)) return { ok: false, why: `override: ${rel} does not exist at HEAD` };
  const edits = Array.isArray(spec) ? spec : (spec.edits ?? []);
  if (!Array.isArray(spec) && spec.ours) {
    // Undo every hunk that still reverses; a hunk later commits rewrote keeps HEAD.
    const merged = undoFile(commit, rel, dir, { ours: true });
    if (!merged.ok) return merged;
  }
  let content = readFileSync(target, "utf8");
  for (const edit of edits) {
    const expected = edit.count ?? 1;
    const seen = content.split(edit.find).length - 1;
    if (seen !== expected) {
      return {
        ok: false,
        why: `override for ${rel} is stale: found "${edit.find.slice(0, 60)}" ${seen} time(s), expected ${expected}`,
      };
    }
    content = content.replaceAll(edit.find, edit.replace);
  }
  writeFileSync(target, content);
  return { ok: true, changed: true, override: true };
}

function overrideFor(commit) {
  const entry = Object.entries(OVERRIDES).find(([prefix]) => commit.sha.startsWith(prefix));
  return entry?.[1] ?? null;
}

/** Undo one engine's slice of a commit (and the commit's shared files) in dir. */
function undoSlice(task, dir) {
  const override = task.override ?? overrideFor(task.commit);
  const reverted = [];
  const notes = override?.note ? [override.note] : [];
  const problems = [];
  let method = "auto";
  for (const rel of task.files) {
    const spec = override?.files?.[rel];
    let outcome;
    if (spec !== undefined) {
      if (spec !== "auto") method = "override";
      outcome = applyOverrideEdits(task.commit, rel, spec, dir);
    } else {
      outcome = undoFile(task.commit, rel, dir);
    }
    if (outcome.ok) {
      if (outcome.changed) reverted.push(rel);
      if (outcome.note) notes.push(outcome.note);
    } else if (engineFor(rel) === null) {
      // A file outside every engine (plugin manifests, the demo apps) is not
      // what the engine's suite tests; it never blocks the verdict.
      notes.push(`left as at HEAD: ${outcome.why}`);
    } else {
      problems.push(outcome.why);
    }
  }
  if (problems.length > 0) return { ok: false, why: problems.join("; "), method, reverted, notes };
  if (!reverted.some((rel) => engineFor(rel) !== null)) {
    return {
      ok: false,
      why: "nothing left to undo at HEAD (the fix's lines already changed)",
      method,
      reverted,
      notes,
    };
  }
  return { ok: true, method, reverted, notes };
}

// --- running one engine's suite ---------------------------------------------------

const SUITE_TIMEOUT_MS = 25 * 60_000;
// A reverted fix can hang a test instead of failing it; name the test.
const JS_TEST_TIMEOUT_MS = 180_000;

/** Node suite: { failures: [...] } or { infra: reason } when the suite never really ran. */
async function runJs({ dir, name }, previous) {
  const files = previous
    ? [...new Set(previous.map((failure) => failure.file))]
    : readdirSync(path.join(dir, "tests"))
        .filter((file) => file.endsWith(".test.mjs"))
        .sort()
        .map((file) => `tests/${file}`);
  const results = path.join(BASE, `${name}.results.jsonl`);
  const log = path.join(BASE, `${name}.log`);
  const run = await exec(
    scoped([
      "node",
      "--import",
      "tsx",
      "--test",
      `--test-concurrency=${JS_CONCURRENCY}`,
      `--test-timeout=${JS_TEST_TIMEOUT_MS}`,
      `--test-reporter=${REPORTER}`,
      `--test-reporter-destination=${results}`,
      "--test-reporter=dot",
      "--test-reporter-destination=stdout",
      ...files,
    ]),
    { cwd: dir, env: cleanEnv(), timeoutMs: SUITE_TIMEOUT_MS, logPath: log },
  );
  if (run.timedOut) return { infra: "JS suite timed out" };
  const events = existsSync(results)
    ? readFileSync(results, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const stderrByFile = new Map();
  for (const event of events.filter((item) => item.type === "stderr")) {
    stderrByFile.set(event.file, `${stderrByFile.get(event.file) ?? ""}${event.message}`);
  }
  const failures = events
    .filter((item) => item.type === "fail")
    .map((item) => {
      const file = path.relative(dir, item.file ?? path.join(dir, item.name));
      const isLoad = (item.nesting ?? 0) === 0 && item.name?.endsWith(".test.mjs");
      const stderr = stderrByFile.get(item.file ?? "") ?? stderrByFile.get(file) ?? "";
      return {
        id: `${file} > ${item.name}`,
        file,
        test: item.name,
        kind: isLoad ? "load" : item.kind === "testTimeoutFailure" ? "timeout" : "test",
        detail: (isLoad ? firstReason(stderr) : item.message).slice(0, 400),
      };
    });
  if (run.code !== 0 && failures.length === 0) {
    return { infra: firstReason(run.log) || `node --test exited ${run.code}` };
  }
  return { failures };
}

/** The test half of tools/ci/python-tests.sh, keeping its lint half out of the verdict. */
function stripPythonLint(dir) {
  const script = path.join(dir, "tools/ci/python-tests.sh");
  const source = readFileSync(script, "utf8");
  const marker = "# Keep local release verification";
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`python-tests.sh no longer has the marker "${marker}"`);
  writeFileSync(script, source.slice(0, at));
}

// The project's addopts already pass -q; on top of the script's -q, pytest would
// print no summary at all. -rfE keeps the FAILED/ERROR lines this tool reads.
const PYTEST_ENV = () => cleanEnv({ PYTEST_ADDOPTS: "-rfE --tb=short" });

async function runPython({ dir, name }, previous) {
  if (previous) {
    const ids = [...new Set(previous.map((failure) => failure.id))];
    const log = path.join(BASE, `${name}.log`);
    const run = await exec(
      [
        "uv",
        "run",
        "--project",
        "packages/python/openreceive",
        "--frozen",
        "--no-sync",
        "pytest",
        "-q",
        "--tb=short",
        ...ids,
      ],
      { cwd: dir, env: PYTEST_ENV(), timeoutMs: SUITE_TIMEOUT_MS, logPath: log },
    );
    if (run.timedOut) return { infra: "pytest re-run timed out" };
    return { failures: parsePytest(run.log) };
  }
  stripPythonLint(dir);
  const log = path.join(BASE, `${name}.log`);
  const run = await exec(["bash", "tools/ci/python-tests.sh"], {
    cwd: dir,
    env: PYTEST_ENV(),
    timeoutMs: SUITE_TIMEOUT_MS,
    logPath: log,
  });
  if (run.timedOut) return { infra: "Python suite timed out" };
  const failures = parsePytest(run.log);
  const conformance = run.log.match(/python conformance failed: (.*)/);
  if (conformance) {
    failures.push({
      id: `tools/conformance/python-crosslang.py > ${conformance[1].slice(0, 200)}`,
      file: "tools/conformance/python-crosslang.py",
      test: conformance[1].slice(0, 200),
      kind: "test",
      detail: conformance[1],
    });
  }
  if (run.code !== 0 && failures.length === 0) {
    return { infra: firstReason(run.log) || `python-tests.sh exited ${run.code}` };
  }
  return { failures };
}

function parsePytest(output) {
  const failures = [];
  const seen = new Set();
  for (const line of output.split("\n")) {
    // The summary lines only: "FAILED path/to/test.py::name[param] - message".
    // A captured log line ("ERROR    websockets.server:server.py:611 ...") has
    // no test path, and a parametrized id can contain spaces, so only " - " ends it.
    const match = line.match(/^(FAILED|ERROR) (\S+\.py(?:::.*?)?)(?:\s+-\s+(.*))?$/);
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    failures.push({
      id: match[2],
      file: match[2].split("::")[0],
      test: match[2].split("::").slice(1).join("::") || match[2],
      kind: match[1] === "ERROR" ? "load" : "test",
      detail: (match[3] ?? "").slice(0, 400),
    });
  }
  return failures;
}

async function runPhp({ dir, name }) {
  const log = path.join(BASE, `${name}.log`);
  const run = await exec(["bash", "-x", "tools/ci/php-tests.sh"], {
    cwd: dir,
    env: cleanEnv({ COMPOSER_NO_INTERACTION: "1" }),
    timeoutMs: SUITE_TIMEOUT_MS,
    logPath: log,
  });
  if (run.timedOut) return { infra: "PHP suite timed out" };
  const failures = parsePhp(run.log);
  if (run.code !== 0 && failures.length === 0) {
    return { infra: firstReason(run.log) || `php-tests.sh exited ${run.code}` };
  }
  return { failures };
}

/**
 * A PHP Error naming a class or an OpenReceive function that no longer exists:
 * the test reaches for a name the undo removed. An undefined method on a test's
 * own stand-in object is the bug itself (FOSSBilling 0.8.0 had no repository).
 */
function isMissingName(line) {
  return /^(Error|TypeError|ParseError)\b.*(not found|undefined (method|function|constant) OpenReceive\\)/.test(
    line ?? "",
  );
}

function parsePhp(output) {
  const failures = [];
  const seen = new Set();
  const lines = output.split("\n");
  lines.forEach((line, index) => {
    const match = line.match(/^\d+\)\s+([\w\\:]+::\w+.*)$/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      failures.push({
        id: match[1],
        file: match[1].split("::")[0],
        test: match[1],
        kind: isMissingName(lines[index + 1]) ? "load" : "test",
        detail: (lines[index + 1] ?? "").slice(0, 400),
      });
    }
    const crosslang = line.match(/^(.*parity failed.*)$/);
    if (crosslang) {
      failures.push({
        id: `tools/conformance/php-crosslang.php > ${crosslang[1].slice(0, 200)}`,
        file: "tools/conformance/php-crosslang.php",
        test: crosslang[1].slice(0, 200),
        kind: "test",
        detail: crosslang[1].slice(0, 400),
      });
    }
  });
  return failures;
}

let bundleDirReady = null;

function rubyArgv(name, dir) {
  const container = `${RUN_ID}-${name}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  containers.add(container);
  const uid = process.getuid();
  const gid = process.getgid();
  return {
    container,
    argv: [
      "docker",
      "run",
      "--rm",
      "--name",
      container,
      "--user",
      `${uid}:${gid}`,
      "-e",
      "HOME=/tmp",
      "-e",
      "BUNDLE_PATH=/bundle",
      "-e",
      "BUNDLE_FROZEN=true",
      "-e",
      "NWC_URI=",
      "-v",
      `${dir}:/app`,
      "-v",
      `${bundleDirReady}:/bundle`,
      "-w",
      "/app",
      "ruby:3.4",
      "bash",
      "-c",
      "bundle install --jobs 4 --quiet && bundle exec bash -x ./tools/ci/ruby-tests.sh",
    ],
  };
}

/**
 * ruby-tests.sh stops at the first failing file. Run every file here, so the
 * catch names the test that pins the fix, not whichever file ran first.
 */
function keepGoingPastFailingFiles(dir) {
  const script = path.join(dir, "tools/ci/ruby-tests.sh");
  const source = readFileSync(script, "utf8");
  if (!source.includes("set -euo pipefail")) {
    throw new Error("ruby-tests.sh no longer starts with set -euo pipefail");
  }
  writeFileSync(script, source.replace("set -euo pipefail", "set -uo pipefail"));
}

async function runRuby({ dir, name }) {
  keepGoingPastFailingFiles(dir);
  if (!bundleDirReady) {
    bundleDirReady = path.join(BASE, "ruby-bundle");
    mkdirSync(bundleDirReady, { recursive: true });
  }
  const log = path.join(BASE, `${name}.log`);
  const { argv, container } = rubyArgv(name, dir);
  const run = await exec(argv, {
    cwd: dir,
    env: cleanEnv(),
    timeoutMs: SUITE_TIMEOUT_MS,
    logPath: log,
  });
  containers.delete(container);
  if (run.timedOut) {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    return { infra: "Ruby suite timed out" };
  }
  const failures = parseRuby(run.log);
  if (run.code !== 0 && failures.length === 0) {
    return { infra: firstReason(run.log) || `ruby-tests.sh exited ${run.code}` };
  }
  return { failures };
}

function parseRuby(output) {
  const failures = [];
  const seen = new Set();
  const lines = output.split("\n");
  // The test file being run; a file that prints an error and no "N runs" line
  // never got as far as running a test.
  let current = null;
  const finishFile = () => {
    if (current && !current.ranTests && current.errorLine && !current.file.includes("crosslang")) {
      failures.push({
        id: `${current.file} (did not load)`,
        file: current.file,
        test: current.file,
        kind: "load",
        detail: current.errorLine.slice(0, 400),
      });
    }
  };
  lines.forEach((line, index) => {
    const traced =
      line.match(/\+ ruby .*?(\S+_test\.rb)['"]?$/) ?? line.match(/\+ ruby .*\s(\S+\.rb)$/);
    if (traced) {
      finishFile();
      current = { file: traced[1], ranTests: false, errorLine: null };
    }
    if (current && /^\d+ runs, \d+ assertions/.test(line.trim())) current.ranTests = true;
    else if (
      current &&
      !current.errorLine &&
      !line.startsWith("+") &&
      /(Error|cannot load|undefined)/.test(line)
    ) {
      current.errorLine = line.trim();
    }
    const header = line.match(/^\s*(?:\d+\)\s*)?(Failure|Error):\s*$/);
    if (header) {
      const named = (lines[index + 1] ?? "").match(/^\s*([\w:]+#\w+)(?:\s+\[.*\])?:?/);
      if (named && !seen.has(named[1])) {
        seen.add(named[1]);
        failures.push({
          id: named[1],
          file: current?.file ?? "",
          test: named[1],
          kind: header[1] === "Error" ? "error" : "test",
          detail: (lines[index + 2] ?? "").slice(0, 400),
        });
      }
    }
    if (/parity failed/.test(line) && current?.file.includes("crosslang")) {
      const text = line.trim().slice(0, 200);
      if (!seen.has(text)) {
        seen.add(text);
        failures.push({
          id: `tools/conformance/ruby-crosslang.rb > ${text}`,
          file: "tools/conformance/ruby-crosslang.rb",
          test: text,
          kind: "test",
          detail: text,
        });
      }
    }
  });
  finishFile();
  return failures;
}

/**
 * Compose's default networks draw from the daemon's address pools, and other
 * compose stacks on the host can use them all up. A run-specific /24 outside
 * those pools sidesteps that; the script's `down -v` removes it again.
 */
function patchOdooComposeNetwork(dir) {
  const composePath = path.join(dir, "packages/python/odoo/docker/compose.yml");
  const compose = readFileSync(composePath, "utf8").replace(/\nnetworks:\n[\s\S]*$/, "\n");
  const subnet = `10.${210 + Math.floor(Math.random() * 40)}.${Math.floor(Math.random() * 250)}.0/24`;
  writeFileSync(
    composePath,
    `${compose}\nnetworks:\n  default:\n    ipam:\n      config:\n        - subnet: ${subnet}\n`,
  );
}

async function runOdoo({ dir, name }) {
  patchOdooComposeNetwork(dir);
  const script = path.join(dir, "tools/ci/odoo-tests.sh");
  const source = readFileSync(script, "utf8");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a bash line, matched literally
  const projectLine = 'project="or-odoo-test-${ODOO%%.*}"';
  const project = `${RUN_ID}-odoo-${name.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`.toLowerCase();
  const odooLog = path.join(dir, "odoo-run.log");
  if (source.includes(projectLine)) {
    if (!source.includes("log=$(mktemp)")) throw new Error("odoo-tests.sh changed its log line");
    writeFileSync(
      script,
      source
        .replace(projectLine, `project="${project}"`)
        .replace("log=$(mktemp)", `log="${odooLog}"`),
    );
  } else if (!source.includes(`project="${RUN_ID}-odoo-`)) {
    throw new Error("odoo-tests.sh no longer sets the compose project name the zoo expects");
  }
  composeProjects.add(project);
  dockerImages.add(`${project}-odoo`);
  const log = path.join(BASE, `${name}.log`);
  const run = await exec(["bash", "-x", "tools/ci/odoo-tests.sh"], {
    cwd: dir,
    env: cleanEnv(),
    timeoutMs: 30 * 60_000,
    logPath: log,
  });
  if (run.timedOut) return { infra: "Odoo suite timed out" };
  const failures = [];
  for (const line of run.log.split("\n")) {
    const match =
      line.match(/\bFAIL: (\S+)/) ?? line.match(/\bERROR: (\S+)/) ?? line.match(/^(FAILED \S+)/);
    if (match && !failures.some((failure) => failure.id === match[1])) {
      failures.push({
        id: match[1],
        file: "packages/python/odoo",
        test: match[1],
        kind: "test",
        detail: line.trim().slice(0, 300),
      });
    }
  }
  if (run.code !== 0 && failures.length === 0) {
    const inner = existsSync(odooLog) ? readFileSync(odooLog, "utf8") : "";
    const tail = (inner || run.log).split("\n").slice(-15).join(" | ");
    return { infra: `odoo-tests.sh exited ${run.code}: ${tail.slice(-800)}` };
  }
  return { failures };
}

const SUITES = { js: runJs, python: runPython, php: runPhp, ruby: runRuby, odoo: runOdoo };

// --- the plan --------------------------------------------------------------------

function selectCommits() {
  const lines = git([
    "log",
    "--reverse",
    "--no-merges",
    "--format=%H%x09%s",
    RANGE,
    "--",
    "packages/",
  ])
    .split("\n")
    .filter(Boolean);
  const commits = [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (!/^fix\b/.test(subject)) continue;
    if (ONLY && !ONLY.some((prefix) => sha.startsWith(prefix))) continue;
    commits.push({ sha, short: sha.slice(0, 8), subject });
  }
  return commits;
}

function commitFiles(commit) {
  return git(["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", commit.sha])
    .split("\n")
    .filter(Boolean);
}

function planCommit(commit) {
  const files = commitFiles(commit);
  for (const rule of OUT_OF_SCOPE) {
    const hit = files.find((file) => rule.pattern.test(file));
    if (hit) return { scope: { reason: rule.reason, file: hit }, slices: [] };
  }
  const fixFiles = files.filter(isFixFile);
  const byEngine = new Map();
  const shared = [];
  for (const file of fixFiles) {
    const engine = engineFor(file);
    if (engine === null) shared.push(file);
    else byEngine.set(engine, [...(byEngine.get(engine) ?? []), file]);
  }
  const slices = [...byEngine.entries()]
    .filter(([engine]) => !ENGINE_FILTER || ENGINE_FILTER.has(engine))
    .map(([engine, engineFiles]) => ({ engine, files: [...engineFiles, ...shared] }));
  return { scope: null, slices, testFiles: files.filter((file) => !isFixFile(file)) };
}

// --- running ---------------------------------------------------------------------

const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

function logLine(text) {
  console.error(`[${elapsed()}] ${text}`);
}

function needsJsBuild(reverted) {
  return reverted.some(
    (file) => file.startsWith("packages/js/") || file.startsWith("tools/package/"),
  );
}

async function runSuite(engine, context, previous) {
  const run = SUITES[engine];
  if (!run) return { infra: `no local suite for the ${engine} engine` };
  try {
    return await run(context, previous);
  } catch (error) {
    return { infra: error.message };
  }
}

async function baselineFor(engine, pool) {
  return pool(async () => {
    const name = `baseline-${engine}`;
    const dir = copyOfTemplate(name);
    try {
      logLine(`baseline ${engine}: running`);
      let first = await runSuite(engine, { dir, name });
      if (first.infra && engine === "odoo") {
        // A busy Docker daemon (compose network pools, image layers) is not a verdict.
        first = await runSuite(engine, { dir, name: `${name}-infra-retry` });
      }
      if (first.infra) return { infra: first.infra };
      let failures = first.failures;
      if (failures.length > 0) {
        const second = await runSuite(engine, { dir, name: `${name}-retry` }, failures);
        failures = second.infra ? failures : second.failures;
      }
      logLine(`baseline ${engine}: ${failures.length} failing`);
      return { failures };
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

function reportRow(task, verdict, fields = {}) {
  return {
    commit: task.commit.short,
    sha: task.commit.sha,
    subject: task.variant ? `${task.commit.subject} [${task.variant}]` : task.commit.subject,
    variant: task.variant ?? null,
    engine: task.engine,
    verdict,
    method: fields.method ?? "auto",
    reverted: fields.reverted ?? [],
    notes: fields.notes ?? [],
    failures: fields.failures ?? [],
    flaky: fields.flaky ?? [],
    why: fields.why ?? null,
    seconds: fields.seconds ?? null,
  };
}

let taskCounter = 0;

async function runTask(task, baseline) {
  // Two files can share a basename, so the counter keeps each copy's name unique.
  taskCounter++;
  const name = `${task.commit.short}-${task.engine}${
    task.variant ? `-${task.variant}` : ""
  }-${taskCounter}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const start = Date.now();
  const engineBaseline = baseline.get(task.engine);
  if (engineBaseline?.infra) {
    return reportRow(task, "NOT RUN", {
      why: `the suite cannot run on this machine right now: ${engineBaseline.infra}`,
    });
  }
  const dir = copyOfTemplate(name);
  try {
    const undo = undoSlice(task, dir);
    if (!undo.ok) return reportRow(task, "NOT REVERSIBLE", { ...undo });
    if (task.engine === "js" && needsJsBuild(undo.reverted)) {
      const buildError = await buildJs(dir, name);
      if (buildError) {
        return reportRow(task, "NOT REVERSIBLE", {
          ...undo,
          why: `with the fix undone the JS packages do not build: ${buildError}`,
        });
      }
    }
    let first = await runSuite(task.engine, { dir, name });
    if (first.infra && task.engine === "odoo") {
      first = await runSuite(task.engine, { dir, name: `${name}-infra-retry` });
    }
    if (first.infra) {
      return reportRow(task, "NOT REVERSIBLE", {
        ...undo,
        why: `suite could not run with the fix undone: ${first.infra}`,
      });
    }
    const known = engineBaseline?.failureIds ?? new Set();
    const newFailures = first.failures.filter((failure) => !known.has(failure.id));
    if (newFailures.length === 0) {
      return reportRow(task, "NOT CAUGHT", { ...undo, seconds: (Date.now() - start) / 1000 });
    }
    // Flakes do not count: the failures must reproduce on a second run.
    const second = await runSuite(task.engine, { dir, name: `${name}-retry` }, newFailures);
    if (second.infra) {
      return reportRow(task, "CAUGHT", {
        ...undo,
        failures: newFailures,
        notes: [...undo.notes, `re-run did not complete: ${second.infra}`],
        seconds: (Date.now() - start) / 1000,
      });
    }
    const reproduced = newFailures.filter((failure) =>
      second.failures.some((again) => again.id === failure.id),
    );
    const flaky = newFailures.filter((failure) => !reproduced.includes(failure));
    if (reproduced.length === 0) {
      return reportRow(task, "NOT CAUGHT", {
        ...undo,
        flaky,
        why: "failures did not reproduce on a second run",
        seconds: (Date.now() - start) / 1000,
      });
    }
    return reportRow(task, "CAUGHT", {
      ...undo,
      failures: reproduced,
      flaky,
      seconds: (Date.now() - start) / 1000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// --- output ----------------------------------------------------------------------

function clip(text, width) {
  const value = String(text ?? "");
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function catcher(row) {
  if (row.verdict === "REVERSIBLE") return "";
  if (row.verdict === "CAUGHT") {
    const first = row.failures[0];
    const more = row.failures.length > 1 ? ` (+${row.failures.length - 1} more)` : "";
    const kind = row.failures.every((f) => f.kind === "load") ? " [load-only]" : "";
    const named = first.test.includes(first.file) ? first.test : `${first.file} > ${first.test}`;
    return `${named}${more}${kind}`;
  }
  return row.why ?? "all tests passed";
}

function printTable(rows) {
  const columns = [
    { title: "commit", get: (r) => r.commit, width: 8 },
    { title: "part", get: (r) => r.variant ?? "", width: 20 },
    { title: "engine", get: (r) => r.engine, width: 7 },
    { title: "verdict", get: (r) => r.verdict, width: 14 },
    { title: "via", get: (r) => (r.method === "override" ? "manual" : ""), width: 6 },
    { title: "subject", get: (r) => r.subject, width: 58 },
    { title: "caught by / why", get: catcher, width: 130 },
  ];
  const header = columns.map((c) => c.title.padEnd(c.width)).join("  ");
  console.log(header);
  console.log(columns.map((c) => "-".repeat(c.width)).join("  "));
  for (const row of rows) {
    console.log(columns.map((c) => clip(c.get(row), c.width).padEnd(c.width)).join("  "));
  }
}

async function main() {
  const head = git(["rev-parse", "HEAD"]).trim();
  const commits = selectCommits();
  const planned = commits.map((commit) => ({ commit, ...planCommit(commit) }));
  const outOfScope = planned.filter((item) => item.scope);
  const tasks = planned.flatMap(({ commit, slices }) => {
    if (opts["per-file"]) {
      return slices.flatMap((slice) => {
        const own = slice.files.filter((file) => engineFor(file) === slice.engine);
        if (own.length < 2) return [];
        return own.map((file) => ({
          commit,
          engine: slice.engine,
          variant: `file:${path.basename(file)}`,
          files: [file],
          override: { note: `only ${file} undone`, files: { [file]: "auto" } },
        }));
      });
    }
    return [
      ...slices.map((slice) => ({ commit, engine: slice.engine, files: slice.files })),
      // A commit that made several separate fixes is also undone one fix at a
      // time, by hand: a commit-level catch can come from just one of them.
      ...VARIANTS.filter(
        (variant) =>
          commit.sha.startsWith(variant.commit) &&
          (!ENGINE_FILTER || ENGINE_FILTER.has(variant.engine)),
      ).map((variant) => ({
        commit,
        engine: variant.engine,
        variant: variant.label,
        files: Object.keys(variant.files),
        override: { note: variant.note, files: variant.files },
      })),
    ];
  });
  const engines = [...new Set(tasks.map((task) => task.engine))];
  console.error(
    `Range ${RANGE} at ${head.slice(0, 8)}: ${commits.length} fix commits touching packages/, ` +
      `${tasks.length} engine slices (${engines.join(", ")}), ${outOfScope.length} out of scope.`,
  );
  for (const item of outOfScope) {
    console.error(
      `  out of scope: ${item.commit.short} ${item.commit.subject} (${item.scope.reason})`,
    );
  }
  const unknown = tasks.filter((task) => !SUITES[task.engine]);
  if (unknown.length) {
    console.error(`No local suite for: ${[...new Set(unknown.map((t) => t.engine))].join(", ")}`);
  }

  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  makeTemplate();

  const rows = [];
  if (opts.plan) {
    for (const task of tasks) {
      const dir = path.join(BASE, `plan-${task.commit.short}-${task.engine}`);
      mkdirSync(dir, { recursive: true });
      const files = task.files.map((file) => ({ file, tmpl: path.join(TEMPLATE, file) }));
      for (const { file, tmpl } of files) {
        if (existsSync(tmpl)) {
          mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
          execFileSync("cp", ["-a", tmpl, path.join(dir, file)]);
        }
      }
      const undo = undoSlice(task, dir);
      rows.push(reportRow(task, undo.ok ? "REVERSIBLE" : "NOT REVERSIBLE", { ...undo }));
      rmSync(dir, { recursive: true, force: true });
    }
    printTable(rows);
    return;
  }

  logLine("building the template (npm run pretest:js)");
  const templateBuildError = await buildJs(TEMPLATE, "template");
  if (templateBuildError)
    throw new Error(`JS packages do not build at HEAD: ${templateBuildError}`);

  const pool = makePool(JOBS);
  const runnable = tasks.filter((task) => SUITES[task.engine]);
  const baseline = new Map();
  let done = 0;

  // Baselines first: a test that fails with nothing undone cannot catch anything,
  // and Docker's first bundle install must be done before other Ruby runs share
  // the bundle directory. Baselines run at the same time as each other.
  async function baselines(names, usePool) {
    await Promise.all(
      names.map(async (engine) => {
        const result = await baselineFor(engine, usePool);
        if (result.infra) {
          console.error(`baseline ${engine} did not run: ${result.infra}`);
          baseline.set(engine, { failures: [], failureIds: new Set(), infra: result.infra });
          return;
        }
        baseline.set(engine, {
          failures: result.failures,
          failureIds: new Set(result.failures.map((failure) => failure.id)),
        });
        if (result.failures.length > 0) {
          console.error(`baseline ${engine} failures (excluded from verdicts):`);
          for (const failure of result.failures) console.error(`  ${failure.id}`);
        }
      }),
    );
  }

  async function runTasks(list, usePool) {
    await Promise.all(
      list.map((task) =>
        usePool(async () => {
          logLine(`START ${task.commit.short} ${task.engine}: ${task.commit.subject}`);
          // One task's surprise must not lose every other result.
          const row = await runTask(task, baseline).catch((error) =>
            reportRow(task, "NOT RUN", { why: `the zoo itself failed: ${error.message}` }),
          );
          rows.push(row);
          done++;
          logLine(
            `[${done}/${runnable.length}] ${row.commit} ${row.engine} ${row.verdict} ${clip(catcher(row), 90)}`,
          );
        }),
      ),
    );
  }

  // Odoo needs Docker to build an image and start a database; other sessions'
  // compose stacks share the daemon's network pool, so it runs by itself after
  // everything else.
  const nonOdooEngines = engines.filter((name) => SUITES[name] && name !== "odoo");
  const nonOdooTasks = runnable.filter((task) => task.engine !== "odoo");
  await baselines(nonOdooEngines, pool);
  await runTasks(nonOdooTasks, pool);
  const odooTasks = runnable.filter((task) => task.engine === "odoo");
  if (odooTasks.length > 0) {
    const odooPool = makePool(1);
    await baselines(["odoo"], odooPool);
    await runTasks(odooTasks, odooPool);
  }

  for (const task of tasks.filter((t) => !SUITES[t.engine])) {
    rows.push(
      reportRow(task, "NOT REVERSIBLE", { why: `no local suite for the ${task.engine} engine` }),
    );
  }

  const order = new Map(commits.map((commit, index) => [commit.sha, index]));
  rows.sort((a, b) => order.get(a.sha) - order.get(b.sha) || a.engine.localeCompare(b.engine));

  console.log();
  printTable(rows);
  console.log();
  const counts = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  console.log(
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", "),
  );

  const report = {
    range: RANGE,
    head,
    generatedAt: new Date().toISOString(),
    dirtyFiles: dirty,
    outOfScope: outOfScope.map((item) => ({
      commit: item.commit.short,
      subject: item.commit.subject,
      reason: item.scope.reason,
      file: item.scope.file,
    })),
    baseline: Object.fromEntries(
      [...baseline.entries()].map(([engine, value]) => [engine, value.failures]),
    ),
    counts,
    results: rows,
  };
  mkdirSync(path.dirname(opts.json), { recursive: true });
  writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nJSON: ${path.relative(ROOT, path.resolve(opts.json))}`);
  console.error(`done in ${elapsed()}`);
}

main().then(
  () => {
    cleanup();
    process.exit(0);
  },
  (error) => {
    console.error(error);
    cleanup();
    process.exit(1);
  },
);
