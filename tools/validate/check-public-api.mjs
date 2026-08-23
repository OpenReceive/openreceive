#!/usr/bin/env node

// Public-API gate (audit E21). Extracts every publishable package's public
// export surface — the exported names per package.json "exports" entry point,
// resolved from the TypeScript sources — and diffs it against the committed
// snapshot (tools/validate/public-api.snapshot.json). `export *` boundaries
// were replaced with curated lists; this gate keeps the surface from drifting
// silently: adding, removing, or renaming a public export fails CI until the
// change is reviewed and the snapshot regenerated with --update.
//
// Deterministic and dependency-light: only the repo's own typescript compiler
// is used, entries and names are sorted, and the snapshot is plain JSON.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { root } from "../shared/root.mjs";

const snapshotPath = path.join(root, "tools", "validate", "public-api.snapshot.json");
const update = process.argv.includes("--update");

// Entry points whose published types do not follow the dist/<name>.d.ts ->
// src/<name>.ts convention. Paths are relative to the package directory.
const entrySourceOverrides = {
  "@openreceive/angular": {
    ".": "src/index.ts",
    "./checkout-component": "src/openreceive-checkout.component.ts",
  },
  "@openreceive/vue": { "./checkout.vue": "src/Checkout.vue.d.ts" },
  "@openreceive/svelte": { "./checkout.svelte": "src/Checkout.svelte.d.ts" },
};

function fail(message) {
  process.exitCode = 1;
  console.error(message);
}

function listPublishablePackages() {
  const packagesDir = path.join(root, "packages", "js");
  const packages = [];
  for (const entry of readdirSync(packagesDir).sort()) {
    const packageJsonPath = path.join(packagesDir, entry, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (manifest.private === true) continue;
    packages.push({ name: manifest.name, dir: path.join(packagesDir, entry), manifest });
  }
  return packages;
}

/** package.json "exports" entries that carry types -> absolute source file. */
function typedEntryPoints({ name, dir, manifest }) {
  const entries = new Map();
  const exportsMap = manifest.exports ?? {};
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (typeof target !== "object" || target === null || typeof target.types !== "string") {
      continue; // css / asset / package.json entries carry no API surface
    }
    const override = entrySourceOverrides[name]?.[subpath];
    let source;
    if (override !== undefined) {
      source = path.resolve(dir, override);
    } else {
      const match = /^\.\/dist\/(.+)\.d\.ts$/.exec(target.types);
      if (match === null) {
        fail(
          `${name} ${subpath}: cannot map types "${target.types}" to a source file. ` +
            `Add an override in tools/validate/check-public-api.mjs.`,
        );
        continue;
      }
      const tsSource = path.join(dir, "src", `${match[1]}.ts`);
      const dtsSource = path.join(dir, "src", `${match[1]}.d.ts`);
      source = existsSync(tsSource) ? tsSource : dtsSource;
    }
    if (!existsSync(source)) {
      fail(`${name} ${subpath}: expected source file ${path.relative(root, source)} is missing.`);
      continue;
    }
    entries.set(subpath, source);
  }
  return entries;
}

function loadCompilerOptions() {
  const configPath = path.join(root, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

function extractSurfaces(packages) {
  const entryTables = packages.map((pkg) => ({ pkg, entries: typedEntryPoints(pkg) }));
  const rootNames = entryTables.flatMap(({ entries }) => [...entries.values()]);
  const program = ts.createProgram({ rootNames, options: loadCompilerOptions() });
  const checker = program.getTypeChecker();

  const surfaces = {};
  for (const { pkg, entries } of entryTables) {
    const packageSurface = {};
    for (const [subpath, source] of [...entries.entries()].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    )) {
      const sourceFile = program.getSourceFile(source);
      if (sourceFile === undefined) {
        fail(`${pkg.name} ${subpath}: ${path.relative(root, source)} did not load.`);
        continue;
      }
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      const values = [];
      const types = [];
      for (const symbol of moduleSymbol === undefined
        ? []
        : checker.getExportsOfModule(moduleSymbol)) {
        const resolved =
          (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
        ((resolved.flags & ts.SymbolFlags.Value) !== 0 ? values : types).push(symbol.name);
      }
      values.sort((a, b) => a.localeCompare(b, "en"));
      types.sort((a, b) => a.localeCompare(b, "en"));
      packageSurface[subpath] = { values, types };
    }
    surfaces[pkg.name] = packageSurface;
  }
  return surfaces;
}

function diffNames(kind, entryLabel, expected, actual, lines) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const name of actual) {
    if (!expectedSet.has(name)) lines.push(`  + ${entryLabel} ${kind} ${name} (new)`);
  }
  for (const name of expected) {
    if (!actualSet.has(name)) lines.push(`  - ${entryLabel} ${kind} ${name} (removed)`);
  }
}

function diffSurfaces(expected, actual) {
  const lines = [];
  const packageNames = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const packageName of [...packageNames].sort()) {
    const expectedPackage = expected[packageName];
    const actualPackage = actual[packageName];
    if (expectedPackage === undefined) {
      lines.push(`${packageName}: package is new to the snapshot`);
      continue;
    }
    if (actualPackage === undefined) {
      lines.push(`${packageName}: package disappeared from the workspace`);
      continue;
    }
    const entryNames = new Set([...Object.keys(expectedPackage), ...Object.keys(actualPackage)]);
    const packageLines = [];
    for (const entryName of [...entryNames].sort()) {
      const expectedEntry = expectedPackage[entryName];
      const actualEntry = actualPackage[entryName];
      if (expectedEntry === undefined) {
        packageLines.push(`  + entry point ${entryName} (new)`);
        continue;
      }
      if (actualEntry === undefined) {
        packageLines.push(`  - entry point ${entryName} (removed)`);
        continue;
      }
      diffNames("value", entryName, expectedEntry.values, actualEntry.values, packageLines);
      diffNames("type", entryName, expectedEntry.types, actualEntry.types, packageLines);
    }
    if (packageLines.length > 0) {
      lines.push(`${packageName}:`, ...packageLines);
    }
  }
  return lines;
}

const surfaces = extractSurfaces(listPublishablePackages());
if (process.exitCode === 1) {
  console.error("check:public-api could not extract the export surface; see errors above.");
  process.exit(1);
}

const serialized = `${JSON.stringify(surfaces, null, 2)}\n`;

if (update) {
  writeFileSync(snapshotPath, serialized);
  console.log(
    `check:public-api: wrote ${path.relative(root, snapshotPath)} ` +
      `(${Object.keys(surfaces).length} packages). Review the diff before committing.`,
  );
  process.exit(0);
}

if (!existsSync(snapshotPath)) {
  fail(
    `check:public-api: snapshot ${path.relative(root, snapshotPath)} is missing.\n` +
      "Generate it with: node tools/validate/check-public-api.mjs --update",
  );
  process.exit(1);
}

const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
const differences = diffSurfaces(expected, surfaces);
if (differences.length > 0) {
  fail(
    "check:public-api: the public export surface changed:\n\n" +
      `${differences.join("\n")}\n\n` +
      "Every listed name rides the package's semver. If the change is intentional,\n" +
      "review it, then regenerate the snapshot with:\n" +
      "  node tools/validate/check-public-api.mjs --update\n" +
      "and commit tools/validate/public-api.snapshot.json with your change.",
  );
  process.exit(1);
}

console.log(
  `check:public-api: ${Object.keys(surfaces).length} package surfaces match the snapshot.`,
);
