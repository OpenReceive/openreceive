#!/usr/bin/env node
// Builds dist/openreceive-odoo-<version>.zip: the Odoo module
// payment_openreceive, its folder at the top of the ZIP, so it unzips into any
// folder on Odoo's addons path. The module carries the checkout's standalone
// script; its Python side is the openreceive package from PyPI, which the
// shop installs with pip at the same version (the module's doctor checks).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { copyCheckoutAssets } from "./php-extension-bundle.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/python/odoo/payment_openreceive");
const staging = path.join(root, "dist/odoo-build");
const module = path.join(staging, "payment_openreceive");
const archive = path.join(root, `dist/openreceive-odoo-${version}.zip`);
const command = process.argv[2] ?? "plan";

if (command === "plan") {
  console.log(`Build Odoo module ${version}: ${archive}`);
} else if (command === "build") {
  const manifest = readFileSync(path.join(source, "__manifest__.py"), "utf8");
  assert.equal(
    manifest.match(/"version":\s*"([^"]+)"/)?.[1],
    version.split("-")[0],
    "The module manifest's version must match the release.",
  );

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(source, module, {
    recursive: true,
    // Bytecode and a local checkout build never ship; the release copies its own.
    filter: (file) =>
      !file.includes("__pycache__") &&
      !file.endsWith(".pyc") &&
      !file.startsWith(path.join(source, "static", "lib")),
  });
  for (const name of ["README.md", "LICENSE"]) {
    cpSync(path.join(root, "packages/python/odoo", name), path.join(module, name));
  }
  const assets = path.join(module, "static/lib/openreceive");
  mkdirSync(assets, { recursive: true });
  copyCheckoutAssets(assets, version);
  // Odoo serves the folder as /payment_openreceive/static/lib/openreceive/.
  assert(existsSync(path.join(assets, "openreceive-checkout.js")));

  rmSync(archive, { force: true });
  execFileSync("zip", ["-qr", archive, "payment_openreceive"], { cwd: staging, stdio: "inherit" });
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
  const stray = entries.filter((entry) => !entry.startsWith("payment_openreceive/"));
  assert.deepEqual(stray, [], "The ZIP holds the module's one folder.");
  assert(
    entries.includes("payment_openreceive/__manifest__.py"),
    "Odoo finds a module by its manifest.",
  );
  console.log(`Built ${archive}`);
} else {
  console.error(`Unknown command ${command}. Use plan or build.`);
  process.exit(2);
}
