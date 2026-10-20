#!/usr/bin/env node
// Publishes the Odoo module to the Odoo Apps store (apps.odoo.com). The store
// scans a Git repository registered with it, one branch per Odoo series, for
// module folders at the top of the branch: OpenReceive/odoo, branches 19.0 and
// 20.0. Each branch holds the module as the GitHub release's ZIP has it, with
// the manifest version under that series (19.0.0.4.31), as the store files a
// version under the series it names. Run it after the GitHub release is
// published: it takes the ZIP from the release, not from a local build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { root } from "../shared/root.mjs";

// The series the module installs on and its CI runs; one store branch each.
export const ODOO_SERIES = ["19.0", "20.0"];
export const STORE_REPOSITORY = "OpenReceive/odoo";
const MODULE = "payment_openreceive";

/** The manifest with its version under `series`: "0.4.31" becomes "19.0.0.4.31". */
export function seriesManifest(manifest, series, version) {
  const line = `"version": "${version}"`;
  assert.equal(
    manifest.split(line).length,
    2,
    `The module manifest must name version ${version} exactly once.`,
  );
  return manifest.replace(line, `"version": "${series}.${version}"`);
}

// The store keeps links to the module's own files, YouTube, Teams, mailto: and
// skype:, and invalidates any other; it runs no JavaScript.
const ALLOWED_LINK =
  /^(mailto:|skype:|https:\/\/(www\.)?youtube\.com\/|https:\/\/youtu\.be\/|https:\/\/teams\.microsoft\.com\/)/;

/** What in a description page breaks the store's rules for static/description/index.html. */
export function descriptionProblems(html) {
  const problems = [];
  for (const [, attribute, value] of html.matchAll(/\b(href|src)="([^"]*)"/g)) {
    const external = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(value);
    if (external && !ALLOWED_LINK.test(value)) problems.push(`${attribute} to ${value}`);
  }
  if (/<script\b/i.test(html)) problems.push("a <script> tag");
  if (/<(style|link|iframe|form)\b/i.test(html))
    problems.push("a <style>, <link>, <iframe> or <form> tag");
  if (/\son[a-z]+=/i.test(html)) problems.push("an inline event handler");
  return problems;
}

/** The images a description page and the manifest name, relative to the module folder. */
export function moduleImages(manifest, html) {
  const fromManifest = [
    ...(manifest.match(/"images":\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
  ].map(([, file]) => file);
  const fromPage = [...html.matchAll(/\bsrc="([^"]+)"/g)].map(
    ([, file]) => `static/description/${file}`,
  );
  return [...new Set([...fromManifest, ...fromPage])];
}

/** Checks a module folder the way the store reads it, and returns its manifest. */
export function checkStoreModule(moduleDir) {
  const manifest = readFileSync(path.join(moduleDir, "__manifest__.py"), "utf8");
  const html = readFileSync(path.join(moduleDir, "static/description/index.html"), "utf8");
  assert(
    existsSync(path.join(moduleDir, "static/description/icon.png")),
    "The store shows static/description/icon.png.",
  );
  assert.match(
    manifest,
    /"images":\s*\[\s*"/,
    "The store's cover image comes from the manifest's images.",
  );
  assert.match(
    manifest,
    /"license":\s*"[^"]+"/,
    "The store ranks a module without a license lower.",
  );
  const problems = descriptionProblems(html);
  assert.deepEqual(problems, [], `index.html breaks the store's rules: ${problems.join("; ")}`);
  const missing = moduleImages(manifest, html).filter(
    (file) => !existsSync(path.join(moduleDir, file)),
  );
  assert.deepEqual(missing, [], `Images not in the module: ${missing.join(", ")}`);
  return manifest;
}

function storeReadme(version, series) {
  return `# OpenReceive for Odoo

The Odoo module \`payment_openreceive\` from OpenReceive ${version}, for Odoo
${series}, as the [Odoo Apps store](https://apps.odoo.com) installs it.

This repository is generated. Each branch (\`${ODOO_SERIES.join("`, `")}\`) holds
the module from an OpenReceive release, with its version under that Odoo
series. The source, issues and pull requests are in
[OpenReceive/openreceive](https://github.com/OpenReceive/openreceive/tree/master/packages/python/odoo).

To install, copy \`payment_openreceive\` into a folder on Odoo's addons path and
install the Python package at the same version, which \`requirements.txt\`
lists: \`pip install openreceive==${version}\`. Then install **Payment
Provider: OpenReceive** under Apps. Setup:
[Odoo quickstart](https://openreceive.org/guides/quickstart-odoo).

MIT licensed.
`;
}

/** Writes one store branch's files for `series` into `out`. */
export function writeStoreTree(moduleDir, out, series, version) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(moduleDir, path.join(out, MODULE), { recursive: true });
  const manifestPath = path.join(out, MODULE, "__manifest__.py");
  writeFileSync(manifestPath, seriesManifest(readFileSync(manifestPath, "utf8"), series, version));
  cpSync(path.join(root, "packages/python/odoo/LICENSE"), path.join(out, "LICENSE"));
  writeFileSync(path.join(out, "README.md"), storeReadme(version, series));
  writeFileSync(path.join(out, "requirements.txt"), `openreceive==${version}\n`);
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", ...options });
}

