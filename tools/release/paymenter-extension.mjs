#!/usr/bin/env node
// Builds the Paymenter gateway extension: dist/openreceive-paymenter-<version>.zip
// holds one OpenReceive/ folder for Paymenter's extensions/Gateways/ directory.
// Its dependencies are prefixed with Strauss (OpenReceive\Paymenter\Vendor\…),
// so they can never collide with Paymenter's own packages or another
// extension's, and the checkout's standalone script ships inside it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { bundleDependencies, copyCheckoutAssets } from "./php-extension-bundle.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/php/paymenter");
const staging = path.join(root, "dist/paymenter-build");
const extension = path.join(staging, "OpenReceive");
const archive = path.join(root, `dist/openreceive-paymenter-${version}.zip`);
const PREFIX = "OpenReceive\\Paymenter\\Vendor\\";
const OWN_CODE = ["Support", "database"];
const command = process.argv[2] ?? "plan";

if (command === "plan") {
  console.log(`Build Paymenter extension ${version}: ${archive}`);
} else if (command === "build") {
  const run = (bin, args, cwd = extension) => execFileSync(bin, args, { cwd, stdio: "inherit" });
  const declared = readFileSync(path.join(source, "Support/Runtime.php"), "utf8").match(
    /const VERSION = '([^']+)'/,
  )?.[1];
  assert.equal(declared, version, "Runtime::VERSION must match the release.");

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(extension, { recursive: true });
  for (const name of [
    "OpenReceive.php",
    "autoload.php",
    "routes.php",
    "Support",
    "resources",
    "database",
    "README.md",
    "LICENSE",
  ]) {
    cpSync(path.join(source, name), path.join(extension, name), { recursive: true });
  }
  mkdirSync(path.join(extension, "assets"));
  copyCheckoutAssets(path.join(extension, "assets"), version);
  // Paymenter's own Composer maps Paymenter\Extensions\ to extensions/, and
  // every optimized autoload dump (each Paymenter upgrade runs one) scans that
  // directory's .php files, so the prefixed dependencies ride in vendor.phar.
  bundleDependencies({ source, staging, directory: extension, prefix: PREFIX, ownCode: OWN_CODE });
  rmSync(archive, { force: true });
  run("zip", ["-qr", archive, "OpenReceive"], staging);
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).split("\n");
  const stray = entries.filter(
    (entry) =>
      entry.endsWith(".php") &&
      !/^OpenReceive\/(OpenReceive|autoload|routes)\.php$|^OpenReceive\/(Support|database|resources)\//.test(
        entry,
      ),
  );
  assert.deepEqual(
    stray,
    [],
    "Only the extension's own PHP may sit in Paymenter's extensions/ directory.",
  );
  console.log(`Built ${archive}`);
} else {
  console.error(`Unknown command ${command}. Use plan or build.`);
  process.exit(2);
}
