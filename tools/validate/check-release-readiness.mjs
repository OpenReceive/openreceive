#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { OPENRECEIVE_PUBLIC_PACKAGE_NAMES } from "../package/public-packages.mjs";
import {
  composerConstraint,
  LARAVEL_COMPOSER_JSON,
  PHP_ENGINE_DIR,
  PHP_VERSION_FILE,
  readLaravelConstraint,
  readPhpVersion,
} from "../release/composer-release.mjs";
import {
  DOTNET_PLUGIN_CSPROJ,
  dotnetPluginVersion,
  readDotnetPluginVersion,
} from "../release/dotnet-plugin.mjs";
import { GEM_NAMES, gemDir, readGemVersion } from "../release/gem-release.mjs";
import {
  PYTHON_PACKAGE_DIR,
  PYTHON_VERSION_FILE,
  pep440Version,
  readPythonVersion,
} from "../release/pypi-release.mjs";

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
const parallelLanes = testCiRelease
  .split(" && ")
  .filter((command) => command.startsWith("node tools/ci/parallel.mjs "))
  .flatMap((command) => command.trim().split(/\s+/).slice(2));
const testCiArtifacts = parallelLanes.includes("test:ci:artifacts")
  ? (rootPackage.scripts?.["test:ci:artifacts"] ?? "")
  : "";
expect(
  testCi.includes("npm run check:release") ||
    (testCi.includes("npm run test:ci:release") &&
      [testCiRelease, testCiArtifacts].some((command) =>
        command.includes("npm run check:release"),
      )),
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
    for (const requiredFile of [
      "README.md",
      "LICENSE",
      // The agent-skills copy every package ships; `npm run generate:skills`
      // materializes it and `npm run check:docs` keeps it in sync.
      "skills/integrate-openreceive/SKILL.md",
      "skills/debug-openreceive-payment/SKILL.md",
    ]) {
      expect(
        existsSync(path.join(root, packageDir, requiredFile)),
        `${packageDir}: missing ${requiredFile}`,
      );
    }
  }
}

// The BTCPay plugin releases in lockstep too (System.Version: no prerelease suffix).
{
  const pluginVersion = readDotnetPluginVersion(root);
  expect(pluginVersion !== undefined, `${DOTNET_PLUGIN_CSPROJ}: missing <Version>`);
  expect(
    pluginVersion === dotnetPluginVersion(releaseVersion),
    `${DOTNET_PLUGIN_CSPROJ}: plugin version ${pluginVersion} must match ${dotnetPluginVersion(releaseVersion)} (run npm run release:prepare)`,
  );
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
    "skills/integrate-openreceive/SKILL.md",
    "skills/debug-openreceive-payment/SKILL.md",
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

// The PyPI distribution releases in lockstep too, spelled PEP 440.
{
  const pythonVersion = readPythonVersion(root);
  expect(pythonVersion !== undefined, `${PYTHON_VERSION_FILE}: missing __version__`);
  expect(
    pythonVersion === pep440Version(releaseVersion),
    `${PYTHON_VERSION_FILE}: __version__ ${pythonVersion} must be ${pep440Version(releaseVersion)} (run npm run release:prepare)`,
  );
  for (const requiredFile of ["pyproject.toml", "uv.lock", "README.md", "LICENSE"]) {
    expect(
      existsSync(path.join(root, PYTHON_PACKAGE_DIR, requiredFile)),
      `${PYTHON_PACKAGE_DIR}: missing ${requiredFile}`,
    );
  }
  expect(
    rootPackage.scripts?.["release:pypi:build"] === "node tools/release/pypi-release.mjs build",
    "package.json: missing release:pypi:build script",
  );
  expect(
    testCiRelease.includes("npm run test:python") || parallelLanes.includes("test:python"),
    "package.json: test:ci:release must run the Python engine suite (test:python)",
  );
}

// The Composer packages release in lockstep too: OpenReceive\Version::VERSION is
// the engine's version (composer.json carries none; Packagist tags), and the
// Laravel adapter pins the engine to the `~X.Y.Z` lockstep constraint. Both are
// written by release:prepare.
{
  const phpVersion = readPhpVersion(root);
  expect(phpVersion !== undefined, `${PHP_VERSION_FILE}: missing Version::VERSION`);
  expect(
    phpVersion === releaseVersion,
    `${PHP_VERSION_FILE}: VERSION ${phpVersion} must match ${releaseVersion} (run npm run release:prepare)`,
  );
  const engineManifest = readJson(path.join(PHP_ENGINE_DIR, "composer.json"));
  const wordpressManifest = readJson("packages/php/wordpress/composer.json");
  expect(
    wordpressManifest.require["openreceive/openreceive"] === composerConstraint(releaseVersion),
    "WordPress engine constraint must match the workspace release",
  );
  const wordpressHeader = readFileSync(
    path.join(root, "packages/php/wordpress/openreceive.php"),
    "utf8",
  );
  expect(
    wordpressHeader.includes(`Version: ${releaseVersion}\n`) &&
      wordpressHeader.includes(`'OPENRECEIVE_PLUGIN_VERSION', '${releaseVersion}'`),
    "WordPress plugin version must match the workspace release",
  );
  expect(
    engineManifest.name === "openreceive/openreceive",
    `${PHP_ENGINE_DIR}/composer.json: name must be openreceive/openreceive`,
  );
  expect(
    engineManifest.version === undefined,
    `${PHP_ENGINE_DIR}/composer.json: must not carry a version field (Packagist versions from tags)`,
  );
  for (const requiredFile of ["composer.json", "README.md", "LICENSE"]) {
    expect(
      existsSync(path.join(root, PHP_ENGINE_DIR, requiredFile)),
      `${PHP_ENGINE_DIR}: missing ${requiredFile}`,
    );
  }
  // The Laravel adapter is checked only once it exists in the tree.
  if (existsSync(path.join(root, LARAVEL_COMPOSER_JSON))) {
    const constraint = readLaravelConstraint(root);
    expect(
      constraint === composerConstraint(releaseVersion),
      `${LARAVEL_COMPOSER_JSON}: openreceive/openreceive must be ${composerConstraint(releaseVersion)}, got ${constraint} (run npm run release:prepare)`,
    );
  }
  expect(
    rootPackage.scripts?.["release:composer:build"] ===
      "node tools/release/composer-release.mjs build",
    "package.json: missing release:composer:build script",
  );
  expect(
    testCiRelease.includes("npm run test:php") || parallelLanes.includes("test:php"),
    "package.json: test:ci:release must run the PHP engine suite (test:php)",
  );
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
  "Agent skills describe the current public API.",
  "npm run generate:skills",
  "Public package manifests are public while testkit stays private.",
  "Package versions match the intended tag.",
  "Workflow safety validation passes through `npm run check:workflows`.",
  "Package artifact dry run passes through `npm run build:packages`.",
  ".github/workflows/release.yml",
  ".github/workflows/publish-gems.yml",
  ".github/workflows/publish-pypi.yml",
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
