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

const rootPackage = readJson("package.json");
const packages = workspacePackages();
const changelog = read("CHANGELOG.md");
const releaseDocs = read("docs/12-release-process.md");

expect(rootPackage.name === "openreceive", "package.json: root package name must be openreceive");
expect(rootPackage.version === "0.1.0", "package.json: root version must be 0.1.0");
expect(rootPackage.private === true, "package.json: root package must stay private before explicit publishing approval");
expect(rootPackage.scripts?.["test:ci"]?.includes("npm run check:release"), "package.json: test:ci must include check:release");
expect(rootPackage.scripts?.["check:release"] === "node tools/validate/check-release-readiness.mjs", "package.json: missing check:release script");
expect(rootPackage.scripts?.["test:package-smoke"], "package.json: release gate must keep package smoke script");

for (const { relativePath, manifest } of packages) {
  expect(manifest.version === "0.1.0", `${relativePath}: package version must be 0.1.0`);
  expect(manifest.private === true, `${relativePath}: package must stay private before explicit publishing approval`);
  expect(typeof manifest.exports?.["."] === "string", `${relativePath}: package must expose a root export`);
}

expect(/^# Changelog/m.test(changelog), "CHANGELOG.md: missing top-level heading");
expect(/^## 0\.1\.0 - Unreleased$/m.test(changelog), "CHANGELOG.md: missing 0.1.0 unreleased section");
for (const phrase of [
  "demo deployment templates",
  "public demo deployment docs",
  "deterministic mock wallet"
]) {
  expect(changelog.includes(phrase), `CHANGELOG.md: missing ${phrase} entry`);
}

for (const { manifest } of packages) {
  expect(
    releaseDocs.includes(`\`${manifest.name}\``),
    `docs/12-release-process.md: missing ${manifest.name}`
  );
}
for (const phrase of [
  "npm run test:ci",
  "Changelog updated.",
  "Package versions match the intended tag.",
  "Live wallet smoke passes when a trusted `OPENRECEIVE_NWC` is available.",
  "Do not publish"
]) {
  expect(releaseDocs.includes(phrase), `docs/12-release-process.md: missing ${phrase}`);
}

if (findings.length > 0) {
  console.error("Release readiness validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Release readiness validation passed for ${packages.length} package(s).`);
