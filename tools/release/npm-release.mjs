#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  buildOpenReceivePackageTarballs,
  createPackageBuildWorkspace,
  discoverWorkspacePackages,
  readJson
} from "../package/build-artifacts.mjs";

const PUBLIC_PACKAGE_NAMES = [
  "openreceive",
  "@openreceive/angular",
  "@openreceive/browser",
  "@openreceive/core",
  "@openreceive/elements",
  "@openreceive/node",
  "@openreceive/provider-data",
  "@openreceive/react",
  "@openreceive/svelte",
  "@openreceive/vue"
];
const PUBLIC_PACKAGE_SET = new Set(PUBLIC_PACKAGE_NAMES);
const VERSION_INCREMENTS = new Set(["major", "minor", "patch"]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const args = {
    _: []
  };

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

function rootFromArgs(args) {
  return path.resolve(String(args.root ?? process.cwd()));
}

function usage() {
  return [
    "Usage:",
    "  npm run release:plan -- --version patch",
    "  npm run release:prepare -- --version 0.1.1",
    "  npm run release:publish -- --tag latest [--otp 123456]",
    "",
    "Options:",
    "  --version <patch|minor|major|x.y.z>  Version increment or exact target.",
    "  --tag <npm-tag>                     npm dist-tag for publish (default: latest).",
    "  --out <dir>                         Release output dir (default: .release/npm/<version>).",
    "  --dry-run                           Show changes or npm publish commands without applying.",
    "  --allow-dirty                       Allow prepare/publish from a dirty worktree.",
    "  --skip-tests                        Skip npm run test:ci during publish.",
    "  --otp <code>                        npm one-time password for publish.",
    "  --root <dir>                        Repository root, useful for tests."
  ].join("\n");
}

function readRootPackage(root) {
  return readJson(path.join(root, "package.json"));
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertSemver(version, label = "version") {
  assert(SEMVER_PATTERN.test(version), `${label} must be a semver version, got ${version}`);
}

function resolveTargetVersion(currentVersion, requestedVersion) {
  assert(requestedVersion, "--version is required");
  if (VERSION_INCREMENTS.has(requestedVersion)) {
    const [major, minor, patch] = currentVersion.split(".").map((part) => Number(part));
    if (requestedVersion === "major") return `${major + 1}.0.0`;
    if (requestedVersion === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  assertSemver(requestedVersion);
  return requestedVersion;
}

function run(command, args, root, options = {}) {
  const npmCache = path.join(root, ".release", "npm-cache");
  if (command === "npm") mkdirSync(npmCache, { recursive: true });
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...(command === "npm" ? { npm_config_cache: npmCache } : {}),
      ...(options.env ?? {})
    }
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
  assert(status.length === 0, `${action} requires a clean git worktree. Commit/stash changes or pass --allow-dirty.`);
}

function workspaceManifestPaths(root) {
  const paths = [path.join(root, "package.json")];
  for (const workspaceRoot of [
    path.join(root, "packages/js"),
    path.join(root, "examples/hello-fruit/server")
  ]) {
    if (!existsSync(workspaceRoot)) continue;
    for (const entry of readdirSync(workspaceRoot)) {
      const candidate = path.join(workspaceRoot, entry, "package.json");
      if (statSync(path.dirname(candidate), { throwIfNoEntry: false })?.isDirectory() && existsSync(candidate)) {
        paths.push(candidate);
      }
    }
  }
  return paths.sort();
}

function updateOpenReceiveVersions(root, targetVersion) {
  const rootPackage = readRootPackage(root);
  const currentVersion = rootPackage.version;
  const changed = [];

  for (const manifestPath of workspaceManifestPaths(root)) {
    const manifest = readJson(manifestPath);
    let modified = false;

    if (manifest.version !== undefined && manifest.version !== targetVersion) {
      manifest.version = targetVersion;
      modified = true;
    }

    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      for (const dependency of Object.keys(dependencies)) {
        if (dependency.startsWith("@openreceive/") && dependencies[dependency] !== targetVersion) {
          dependencies[dependency] = targetVersion;
          modified = true;
        }
      }
    }

    if (modified) {
      writeJsonFile(manifestPath, manifest);
      changed.push(path.relative(root, manifestPath));
    }
  }

  changed.push(...updateTextVersionReferences(root, currentVersion, targetVersion));
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], root, { stdio: ["ignore", "pipe", "pipe"] });
  changed.push("package-lock.json");

  return [...new Set(changed)].sort();
}