/** OpenReceive/odoo through the same remote host as this checkout's origin. */
function defaultRemote() {
  const origin = git(root, ["remote", "get-url", "origin"]).trim();
  assert.match(
    origin,
    /OpenReceive\/openreceive(\.git)?$/,
    `Unexpected origin ${origin}; pass --remote.`,
  );
  return origin.replace(/OpenReceive\/openreceive(\.git)?$/, `${STORE_REPOSITORY}.git`);
}

async function releaseZip(version, zipArg, work) {
  if (zipArg) return path.resolve(zipArg);
  const name = `openreceive-odoo-${version}.zip`;
  const url = `https://github.com/OpenReceive/openreceive/releases/download/v${version}/${name}`;
  const response = await fetch(url);
  assert(response.ok, `${url} answered ${response.status}; publish the GitHub release first.`);
  const file = path.join(work, name);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

async function build(version, args, work) {
  const zip = await releaseZip(version, args.zip, work);
  const unpacked = path.join(work, "release");
  rmSync(unpacked, { recursive: true, force: true });
  execFileSync("unzip", ["-q", zip, "-d", unpacked]);
  const moduleDir = path.join(unpacked, MODULE);
  const manifest = checkStoreModule(moduleDir);
  assert.equal(
    manifest.match(/"version":\s*"([^"]+)"/)?.[1],
    version,
    `${path.basename(zip)} holds another version of the module.`,
  );
  for (const series of ODOO_SERIES) {
    writeStoreTree(moduleDir, path.join(work, series), series, version);
    console.log(
      `Built ${path.relative(root, path.join(work, series))}: ${MODULE} ${series}.${version}`,
    );
  }
}

/**
 * Commits each series' tree from `work` to its branch of `remote` and pushes
 * it; a branch already holding the same files is left alone.
 */
export function publishTrees({ version, work, remote, identity }) {
  const clone = path.join(work, "repository");
  rmSync(clone, { recursive: true, force: true });
  git(work, ["clone", "--quiet", "--no-checkout", remote, clone], { stdio: "pipe" });
  const author = Object.entries(identity).flatMap(([key, value]) => ["-c", `user.${key}=${value}`]);
  for (const series of ODOO_SERIES) {
    const exists = git(clone, ["ls-remote", "--heads", "origin", series]).trim() !== "";
    if (exists) git(clone, ["checkout", "--quiet", "-B", series, `origin/${series}`]);
    else git(clone, ["checkout", "--quiet", "--orphan", series]);
    git(clone, ["rm", "-rqf", "--ignore-unmatch", "."]);
    cpSync(path.join(work, series), clone, { recursive: true });
    git(clone, ["add", "-A"]);
    const unchanged = exists && git(clone, ["status", "--porcelain"]).trim() === "";
    if (unchanged) {
      console.log(`${series}: already ${series}.${version}`);
      continue;
    }
    git(clone, [...author, "commit", "--quiet", "-m", `OpenReceive ${version} for Odoo ${series}`]);
    git(clone, ["push", "--quiet", "origin", `${series}:${series}`], { stdio: "inherit" });
    console.log(`${series}: pushed ${series}.${version} to ${remote}`);
  }
}

function publish(version, args, work) {
  // Commits carry the release identity of this checkout.
  const identity = Object.fromEntries(
    ["name", "email"].map((key) => [key, git(root, ["config", `user.${key}`]).trim()]),
  );
  publishTrees({ version, work, remote: args.remote ?? defaultRemote(), identity });
  console.log(
    `The store rescans the branches it has registered; first time, register at https://apps.odoo.com/apps/upload: ${ODOO_SERIES.map((series) => `ssh://git@github.com/${STORE_REPOSITORY}#${series}`).join(" and ")}`,
  );
}

export async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { zip: { type: "string" }, remote: { type: "string" } },
  });
  const command = positionals[0] ?? "plan";
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const work = path.join(root, "dist/odoo-apps");
  if (command === "plan") {
    console.log(
      `Odoo Apps ${version}: ${ODOO_SERIES.map((series) => `${STORE_REPOSITORY}#${series} = ${series}.${version}`).join(", ")}`,
    );
    return;
  }
  assert(
    ["build", "publish"].includes(command),
    `Unknown command ${command}. Use plan, build or publish.`,
  );
  // The store takes digits only, and a prerelease does not go to the store.
  assert.match(
    version,
    /^\d+\.\d+\.\d+$/,
    `${version} is a prerelease; the store gets releases only.`,
  );
  mkdirSync(work, { recursive: true });
  await build(version, values, work);
  if (command === "publish") publish(version, values, work);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
