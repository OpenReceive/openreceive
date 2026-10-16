#!/usr/bin/env node
// Builds the FOSSBilling extension: dist/openreceive-fossbilling-<version>.zip
// unzips into FOSSBilling's own folder. It holds the OpenReceive module
// (modules/Openreceive: settings, routes, console commands, cron hook, the
// engine) and the payment gateway (library/Payment/Adapter/OpenReceive).
// Its dependencies are prefixed with Strauss (OpenReceive\FOSSBilling\Vendor\…)
// inside the module's vendor.phar, so they can never collide with
// FOSSBilling's own packages or another extension's, and the checkout's
// standalone script ships inside it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { bundleDependencies, copyCheckoutAssets } from "./php-extension-bundle.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/php/fossbilling");
const staging = path.join(root, "dist/fossbilling-build");
const tree = path.join(staging, "fossbilling");
const module = path.join(tree, "modules/Openreceive");
const archive = path.join(root, `dist/openreceive-fossbilling-${version}.zip`);
const PREFIX = "OpenReceive\\FOSSBilling\\Vendor\\";
const OWN_CODE = ["Support", "Commands", "Api", "Controller"];
const command = process.argv[2] ?? "plan";

if (command === "plan") {
  console.log(`Build FOSSBilling extension ${version}: ${archive}`);
} else if (command === "build") {
  const declared = readFileSync(
    path.join(source, "src/modules/Openreceive/Support/Runtime.php"),
    "utf8",
  ).match(/const VERSION = '([^']+)'/)?.[1];
  assert.equal(declared, version, "Runtime::VERSION must match the release.");
  const manifest = JSON.parse(
    readFileSync(path.join(source, "src/modules/Openreceive/manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, version, "The module manifest's version must match the release.");

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  cpSync(path.join(source, "src"), tree, { recursive: true });
  for (const name of ["README.md", "LICENSE"]) {
    cpSync(path.join(source, name), path.join(module, name));
  }
  mkdirSync(path.join(module, "assets"));
  copyCheckoutAssets(path.join(module, "assets"), version);
  bundleDependencies({ source, staging, directory: module, prefix: PREFIX, ownCode: OWN_CODE });

  rmSync(archive, { force: true });
  execFileSync("zip", ["-qr", archive, "modules", "library"], { cwd: tree, stdio: "inherit" });
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const stray = entries.filter(
    (entry) =>
      !entry.endsWith("/") &&
      !entry.startsWith("modules/Openreceive/") &&
      !entry.startsWith("library/Payment/Adapter/OpenReceive/"),
  );
  assert.deepEqual(stray, [], "The ZIP may add files only to its own two folders.");
  const loosePhp = entries.filter(
    (entry) =>
      entry.endsWith(".php") &&
      !/^modules\/Openreceive\/((Service|autoload|activate)\.php$|(Support|Commands|Api|Controller)\/)|^library\/Payment\/Adapter\/OpenReceive\/OpenReceive\.php$/.test(
        entry,
      ),
  );
  assert.deepEqual(loosePhp, [], "Only the extension's own PHP may sit outside vendor.phar.");
  console.log(`Built ${archive}`);
} else {
  console.error(`Unknown command ${command}. Use plan or build.`);
  process.exit(2);
}