function updateTextVersionReferences(root, currentVersion, targetVersion) {
  const changed = [];
  const changelogPath = path.join(root, "CHANGELOG.md");
  const releaseDocsPath = path.join(root, "docs/internal/release-process.md");

  if (existsSync(changelogPath)) {
    const source = readFileSync(changelogPath, "utf8");
    const updated = source.replace(
      new RegExp(`^## ${escapeRegExp(currentVersion)} - Unreleased$`, "m"),
      `## ${targetVersion} - Unreleased`
    );
    if (updated !== source) {
      writeFileSync(changelogPath, updated);
      changed.push("CHANGELOG.md");
    }
  }

  if (existsSync(releaseDocsPath)) {
    const source = readFileSync(releaseDocsPath, "utf8");
    const updated = source
      .replace(new RegExp(`OpenReceive \`${escapeRegExp(currentVersion)}\``, "g"), `OpenReceive \`${targetVersion}\``)
      .replace(new RegExp(`v${escapeRegExp(currentVersion)}`, "g"), `v${targetVersion}`);
    if (updated !== source) {
      writeFileSync(releaseDocsPath, updated);
      changed.push("docs/internal/release-process.md");
    }
  }

  return changed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publicPackages(root) {
  const packages = discoverWorkspacePackages({ root });
  return packages.filter(({ manifest }) => PUBLIC_PACKAGE_SET.has(manifest.name));
}

function releasePlan(root, targetVersion, args) {
  const packages = discoverWorkspacePackages({ root });
  const packageNames = packages.map(({ manifest }) => manifest.name);
  const missing = PUBLIC_PACKAGE_NAMES.filter((name) => !packageNames.includes(name));
  assert.deepEqual(missing, [], `Missing public package(s): ${missing.join(", ")}`);

  const outDir = path.relative(root, releaseOutDir(root, targetVersion, args));
  const rootPackage = readRootPackage(root);
  const dirty = gitStatus(root).length > 0;

  return {
    currentVersion: rootPackage.version,
    targetVersion,
    npmTag: String(args.tag ?? "latest"),
    outputDirectory: outDir,
    dirty,
    publicPackages: PUBLIC_PACKAGE_NAMES,
    commands: [
      `npm run release:prepare -- --version ${targetVersion}`,
      `npm run release:publish -- --tag ${args.tag ?? "latest"}`
    ]
  };
}

function printPlan(plan, args) {
  if (args.json === true) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`OpenReceive npm release plan: ${plan.currentVersion} -> ${plan.targetVersion}`);
  console.log(`npm tag: ${plan.npmTag}`);
  console.log(`tarballs: ${plan.outputDirectory}`);
  console.log(`worktree: ${plan.dirty ? "dirty" : "clean"}`);
  console.log("");
  console.log("Public packages to publish:");
  for (const name of plan.publicPackages) console.log(`- ${name}@${plan.targetVersion}`);
  console.log("");
  console.log("Next commands:");
  for (const command of plan.commands) console.log(`- ${command}`);
}

function releaseOutDir(root, targetVersion, args) {
  return path.resolve(root, String(args.out ?? path.join(".release", "npm", targetVersion)));
}

function dryRunPrepare(root, targetVersion) {
  const rootPackage = readRootPackage(root);
  const currentVersion = rootPackage.version;
  const files = workspaceManifestPaths(root).map((filePath) => path.relative(root, filePath));
  return {
    currentVersion,
    targetVersion,
    files: [
      ...files,
      "CHANGELOG.md",
      "docs/internal/release-process.md",
      "package-lock.json"
    ].filter((file, index, all) => all.indexOf(file) === index).sort()
  };
}

