#!/usr/bin/env node

// RubyGems counterpart of npm-release.mjs. The gems release in lockstep with
// the npm workspace version: `npm run release:prepare` bumps the gem version
// files; this script builds and publishes the .gem artifacts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// RubyGems does not use the workspace's version string verbatim: Gem::Version
// rewrites an npm-style prerelease, so "0.2.0-alpha.0" becomes
// "0.2.0.pre.alpha.0" in the built filename AND in what rubygems.org reports.
// Ask Ruby instead of reimplementing those rules — guessing the filename is
// what broke `release:gem:build` for every prerelease.
const gemVersionCache = new Map();

function toGemVersion(root, version) {
  const cached = gemVersionCache.get(version);
  if (cached !== undefined) return cached;
  const normalized = run(
    "ruby",
    ["-e", 'require "rubygems"; print Gem::Version.new(ARGV[0]).to_s', version],
    root,
  ).trim();
  assert(normalized.length > 0, `could not normalize gem version ${version}`);
  gemVersionCache.set(version, normalized);
  return normalized;
}

function buildGems(root, args) {
  const version = assertGemVersionsReady(root);
  const outDir = outDirFor(root, version, args);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const gemVersion = toGemVersion(root, version);
  const artifacts = [];
  for (const name of GEM_NAMES) {
    const cwd = gemDir(root, name);
    const outPath = path.join(outDir, `${name}-${gemVersion}.gem`);
    console.error(`building ${path.basename(outPath)}`);
    // --output writes the artifact where we want it, so nothing lands in the
    // gem source dir and no copy/cleanup dance is needed.
    run("gem", ["build", `${name}.gemspec`, "--output", outPath], root, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert(existsSync(outPath), `${name}: expected ${path.basename(outPath)} after gem build`);
    artifacts.push({ name, version, gemVersion, path: outPath });
  }
  return { version, gemVersion, outDir, artifacts };
}

function assertGemNotPublished(root, name, version) {
  // Best-effort remote check; a network failure must not block an intentional
  // publish, but an already-published version must.
  let output;
  try {
    // --prerelease is required: RubyGems excludes prereleases from search by
    // default, and prereleases are exactly what this repo mints. Release
    // versions still appear with --all --prerelease.
    output = run("gem", ["search", "--remote", "--exact", "--all", "--prerelease", name], root);
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
    assertGemNotPublished(root, name, toGemVersion(root, version));
  }
  const { artifacts } = buildGems(root, args);
  for (const artifact of artifacts) {
    const pushArgs = ["push", artifact.path];
    if (args.otp !== undefined) pushArgs.push("--otp", String(args.otp));
    if (args["dry-run"] === true) {
      console.log(`dry-run: gem ${pushArgs.join(" ")}`);
      continue;
    }
    console.error(`publishing ${artifact.name}@${artifact.gemVersion}`);
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

// fileURLToPath, not `new URL(...).pathname`: the latter keeps percent-encoding,
// so a repo path containing a space compared unequal and the CLI silently did
// nothing.
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
