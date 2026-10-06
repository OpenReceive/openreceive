#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPENRECEIVE_PUBLIC_PACKAGE_NAMES } from "../package/public-packages.mjs";
import { root } from "../shared/root.mjs";
import { GEM_NAMES, toGemVersion } from "./gem-release.mjs";
import { pep440Version } from "./pypi-release.mjs";

// GitHub assets are the installable public family. Composer has split tags;
// BTCPay has its own separately authorized release and version.
export function releaseArtifacts(version, gemVersion = toGemVersion(root, version)) {
  const pythonVersion = pep440Version(version);
  return [
    ...OPENRECEIVE_PUBLIC_PACKAGE_NAMES.map(
      (name) =>
        `.release/npm/${version}/tarballs/${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`,
    ),
    ...GEM_NAMES.map((name) => `.release/gems/${version}/published/${name}-${gemVersion}.gem`),
    `.release/pypi/${version}/openreceive-${pythonVersion}-py3-none-any.whl`,
    `.release/pypi/${version}/openreceive-${pythonVersion}.tar.gz`,
    `dist/standalone-checkout-${version}.tar.gz`,
    `dist/openreceive-wordpress-${version}.zip`,
    `dist/openreceive-docs-${version}.tar.gz`,
  ];
}

export function assertReleaseAssets(version, names, gemVersion) {
  const missing = releaseArtifacts(version, gemVersion)
    .map((file) => path.basename(file))
    .filter((name) => !names.includes(name));
  assert.equal(missing.length, 0, `Incomplete release v${version}; missing: ${missing.join(", ")}`);
}

export function main(args) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const files = releaseArtifacts(version);
  const [command = "check", notes] = args;
  if (command === "github") {
    const release = JSON.parse(
      execFileSync(
        "gh",
        ["release", "view", `v${version}`, "--repo", "OpenReceive/openreceive", "--json", "assets"],
        { encoding: "utf8" },
      ),
    );
    assertReleaseAssets(
      version,
      release.assets.map((asset) => asset.name),
    );
    console.log(`GitHub v${version}: all ${files.length} required assets present.`);
    return;
  }
  assert(
    ["check", "draft", "list"].includes(command),
    "Usage: github-artifacts.mjs check|list|github|draft <notes-file>",
  );
  if (command === "list") {
    console.log(files.join("\n"));
    return;
  }
  const missing = files.filter((file) => !existsSync(path.join(root, file)));
  assert.equal(
    missing.length,
    0,
    `Build or fetch these exact release artifacts first:\n${missing.join("\n")}`,
  );
  if (command === "draft") {
    assert(notes && existsSync(notes), "Provide a release notes file.");
    execFileSync(
      "gh",
      [
        "release",
        "create",
        `v${version}`,
        "--repo",
        "OpenReceive/openreceive",
        "--verify-tag",
        "--draft",
        "--title",
        `OpenReceive v${version}`,
        "--notes-file",
        notes,
        ...files,
      ],
      { cwd: root, stdio: "inherit" },
    );
  } else console.log(`All ${files.length} required release artifacts present.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2));