function printPrepareDryRun(result) {
  console.log(`Would prepare OpenReceive npm release: ${result.currentVersion} -> ${result.targetVersion}`);
  console.log("Files that may change:");
  for (const file of result.files) console.log(`- ${file}`);
}

function buildPublicTarballs(root, targetVersion, args) {
  const outDir = releaseOutDir(root, targetVersion, args);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const workspace = createPackageBuildWorkspace({ root, outDir });
  const result = buildOpenReceivePackageTarballs({
    root,
    packages: publicPackages(root),
    workspace,
    log: (message) => console.error(message)
  });
  return {
    outDir,
    tarballs: result.tarballs
  };
}

function assertVersionsReady(root, targetVersion) {
  const rootPackage = readRootPackage(root);
  assert.equal(rootPackage.version, targetVersion, `root package version must be ${targetVersion}`);

  for (const { manifest } of discoverWorkspacePackages({ root })) {
    assert.equal(manifest.version, targetVersion, `${manifest.name}: version must be ${targetVersion}`);
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@openreceive/")) {
        assert.equal(version, targetVersion, `${manifest.name}: ${dependency} must be ${targetVersion}`);
      }
    }
  }
}

function assertNotPublished(packageName, version, root) {
  try {
    const output = run("npm", ["view", `${packageName}@${version}`, "version", "--json"], root);
    if (output.trim().replace(/^"|"$/g, "") === version) {
      throw new Error(`${packageName}@${version} already exists on npm`);
    }
  } catch (error) {
    if (error.message.includes("already exists on npm")) throw error;
    if (error.message.includes("E404") || error.message.includes("404 Not Found")) return;
    throw error;
  }
}

function publishTarballs(root, tarballs, args) {
  const tag = String(args.tag ?? "latest");
  const publishArgs = [];
  if (args.otp !== undefined) publishArgs.push("--otp", String(args.otp));
  if (args["dry-run"] === true) publishArgs.push("--dry-run");

  for (const { name, tarball } of tarballs) {
    assert(PUBLIC_PACKAGE_SET.has(name), `${name}: refusing to publish non-public package`);
    const argsForPackage = [
      "publish",
      tarball,
      "--access",
      "public",
      "--tag",
      tag,
      ...publishArgs
    ];
    console.error(`publishing ${name} from ${path.relative(root, tarball)}`);
    run("npm", argsForPackage, root, { stdio: "inherit" });
  }
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }

  const args = parseArgs(argv);
  const root = rootFromArgs(args);
  const rootPackage = readRootPackage(root);
  assertSemver(rootPackage.version, "root package version");
  const targetVersion = resolveTargetVersion(rootPackage.version, args.version ?? (command === "publish" ? rootPackage.version : undefined));

  if (command === "plan") {
    printPlan(releasePlan(root, targetVersion, args), args);
    return;
  }

  if (command === "prepare") {
    assertCleanWorktree(root, args, "release:prepare");
    if (args["dry-run"] === true) {
      printPrepareDryRun(dryRunPrepare(root, targetVersion));
      return;
    }
    const changed = updateOpenReceiveVersions(root, targetVersion);
    console.log(`Prepared OpenReceive npm release ${targetVersion}.`);
    console.log("Changed files:");
    for (const file of changed) console.log(`- ${file}`);
    console.log("Next: npm run test:ci");
    return;
  }

  if (command === "publish") {
    assertCleanWorktree(root, args, "release:publish");
    assertVersionsReady(root, targetVersion);
    if (args["skip-tests"] !== true) {
      run("npm", ["run", "test:ci"], root, { stdio: "inherit" });
    }
    for (const packageName of PUBLIC_PACKAGE_NAMES) {
      assertNotPublished(packageName, targetVersion, root);
    }
    const result = buildPublicTarballs(root, targetVersion, args);
    publishTarballs(root, result.tarballs, args);
    console.log(`Published ${result.tarballs.length} package(s) for ${targetVersion}.`);
    return;
  }

  throw new Error(`Unknown release command: ${command}\n${usage()}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
