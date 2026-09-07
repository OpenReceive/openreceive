#!/usr/bin/env node

// PyPI counterpart of gem-release.mjs. The Python distribution `openreceive`
// (packages/python/openreceive) releases in lockstep with the npm workspace
// version: `npm run release:prepare` writes src/openreceive/_version.py; this
// script plans, builds (uv build + twine check + a wheel-contents check) and,
// as the manual fallback, publishes. The REAL publisher is
// .github/workflows/publish-pypi.yml through PyPI Trusted Publishing, gated by
// the `pypi` environment's required approval.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PYTHON_PACKAGE_DIR = path.join("packages", "python", "openreceive");
export const PYTHON_VERSION_FILE = path.join(
  PYTHON_PACKAGE_DIR,
  "src",
  "openreceive",
  "_version.py",
);
export const PYTHON_DISTRIBUTION = "openreceive";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * PEP 440 at the boundary, and only there: the workspace speaks semver
 * (`0.5.0-alpha.1`), PyPI speaks PEP 440 (`0.5.0a1`). A prerelease label this
 * table does not know is refused rather than guessed — a wrong normalization
 * would publish a version pip sorts somewhere nobody intended.
 */
const PRERELEASE_LABELS = new Map([
  ["alpha", "a"],
  ["a", "a"],
  ["beta", "b"],
  ["b", "b"],
  ["rc", "rc"],
  ["c", "rc"],
  ["pre", "rc"],
  ["preview", "rc"],
]);

export function pep440Version(version) {
  const match = SEMVER_PATTERN.exec(version);
  assert(match, `not a semver version: ${version}`);
  const [, major, minor, patch, prerelease] = match;
  const release = `${major}.${minor}.${patch}`;
  if (prerelease === undefined) return release;
  const [label, number = "0", ...rest] = prerelease.split(".");
  const pep = PRERELEASE_LABELS.get(label.toLowerCase());
  assert(
    pep !== undefined && rest.length === 0 && /^\d+$/.test(number),
    `cannot express prerelease "${prerelease}" in PEP 440 (known labels: ${[...PRERELEASE_LABELS.keys()].join(", ")}, optionally followed by .N)`,
  );
  return `${release}${pep}${Number(number)}`;
}

export function readPythonVersion(root) {
  const file = path.join(root, PYTHON_VERSION_FILE);
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8").match(/^__version__ = "([^"]+)"$/m);
  return match?.[1];
}

/** `release:prepare` hook: rewrite _version.py; returns the changed paths. */
export function updatePythonVersion(root, targetVersion) {
  const file = path.join(root, PYTHON_VERSION_FILE);
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");
  const updated = source.replace(
    /^__version__ = "[^"]+"$/m,
    `__version__ = "${pep440Version(targetVersion)}"`,
  );
  if (updated === source) return [];
  writeFileSync(file, updated);
  return [PYTHON_VERSION_FILE];
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const key = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (equalsIndex !== -1) {
      args[key] = arg.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node tools/release/pypi-release.mjs plan",
    "  node tools/release/pypi-release.mjs build",
    "  node tools/release/pypi-release.mjs publish [--dry-run]",
    "",
    "Options:",
    "  --out <dir>       Output dir for the sdist + wheel (default: .release/pypi/<version>).",
    "  --dry-run         Print the publish command without uploading.",
    "  --allow-dirty     Allow publish from a dirty worktree.",
    "  --skip-tests      Skip npm run test:python during publish.",
    "  --root <dir>      Repository root, useful for tests.",
    "",
    "publish is the MANUAL fallback (uv publish with UV_PUBLISH_TOKEN); the release",
    "path is the v* tag → .github/workflows/publish-pypi.yml → approve the `pypi`",
    "environment in the browser.",
  ].join("\n");
}

