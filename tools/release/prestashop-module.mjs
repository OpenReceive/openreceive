#!/usr/bin/env node
// Builds dist/openreceive-prestashop-<version>.zip, the PrestaShop module: one
// top-level openreceive/ folder, which PrestaShop's "Upload a module" button
// (or unzipping into modules/) expects. Its dependencies are prefixed with
// Strauss (OpenReceive\PrestaShop\Vendor\…) inside the module's vendor.phar,
// so they can never collide with PrestaShop's own packages or another
// module's, and the checkout's standalone script ships in views/assets.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { bundleDependencies, copyCheckoutAssets } from "./php-extension-bundle.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/php/prestashop");
const staging = path.join(root, "dist/prestashop-build");
const module = path.join(staging, "openreceive");
const archive = path.join(root, `dist/openreceive-prestashop-${version}.zip`);
const PREFIX = "OpenReceive\\PrestaShop\\Vendor\\";
const OWN_CODE = ["src"];
const command = process.argv[2] ?? "plan";

if (command === "plan") {
  console.log(`Build PrestaShop module ${version}: ${archive}`);
} else if (command === "build") {
  const declared = readFileSync(path.join(source, "openreceive/src/Runtime.php"), "utf8").match(
    /const VERSION = '([^']+)'/,
  )?.[1];
  assert.equal(declared, version, "Runtime::VERSION must match the release.");
  const moduleVersion = readFileSync(
    path.join(source, "openreceive/openreceive.php"),
    "utf8",
  ).match(/\$this->version = '([^']+)'/)?.[1];
  assert.equal(moduleVersion, version, "The module's $this->version must match the release.");

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(path.join(source, "openreceive"), module, { recursive: true });
  for (const name of ["README.md", "LICENSE"]) {
    cpSync(path.join(source, name), path.join(module, name));
  }
  mkdirSync(path.join(module, "views/assets"), { recursive: true });
  copyCheckoutAssets(path.join(module, "views/assets"), version);
  bundleDependencies({ source, staging, directory: module, prefix: PREFIX, ownCode: OWN_CODE });
  // PrestaShop includes an enabled module's vendor/autoload.php before it
  // builds its services, which is how bin/console finds the module's commands.
  mkdirSync(path.join(module, "vendor"));
  writeFileSync(
    path.join(module, "vendor/autoload.php"),
    "<?php\n\n// PrestaShop loads this for an enabled module; the module's own autoloader does the work.\nrequire_once dirname(__DIR__) . '/autoload.php';\n",
  );

  // The main file and the front controllers reach the engine only through src/.
  for (const file of [
    "openreceive.php",
    "controllers/front/api.php",
    "controllers/front/validation.php",
  ]) {
    assert(
      !/^use OpenReceive\\/m.test(readFileSync(path.join(module, file), "utf8")),
      `${file} must not import the engine directly.`,
    );
  }

  rmSync(archive, { force: true });
  execFileSync("zip", ["-qr", archive, "openreceive"], { cwd: staging, stdio: "inherit" });
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"));
  assert.deepEqual(
    entries.filter((entry) => !entry.startsWith("openreceive/")),
    [],
    "The ZIP holds one folder, openreceive/.",
  );
  const loosePhp = entries.filter(
    (entry) =>
      entry.endsWith(".php") &&
      !/^openreceive\/((openreceive|autoload|vendor\/autoload)\.php|controllers\/front\/(api|validation)\.php|src\/.+\.php)$/.test(
        entry,
      ),
  );
  assert.deepEqual(loosePhp, [], "Only the module's own PHP may sit outside vendor.phar.");
  for (const required of [
    "openreceive/openreceive.php",
    "openreceive/logo.png",
    "openreceive/config/services.yml",
    "openreceive/vendor.phar",
    "openreceive/views/assets/openreceive-checkout.js",
  ]) {
    assert(entries.includes(required), `The ZIP must hold ${required}.`);
  }
  console.log(`Built ${archive}`);
} else {
  console.error(`Unknown command ${command}. Use plan or build.`);
  process.exit(2);
}
