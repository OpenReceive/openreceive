#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageRoot = path.join(root, "packages/js");
const findings = [];

function fail(message) {
  findings.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return {};
  }
}

function workspacePackages() {
  return readdirSync(packageRoot)
    .map((entry) => path.join(packageRoot, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((entryPath) => {
      const relativePath = path.relative(root, path.join(entryPath, "package.json"));
      return {
        relativePath,
        manifest: readJson(relativePath)
      };
    })
    .filter(({ manifest }) => manifest.name?.startsWith("@openreceive/"))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function hasRootExport(manifest) {
  const rootExport = manifest.exports?.["."];
  if (typeof rootExport === "string") return true;
  if (rootExport === null || typeof rootExport !== "object" || Array.isArray(rootExport)) return false;
  return typeof rootExport.import === "string" || typeof rootExport.require === "string";
}

const rootPackage = readJson("package.json");
const packages = workspacePackages();
const changelog = read("CHANGELOG.md");
const releaseDocsPath = "docs/internal/release-process.md";
const releaseDocs = read(releaseDocsPath);
const publicFrontendPackages = new Set([
  "@openreceive/angular",
  "@openreceive/browser",
  "@openreceive/elements",
  "@openreceive/provider-data",
  "@openreceive/react",
  "@openreceive/svelte",
  "@openreceive/vue"
]);

expect(rootPackage.name === "openreceive", "package.json: root package name must be openreceive");
expect(rootPackage.version === "0.1.0", "package.json: root version must be 0.1.0");
expect(rootPackage.private === true, "package.json: root package must stay private before explicit publishing approval");
expect(rootPackage.scripts?.["test:ci"]?.includes("npm run check:release"), "package.json: test:ci must include check:release");
expect(rootPackage.scripts?.["check:release"] === "node tools/validate/check-release-readiness.mjs", "package.json: missing check:release script");
expect(rootPackage.scripts?.["build:packages"] === "node tools/package/build-artifacts.mjs --dry-run", "package.json: missing build:packages dry-run script");
expect(rootPackage.scripts?.["test:package-smoke"], "package.json: release gate must keep package smoke script");

for (const { relativePath, manifest } of packages) {
  expect(manifest.version === "0.1.0", `${relativePath}: package version must be 0.1.0`);
  if (publicFrontendPackages.has(manifest.name)) {
    expect(manifest.private !== true, `${relativePath}: public frontend package must not be private`);
  } else {
    expect(manifest.private === true, `${relativePath}: non-frontend package must stay private`);
  }
  expect(hasRootExport(manifest), `${relativePath}: package must expose a root export`);
}

expect(/^# Changelog/m.test(changelog), "CHANGELOG.md: missing top-level heading");
expect(/^## 0\.1\.0 - Unreleased$/m.test(changelog), "CHANGELOG.md: missing 0.1.0 unreleased section");
for (const phrase of [
  "demo deployment templates",
  "public demo deployment docs",
  "deterministic mock wallet",
  "workflow safety validation"
]) {
  expect(changelog.includes(phrase), `CHANGELOG.md: missing ${phrase} entry`);
}

for (const { manifest } of packages) {
  expect(
    releaseDocs.includes(`\`${manifest.name}\``),
    `${releaseDocsPath}: missing ${manifest.name}`
  );
}
for (const phrase of [
  "npm run test:ci",
  "Changelog updated.",
  "Frontend package manifests are public while server and test packages stay private.",
  "Package versions match the intended tag.",
  "Workflow safety validation passes through `npm run check:workflows`.",
  "Package artifact dry run passes through `npm run build:packages`.",
  ".github/workflows/release.yml",
  ".github/workflows/publish.yml",
  "Live wallet smoke passes when a trusted `OPENRECEIVE_NWC` is available.",
  "Do not publish"
]) {
  expect(releaseDocs.includes(phrase), `${releaseDocsPath}: missing ${phrase}`);
}

if (findings.length > 0) {
  console.error("Release readiness validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Release readiness validation passed for ${packages.length} package(s).`);
