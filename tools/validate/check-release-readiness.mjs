#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OPENRECEIVE_PUBLIC_PACKAGE_NAMES } from "../package/public-packages.mjs";
import { GEM_NAMES, readGemVersion, gemDir } from "../release/gem-release.mjs";

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
        manifest: readJson(relativePath),
      };
    })
    .filter(
      ({ manifest }) =>
        manifest.name === "openreceive" || manifest.name?.startsWith("@openreceive/"),
    )
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

// The openreceive CLI package ships a bin and no library surface at all.
function isBinOnlyPackage(manifest) {
  return (
    typeof manifest.bin === "object" &&
    manifest.exports === undefined &&
    manifest.main === undefined &&
    manifest.types === undefined
  );
}

function hasRootExport(manifest) {
  const rootExport = manifest.exports?.["."];
  if (typeof rootExport === "string") return true;
  if (rootExport === null || typeof rootExport !== "object" || Array.isArray(rootExport))
    return false;
  return (
    typeof rootExport.import === "string" ||
    typeof rootExport.require === "string" ||
    // Angular Package Format (ng-packagr) maps use the `default` condition.
    typeof rootExport.default === "string"
  );
}

const rootPackage = readJson("package.json");
const packages = workspacePackages();
const changelog = read("CHANGELOG.md");
const releaseDocsPath = "docs/internal/release-process.md";
const releaseDocs = read(releaseDocsPath);
const publicPackages = new Set(OPENRECEIVE_PUBLIC_PACKAGE_NAMES);
const releaseVersion = rootPackage.version;

expect(
  rootPackage.name === "openreceive-workspace",
  "package.json: root package name must be openreceive-workspace",
);
expect(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.test(releaseVersion),
  "package.json: root version must be semver",
);
expect(
  rootPackage.private === true,
  "package.json: root package must stay private before explicit publishing approval",
);
const testCi = rootPackage.scripts?.["test:ci"] ?? "";
const testCiRelease = rootPackage.scripts?.["test:ci:release"] ?? "";
expect(
  testCi.includes("npm run check:release") ||
    (testCi.includes("test:ci:release") && testCiRelease.includes("npm run check:release")),
  "package.json: test:ci must include check:release",
);
expect(
  rootPackage.scripts?.["check:release"] === "node tools/validate/check-release-readiness.mjs",
  "package.json: missing check:release script",
);
for (const { relativePath, manifest } of packages) {
  if (manifest.scripts?.build === undefined) continue;
  expect(
    rootPackage.scripts?.["build:packages"]?.includes(`-w ${manifest.name}`),
    `package.json: build:packages must build ${manifest.name} (${relativePath} has a build script)`,
  );
}
expect(
  rootPackage.scripts?.["test:package-smoke"],
  "package.json: release gate must keep package smoke script",
);
expect(
  rootPackage.scripts?.["release:plan"] === "node tools/release/npm-release.mjs plan",
  "package.json: missing release:plan script",
);
expect(
  rootPackage.scripts?.["release:prepare"] === "node tools/release/npm-release.mjs prepare",
  "package.json: missing release:prepare script",
);
expect(
  rootPackage.scripts?.["release:publish"] === "node tools/release/npm-release.mjs publish",
  "package.json: missing release:publish script",
);

