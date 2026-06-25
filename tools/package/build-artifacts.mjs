#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
    .filter(({ manifest }) => manifest.name?.startsWith("@openreceive/"))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

export function validateWorkspacePackageGraph(packages) {
  assert(packages.length > 0, "No OpenReceive workspace packages found.");
  const workspaceNames = new Set(packages.map(({ manifest }) => manifest.name));

  for (const pkg of packages) {
    assert(pkg.manifest.exports?.["."], `${pkg.manifest.name}: package export is required`);
    for (const [dependency, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (dependency.startsWith("@openreceive/")) {
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

export function buildPackageArtifact(pkg, artifactRoot) {
  const packageDirName = path.basename(pkg.dir);
  const artifactDir = path.join(artifactRoot, packageDirName);
  const sourceDir = path.join(pkg.dir, "src");
  const distDir = path.join(artifactDir, "dist");
  mkdirSync(distDir, { recursive: true });

  const manifest = {
    ...pkg.manifest,
    exports: rewriteExports(pkg.manifest.exports),
    files: pkg.manifest.bin === undefined
      ? ["dist", "README.md", "LICENSE"]
      : ["dist", "bin", "README.md", "LICENSE"]
  };
  writeFileSync(
    path.join(artifactDir, "package.json"),
    JSON.stringify(manifest, null, 2)
  );
  copyPackageDocs(pkg, artifactDir);
  copyPackageBins(pkg, artifactDir);

  for (const file of walkFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, file);
    const outputRelativePath = relativePath.endsWith(".d.ts")
      ? relativePath
      : relativePath.endsWith(".ts")
      ? relativePath.replace(/\.ts$/, ".js")
      : relativePath;
    const outputPath = path.join(distDir, outputRelativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });

    if (relativePath.endsWith(".d.ts")) {
      copyFileSync(file, outputPath);
    } else if (relativePath.endsWith(".ts")) {
      writeFileSync(
        outputPath,
        transpileTypeScript(readFileSync(file, "utf8"), file)
      );
    } else {
      copyFileSync(file, outputPath);
    }
  }

  return artifactDir;
}

function copyPackageDocs(pkg, artifactDir) {
  const readmePath = path.join(pkg.dir, "README.md");
  if (existsSync(readmePath)) {
    copyFileSync(readmePath, path.join(artifactDir, "README.md"));
  }

  const licensePath = path.join(path.dirname(path.dirname(pkg.dir)), "..", "LICENSE");
  if (existsSync(licensePath)) {
    copyFileSync(licensePath, path.join(artifactDir, "LICENSE"));
  }
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
  const artifactDir = buildPackageArtifact(pkg, artifactRoot);
  const output = runNpm(
    ["pack", artifactDir, "--pack-destination", tarballDir, "--json"],
    root,
    cacheDir,
    npmTimeoutMs
  );
  const [packed] = JSON.parse(output);
  assert(packed?.filename, `${pkg.manifest.name}: npm pack did not return a filename`);
  return path.join(tarballDir, packed.filename);
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

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (stat.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function transpileTypeScript(source, fileName) {
  const result = ts.transpileModule(inlineJsonImportAttributes(source, fileName), {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true
    },
    reportDiagnostics: true
  });

  const diagnostics = result.diagnostics ?? [];
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    });
    throw new Error(formatted);
  }

  return result.outputText;
}

// Node 20.0 and current Node parse different static JSON import syntaxes.
// Package artifacts inline JSON imports so one emitted module works on both.
function inlineJsonImportAttributes(source, fileName) {
  const jsonImportPattern =
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.json)["']\s+with\s+\{\s*type:\s*["']json["']\s*\};/gm;
  const requireForSource = createRequire(fileName);

  return source.replace(jsonImportPattern, (_match, binding, specifier) => {
    const jsonPath = requireForSource.resolve(specifier);
    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    return `const ${binding} = ${JSON.stringify(json)};`;
  });
}

function rewriteExportTarget(target) {
  if (typeof target !== "string") return target;
  if (target.startsWith("./src/") && target.endsWith(".ts")) {
    return `./dist/${target.slice("./src/".length, -".ts".length)}.js`;
  }
  if (target.startsWith("./src/")) {
    return `./dist/${target.slice("./src/".length)}`;
  }
  return target;
}

function rewriteExports(exports) {
  if (typeof exports === "string") return rewriteExportTarget(exports);
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) {
    return exports;
  }

  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => [
      key,
      typeof value === "string" ? rewriteExportTarget(value) : rewriteExports(value)
    ])
  );
}

function rewriteBinSource(source) {
  return source.replace(/(["'])\.\.\/src\/([^"']+)\.ts\1/g, "$1../dist/$2.js$1");
}

function copyPackageBins(pkg, artifactDir) {
  const bin = pkg.manifest.bin;
  if (bin === undefined) return;

  const binTargets = typeof bin === "string" ? [bin] : Object.values(bin);
  for (const target of new Set(binTargets)) {
    assert(
      typeof target === "string" && target.startsWith("./bin/"),
      `${pkg.manifest.name}: package bin must point at ./bin`
    );
    const sourcePath = path.join(pkg.dir, target);
    const outputPath = path.join(artifactDir, target);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rewriteBinSource(readFileSync(sourcePath, "utf8")));
    chmodSync(outputPath, 0o755);
  }
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
