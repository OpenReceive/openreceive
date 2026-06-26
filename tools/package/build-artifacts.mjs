#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_NPM_TIMEOUT_MS = 120_000;

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function discoverWorkspacePackages(input = {}) {
  const root = input.root ?? process.cwd();
  const packageRoot = input.packageRoot ?? path.join(root, "packages/js");

  return readdirSync(packageRoot)
    .map((entry) => path.join(packageRoot, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((entryPath) => {
      const manifestPath = path.join(entryPath, "package.json");
      const manifest = readJson(manifestPath);
      return {
        dir: entryPath,
        manifest
      };
    })
    .filter(({ manifest }) =>
      manifest.name === "openreceive" ||
      manifest.name?.startsWith("@openreceive/")
    )
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function validateWorkspacePackageGraph(packages) {
  assert(packages.length > 0, "No OpenReceive workspace packages found.");
  const workspaceNames = new Set(packages.map(({ manifest }) => manifest.name));

  for (const pkg of packages) {
    assert(pkg.manifest.exports?.["."], `${pkg.manifest.name}: package export is required`);
    for (const [dependency, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (dependency === "openreceive" || dependency.startsWith("@openreceive/")) {
        assert(workspaceNames.has(dependency), `${pkg.manifest.name}: unknown workspace dependency ${dependency}`);
        assert(version === pkg.manifest.version, `${pkg.manifest.name}: ${dependency} version must match package version`);
      }
    }
  }
}

export function npmEnv(cacheDir) {
  return {
    ...process.env,
    npm_config_cache: cacheDir,
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
}

export function runNpm(args, cwd, cacheDir, timeoutMs = DEFAULT_NPM_TIMEOUT_MS) {
  try {
    return execFileSync("npm", args, {
      cwd,
      env: npmEnv(cacheDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    });
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(
      [
        `npm ${args.join(" ")} failed in ${cwd}.`,
        stdout.trim(),
        stderr.trim(),
        error.message
      ].filter(Boolean).join("\n")
    );
  }
}

export function localPackageDirectory(root, packageName) {
  const packageSegments = packageName.split("/");
  const candidates = [
    path.join(root, "node_modules", ...packageSegments)
  ];
  const jsPackageRoot = path.join(root, "packages/js");
  if (statSync(jsPackageRoot, { throwIfNoEntry: false }) !== undefined) {
    for (const entry of readdirSync(jsPackageRoot)) {
      candidates.push(path.join(jsPackageRoot, entry, "node_modules", ...packageSegments));
    }
  }

  const packageDir = candidates.find(
    (candidate) => statSync(path.join(candidate, "package.json"), { throwIfNoEntry: false }) !== undefined
  );
  if (packageDir === undefined) {
    throw new Error(
      `${packageName} is required for package artifact smoke imports. Run npm install in the repo first.`
    );
  }
  return packageDir;
}

export function localPackageDependency(root, packageName) {
  return `file:${localPackageDirectory(root, packageName)}`;
}

export function createPackageBuildWorkspace(input = {}) {
  const root = input.root ?? process.cwd();
  const baseDir =
    input.outDir === undefined
      ? mkdtempSync(path.join(tmpdir(), "openreceive-package-build-"))
      : path.resolve(root, input.outDir);

  mkdirSync(baseDir, { recursive: true });
  const artifactRoot = path.join(baseDir, "artifacts");
  const tarballDir = path.join(baseDir, "tarballs");
  const cacheDir = path.join(baseDir, "npm-cache");
  mkdirSync(artifactRoot, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    baseDir,
    artifactRoot,
    tarballDir,
    cacheDir,
    temporary: input.outDir === undefined
  };
}

export function buildPackageArtifact(pkg, _artifactRoot, input = {}) {
  if (pkg.manifest.scripts?.build !== undefined) {
    runNpm(["run", "build", "-w", pkg.manifest.name], input.root ?? process.cwd(), input.cacheDir, input.npmTimeoutMs);
  }
  assert(
    existsSync(path.join(pkg.dir, "dist")),
    `${pkg.manifest.name}: build must emit dist before npm pack`
  );
  return pkg.dir;
}

export function packPackageArtifact(input) {
  const {
    pkg,
    root,
    artifactRoot,
    tarballDir,
    cacheDir,
    npmTimeoutMs = DEFAULT_NPM_TIMEOUT_MS,
    log = console.error
  } = input;

  log(`packing ${pkg.manifest.name}`);
  const packageDir = buildPackageArtifact(pkg, artifactRoot, {
    root,
    cacheDir,
    npmTimeoutMs
  });
  const output = runNpm(
    ["pack", packageDir, "--pack-destination", tarballDir, "--json"],
    root,
    cacheDir,
    npmTimeoutMs
  );
  const [packed] = parseNpmPackJson(output);
  assert(packed?.filename, `${pkg.manifest.name}: npm pack did not return a filename`);
  return path.join(tarballDir, packed.filename);
}

function parseNpmPackJson(output) {
  const start = output.lastIndexOf("\n[");
  const json = (start === -1 ? output : output.slice(start + 1)).trim();
  return JSON.parse(json);
}

export function buildOpenReceivePackageTarballs(input = {}) {
  const root = input.root ?? process.cwd();
  const packages = input.packages ?? discoverWorkspacePackages({ root });
  validateWorkspacePackageGraph(packages);

  const workspace = input.workspace ?? createPackageBuildWorkspace({ root, outDir: input.outDir });
  const log = input.log ?? console.error;
  log(`building ${packages.length} package artifact(s)`);

  const tarballs = packages.map((pkg) => ({
    name: pkg.manifest.name,
    tarball: packPackageArtifact({
      pkg,
      root,
      artifactRoot: workspace.artifactRoot,
      tarballDir: workspace.tarballDir,
      cacheDir: workspace.cacheDir,
      npmTimeoutMs: input.npmTimeoutMs,
      log
    })
  }));

  return {
    packages,
    tarballs,
    workspace
  };
}

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function main() {
  const root = process.cwd();
  const args = process.argv.slice(2);
  const outDir = readFlag(args, "--out");
  const keep = args.includes("--keep") || process.env.OPENRECEIVE_KEEP_PACKAGE_BUILD === "1";
  const npmTimeoutMs = Number(process.env.OPENRECEIVE_PACKAGE_SMOKE_NPM_TIMEOUT_MS ?? DEFAULT_NPM_TIMEOUT_MS);
  const result = buildOpenReceivePackageTarballs({
    root,
    outDir,
    npmTimeoutMs
  });

  for (const item of result.tarballs) {
    console.log(`${item.name} ${path.relative(root, item.tarball)}`);
  }
  console.log(`Package artifact dry run passed for ${result.packages.length} package(s).`);

  if (result.workspace.temporary && !keep) {
    rmSync(result.workspace.baseDir, { recursive: true, force: true });
  } else {
    console.log(`Artifacts kept at ${result.workspace.baseDir}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
