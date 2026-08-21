#!/usr/bin/env node

// RubyGems counterpart of npm-release.mjs. The gems release in lockstep with
// the npm workspace version: `npm run release:prepare` bumps the gem version
// files; this script builds and publishes the .gem artifacts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

export const GEM_NAMES = ["openreceive", "openreceive-server", "openreceive-rails"];

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
    "  node tools/release/gem-release.mjs plan",
    "  node tools/release/gem-release.mjs build",
    "  node tools/release/gem-release.mjs publish [--otp 123456]",
    "",
    "Options:",
    "  --out <dir>       Output dir for .gem files (default: .release/gems/<version>).",
    "  --dry-run         Print the gem push commands without publishing (skips test:ruby).",
    "  --allow-dirty     Allow publish from a dirty worktree.",
    "  --skip-tests      Skip npm run test:ruby during publish.",
    "  --otp <code>      RubyGems one-time password for publish.",
    "  --root <dir>      Repository root, useful for tests.",
  ].join("\n");
}

export function gemDir(root, name) {
  return path.join(root, "packages/ruby", name);
}

export function gemVersionFilePath(root, name) {
  const relative = {
    openreceive: "lib/openreceive/version.rb",
    "openreceive-server": "lib/openreceive/server/version.rb",
    "openreceive-rails": "lib/openreceive/rails/version.rb",
  }[name];
  assert(relative, `unknown gem ${name}`);
  return path.join(gemDir(root, name), relative);
}

export function readGemVersion(root, name) {
  const source = readFileSync(gemVersionFilePath(root, name), "utf8");
  const match = source.match(/VERSION = "([^"]+)"/);
  assert(match, `${name}: VERSION constant not found in version file`);
  return match[1];
}

function run(command, args, root, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function gitStatus(root) {
  try {
    return run("git", ["status", "--porcelain"], root).trim();
  } catch {
    return "";
  }
}

function assertCleanWorktree(root, args, action) {
  if (args["allow-dirty"] === true || args["dry-run"] === true) return;
  const status = gitStatus(root);
  assert(
    status.length === 0,
    `${action} requires a clean git worktree. Commit/stash changes or pass --allow-dirty.`,
  );
}

function rootVersion(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert(SEMVER_PATTERN.test(manifest.version), "root package version must be semver");
  return manifest.version;
}

export function assertGemVersionsReady(root) {
  const version = rootVersion(root);
  for (const name of GEM_NAMES) {
    const gemVersion = readGemVersion(root, name);
    assert.equal(
      gemVersion,
      version,
      `${name}: gem version ${gemVersion} must match workspace version ${version} ` +
        "(run npm run release:prepare)",
    );
  }
  return version;
}

function outDirFor(root, version, args) {
  return path.resolve(root, String(args.out ?? path.join(".release", "gems", version)));
}

function buildGems(root, args) {
  const version = assertGemVersionsReady(root);
  const outDir = outDirFor(root, version, args);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const artifacts = [];
  for (const name of GEM_NAMES) {
    const cwd = gemDir(root, name);
    const gemFile = `${name}-${version}.gem`;
    console.error(`building ${gemFile}`);
    run("gem", ["build", `${name}.gemspec`], root, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const builtPath = path.join(cwd, gemFile);
    assert(existsSync(builtPath), `${name}: expected ${gemFile} after gem build`);
    const outPath = path.join(outDir, gemFile);
    copyFileSync(builtPath, outPath);
    rmSync(builtPath);
    artifacts.push({ name, version, path: outPath });
  }
  return { version, outDir, artifacts };
}

function assertGemNotPublished(root, name, version) {
  // Best-effort remote check; a network failure must not block an intentional
  // publish, but an already-published version must.
  let output;
  try {
    output = run("gem", ["search", "--remote", "--exact", "--all", name], root);
  } catch {
    console.error(`warning: could not query RubyGems for ${name}; continuing`);
    return;
  }
  const match = output.match(new RegExp(`^${name} \\(([^)]*)\\)`, "m"));
  if (!match) return;
  const published = match[1].split(",").map((part) => part.trim());
  assert(!published.includes(version), `${name}@${version} already exists on RubyGems`);
}

function publishGems(root, args) {
  assertCleanWorktree(root, args, "gem publish");
  const version = assertGemVersionsReady(root);
  // Dry-run is a fast preview and skips the suite, matching npm-release's
  // dry-run; the REAL publish always runs test:ruby unless --skip-tests is
  // passed deliberately.
  if (args["dry-run"] === true) {
    console.error("dry-run: skipping `npm run test:ruby` — a real gem publish runs it first.");
  } else if (args["skip-tests"] !== true) {
    run("npm", ["run", "test:ruby"], root, { stdio: "inherit" });
  }
  for (const name of GEM_NAMES) {
    assertGemNotPublished(root, name, version);
  }
  const { artifacts } = buildGems(root, args);
  for (const artifact of artifacts) {
    const pushArgs = ["push", artifact.path];
    if (args.otp !== undefined) pushArgs.push("--otp", String(args.otp));
    if (args["dry-run"] === true) {
      console.log(`dry-run: gem ${pushArgs.join(" ")}`);
      continue;
    }
    console.error(`publishing ${artifact.name}@${artifact.version}`);
    run("gem", pushArgs, root, { stdio: "inherit" });
  }
  console.log(
    `${args["dry-run"] === true ? "Dry-run planned" : "Published"} ${artifacts.length} gem(s) for ${version}.`,
  );
}

function printPlan(root, args) {
  const workspaceVersion = rootVersion(root);
  console.log(`OpenReceive RubyGems release plan (workspace ${workspaceVersion}):`);
  let ready = true;
  for (const name of GEM_NAMES) {
    const gemVersion = readGemVersion(root, name);
    const marker = gemVersion === workspaceVersion ? "ok" : "DRIFT";
    if (gemVersion !== workspaceVersion) ready = false;
    console.log(`- ${name}@${gemVersion} [${marker}]`);
  }
  console.log(`artifacts: ${path.relative(root, outDirFor(root, workspaceVersion, args))}`);
  console.log("");
  console.log("Next commands:");
  if (!ready) console.log("- npm run release:prepare -- --version <x.y.z>  (fix version drift)");
  console.log("- npm run release:gem:build");
  console.log("- npm run release:gem:publish -- --otp <code>");
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
    const result = buildGems(root, args);
    console.log(
      `Built ${result.artifacts.length} gem(s) in ${path.relative(root, result.outDir)}.`,
    );
    return;
  }
  if (command === "publish") {
    publishGems(root, args);
    return;
  }
  throw new Error(`Unknown gem release command: ${command}\n${usage()}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