for (const { relativePath, manifest } of packages) {
  expect(
    manifest.version === releaseVersion,
    `${relativePath}: package version must match ${releaseVersion}`,
  );
  if (publicPackages.has(manifest.name)) {
    expect(manifest.private !== true, `${relativePath}: public package must not be private`);
  } else {
    expect(manifest.private === true, `${relativePath}: private package must stay private`);
  }
  expect(
    hasRootExport(manifest) || isBinOnlyPackage(manifest),
    `${relativePath}: package must expose a root export (or be bin-only)`,
  );

  // npm-page completeness: these fields are what the registry renders, and a
  // publish without them ships a bare listing that cannot be amended for that
  // version.
  const packageDir = path.dirname(relativePath);
  expect(
    typeof manifest.description === "string" && manifest.description.length > 0,
    `${relativePath}: missing description`,
  );
  expect(
    manifest.author === "OpenReceive <info@openreceive.org>",
    `${relativePath}: author must be OpenReceive <info@openreceive.org>`,
  );
  expect(
    manifest.bugs?.url === "https://github.com/openreceive/openreceive/issues",
    `${relativePath}: missing bugs.url`,
  );
  if (publicPackages.has(manifest.name)) {
    expect(
      Array.isArray(manifest.keywords) && manifest.keywords.length > 0,
      `${relativePath}: missing keywords`,
    );
    expect(typeof manifest.engines?.node === "string", `${relativePath}: missing engines.node`);
    expect(
      manifest.publishConfig?.access === "public",
      `${relativePath}: publishConfig.access must be "public"`,
    );
    expect(
      manifest.scripts?.build === undefined || typeof manifest.scripts?.prepack === "string",
      `${relativePath}: a package with a build script must also build on prepack`,
    );
    expect(
      manifest.repository?.url === "git+https://github.com/openreceive/openreceive.git",
      `${relativePath}: repository.url must be git+https://github.com/openreceive/openreceive.git`,
    );
    for (const requiredFile of ["README.md", "LICENSE"]) {
      expect(
        existsSync(path.join(root, packageDir, requiredFile)),
        `${packageDir}: missing ${requiredFile}`,
      );
    }
  }
}

// Ruby gems release in lockstep with the npm workspace version.
for (const gemName of GEM_NAMES) {
  const gemRoot = gemDir(root, gemName);
  const gemPath = path.relative(root, gemRoot);
  let gemVersion;
  try {
    gemVersion = readGemVersion(root, gemName);
  } catch (error) {
    fail(`${gemPath}: ${error.message}`);
    continue;
  }
  expect(
    gemVersion === releaseVersion,
    `${gemPath}: gem version ${gemVersion} must match ${releaseVersion} (run npm run release:prepare)`,
  );
  for (const requiredFile of [
    `${gemName}.gemspec`,
    "Gemfile",
    "Rakefile",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    expect(existsSync(path.join(gemRoot, requiredFile)), `${gemPath}: missing ${requiredFile}`);
  }
  const gemChangelogPath = path.join(gemRoot, "CHANGELOG.md");
  if (existsSync(gemChangelogPath)) {
    const gemChangelog = readFileSync(gemChangelogPath, "utf8");
    expect(
      new RegExp(
        `^## ${releaseVersion.replace(/\./g, "\\.")} - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`,
        "m",
      ).test(gemChangelog),
      `${gemPath}/CHANGELOG.md: missing ${releaseVersion} section`,
    );
  }
}

expect(/^# Changelog/m.test(changelog), "CHANGELOG.md: missing top-level heading");
// The section stays "- Unreleased" until `npm run release:stamp` dates it at
// release time; both forms are release-ready.
expect(
  new RegExp(
    `^## ${releaseVersion.replace(/\./g, "\\.")} - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`,
    "m",
  ).test(changelog),
  `CHANGELOG.md: missing ${releaseVersion} section`,
);
// Structural checks only: pinning literal changelog prose broke release
// checks whenever an entry was reworded for no release-safety reason.

for (const { manifest } of packages) {
  expect(
    releaseDocs.includes(`\`${manifest.name}\``),
    `${releaseDocsPath}: missing ${manifest.name}`,
  );
}
for (const phrase of [
  "npm run test:ci",
  "Changelog updated.",
  "Public package manifests are public while testkit stays private.",
  "Package versions match the intended tag.",
  "Workflow safety validation passes through `npm run check:workflows`.",
  "Package artifact dry run passes through `npm run build:packages`.",
  ".github/workflows/release.yml",
  ".github/workflows/publish.yml",
  "Live wallet smoke passes when a trusted `NWC_URI` is available in the environment.",
  "Do not publish",
]) {
  expect(releaseDocs.includes(phrase), `${releaseDocsPath}: missing ${phrase}`);
}

if (findings.length > 0) {
  console.error("Release readiness validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Release readiness validation passed for ${packages.length} package(s).`);