function run(command, args, root, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function rootVersion(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert(SEMVER_PATTERN.test(manifest.version), "root package version must be semver");
  return manifest.version;
}

export function assertPythonVersionReady(root) {
  const version = rootVersion(root);
  const expected = pep440Version(version);
  const actual = readPythonVersion(root);
  assert(actual !== undefined, `${PYTHON_VERSION_FILE}: missing __version__`);
  assert.equal(
    actual,
    expected,
    `${PYTHON_VERSION_FILE}: __version__ ${actual} must be ${expected} (workspace ${version}; run npm run release:prepare)`,
  );
  return { version, pep440: expected };
}

function outDirFor(root, version, args) {
  return path.resolve(root, String(args.out ?? path.join(".release", "pypi", version)));
}

/**
 * What the wheel MUST carry. Hatchling needs an explicit include for package
 * data, and a broken include ships silently — the same reason the Ruby gem
 * build script exists. The Django static/migrations entries are asserted only
 * once those trees exist in the source (the Django track adds them).
 */
export function requiredWheelEntries(root) {
  const entries = [
    "openreceive/__init__.py",
    "openreceive/_version.py",
    "openreceive/cli.py",
    "openreceive/fastapi/router.py",
    "openreceive/fastapi/lifespan.py",
    "openreceive/storage/sql/ddl.py",
    "openreceive/testing/fake_wallet.py",
  ];
  const source = path.join(root, PYTHON_PACKAGE_DIR, "src", "openreceive", "django");
  if (existsSync(path.join(source, "migrations", "0001_initial.py"))) {
    entries.push("openreceive/django/migrations/0001_initial.py");
  }
  if (existsSync(path.join(source, "static", "openreceive", "MANIFEST.json"))) {
    entries.push("openreceive/django/static/openreceive/MANIFEST.json");
    entries.push("openreceive/django/static/openreceive/openreceive-checkout.js");
  }
  return entries;
}

function buildDistribution(root, args) {
  const { version, pep440 } = assertPythonVersionReady(root);
  const outDir = outDirFor(root, version, args);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const packageDir = path.join(root, PYTHON_PACKAGE_DIR);

  console.error(`building ${PYTHON_DISTRIBUTION} ${pep440} (workspace ${version})`);
  run("uv", ["build", "--out-dir", outDir], root, { cwd: packageDir, stdio: "inherit" });

  const files = readdirSync(outDir).sort();
  const wheel = files.find((file) => file === `${PYTHON_DISTRIBUTION}-${pep440}-py3-none-any.whl`);
  const sdist = files.find((file) => file === `${PYTHON_DISTRIBUTION}-${pep440}.tar.gz`);
  assert(
    wheel,
    `expected ${PYTHON_DISTRIBUTION}-${pep440}-py3-none-any.whl in ${outDir}, got ${files.join(", ")}`,
  );
  assert(
    sdist,
    `expected ${PYTHON_DISTRIBUTION}-${pep440}.tar.gz in ${outDir}, got ${files.join(", ")}`,
  );

  // Wheel contents: `unzip -l` lists every member; each required entry must be there.
  const listing = run("unzip", ["-l", path.join(outDir, wheel)], root);
  const missing = requiredWheelEntries(root).filter((entry) => !listing.includes(entry));
  assert(
    missing.length === 0,
    `${wheel} is missing ${missing.join(", ")} — check [tool.hatch.build.targets.wheel] include in pyproject.toml`,
  );
  // twine's metadata check (long description renders, required fields present).
  run(
    "uvx",
    ["twine", "check", "--strict", path.join(outDir, wheel), path.join(outDir, sdist)],
    root,
    {
      stdio: "inherit",
    },
  );
  return { version, pep440, outDir, wheel, sdist };
}

function gitStatus(root) {
  try {
    return run("git", ["status", "--porcelain"], root).trim();
  } catch {
    return "";
  }
}

function publishDistribution(root, args) {
  if (args["allow-dirty"] !== true && args["dry-run"] !== true) {
    assert(
      gitStatus(root).length === 0,
      "pypi publish requires a clean git worktree. Commit/stash changes or pass --allow-dirty.",
    );
  }
  if (args["dry-run"] === true) {
    console.error("dry-run: skipping `npm run test:python` — a real publish runs it first.");
  } else if (args["skip-tests"] !== true) {
    run("npm", ["run", "test:python"], root, { stdio: "inherit" });
  }
  const built = buildDistribution(root, args);
  const files = [built.wheel, built.sdist].map((file) => path.join(built.outDir, file));
  // --check-url makes a re-run after a partial upload skip what PyPI already holds.
  const publishArgs = [
    "publish",
    "--check-url",
    `https://pypi.org/simple/${PYTHON_DISTRIBUTION}/`,
    ...files,
  ];
  if (args["dry-run"] === true) {
    console.log(`dry-run: uv ${publishArgs.join(" ")}`);
    console.log(`Dry-run planned ${PYTHON_DISTRIBUTION} ${built.pep440}.`);
    return;
  }
  assert(
    process.env.UV_PUBLISH_TOKEN,
    "UV_PUBLISH_TOKEN is not set. The release path is the v* tag + publish-pypi.yml (trusted publishing); " +
      "this manual fallback needs a PyPI API token in UV_PUBLISH_TOKEN.",
  );
  run("uv", publishArgs, root, { stdio: "inherit" });
  console.log(`Published ${PYTHON_DISTRIBUTION} ${built.pep440}.`);
}

function printPlan(root, args) {
  const workspaceVersion = rootVersion(root);
  const expected = pep440Version(workspaceVersion);
  const actual = readPythonVersion(root);
  const ready = actual === expected;
  console.log(
    `OpenReceive PyPI release plan (workspace ${workspaceVersion} → PEP 440 ${expected}):`,
  );
  console.log(`- ${PYTHON_DISTRIBUTION}@${actual ?? "missing"} [${ready ? "ok" : "DRIFT"}]`);
  console.log(`artifacts: ${path.relative(root, outDirFor(root, workspaceVersion, args))}`);
  console.log(`wheel must carry: ${requiredWheelEntries(root).join(", ")}`);
  console.log("");
  console.log("Next commands:");
  if (!ready) console.log("- npm run release:prepare -- --version <x.y.z>  (fix version drift)");
  console.log("- npm run release:pypi:build");
  console.log(
    "- git push origin v<version>   # .github/workflows/publish-pypi.yml uploads to PyPI (approve the pypi environment)",
  );
  console.log("- fallback: UV_PUBLISH_TOKEN=… npm run release:pypi:publish");
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const args = parseArgs(argv);
  const root = path.resolve(String(args.root ?? process.cwd()));

  if (command === "plan") {
    printPlan(root, args);
    return;
  }
  if (command === "build") {
    const result = buildDistribution(root, args);
    console.log(
      `Built ${result.wheel} and ${result.sdist} in ${path.relative(root, result.outDir)}.`,
    );
    return;
  }
  if (command === "publish") {
    publishDistribution(root, args);
    return;
  }
  throw new Error(`Unknown pypi release command: ${command}\n${usage()}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
