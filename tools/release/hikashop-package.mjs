#!/usr/bin/env node
// Builds dist/openreceive-hikashop-<version>.zip, a Joomla package
// (pkg_openreceive) that Joomla's System → Install → Extensions, or
// `php cli/joomla.php extension:install --path=…`, installs. It holds two
// plugin ZIPs: the HikaShop payment plugin (plg_hikashoppayment_openreceive)
// and its Joomla console commands (plg_console_openreceive). The payment
// plugin's dependencies are prefixed with Strauss (OpenReceive\HikaShop\
// Vendor\…) as plain files in its vendor/, so they can never collide with
// Joomla's own packages or another extension's, and a Joomla Extensions
// Directory reviewer can read every file. The checkout's standalone script
// ships as the plugin's media files. The package is GPL-2.0-or-later, as the
// Joomla Extensions Directory requires; the MIT engine inside it is
// GPL-compatible.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { bundleDependencies, copyCheckoutAssets } from "./php-extension-bundle.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/php/hikashop");
const staging = path.join(root, "dist/hikashop-build");
const payment = path.join(staging, "plg_hikashoppayment_openreceive");
const consolePlugin = path.join(staging, "plg_console_openreceive");
const pkg = path.join(staging, "pkg");
const archive = path.join(root, `dist/openreceive-hikashop-${version}.zip`);
const PREFIX = "OpenReceive\\HikaShop\\Vendor\\";
const OWN_CODE = ["src"];
const MANIFESTS = [
  "pkg_openreceive.xml",
  "plg_hikashoppayment_openreceive/openreceive.xml",
  "plg_console_openreceive/openreceive.xml",
];
const command = process.argv[2] ?? "plan";

const list = (zip) =>
  execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => entry !== "" && !entry.endsWith("/"));

if (command === "plan") {
  console.log(`Build HikaShop package ${version}: ${archive}`);
} else if (command === "build") {
  const declared = readFileSync(
    path.join(source, "plg_hikashoppayment_openreceive/src/Runtime.php"),
    "utf8",
  ).match(/const VERSION = '([^']+)'/)?.[1];
  assert.equal(declared, version, "Runtime::VERSION must match the release.");
  for (const manifest of MANIFESTS) {
    const manifestVersion = readFileSync(path.join(source, manifest), "utf8").match(
      /<version>([^<]+)<\/version>/,
    )?.[1];
    assert.equal(manifestVersion, version, `${manifest}'s <version> must match the release.`);
  }

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(path.join(source, "plg_hikashoppayment_openreceive"), payment, { recursive: true });
  cpSync(path.join(source, "plg_console_openreceive"), consolePlugin, { recursive: true });
  for (const dir of [payment, consolePlugin]) {
    cpSync(path.join(source, "LICENSE"), path.join(dir, "LICENSE"));
  }
  mkdirSync(path.join(payment, "media"), { recursive: true });
  copyCheckoutAssets(path.join(payment, "media"), version);
  bundleDependencies({
    source,
    staging,
    directory: payment,
    prefix: PREFIX,
    ownCode: OWN_CODE,
    // Every PHP file of the plugin exits unless Joomla is running.
    preamble: "define('_JEXEC', 1); ",
    archive: "directory",
  });
  // Joomla installs only the files a manifest lists; the bundle's shipped
  // composer.json describes vendor/ for nobody here.
  rmSync(path.join(payment, "composer.json"));

  // The plugin's entry file reaches the engine only through src/.
  assert(
    !/^use (OpenReceive|Nyholm|Brick|Psr)\\/m.test(
      readFileSync(path.join(payment, "openreceive.php"), "utf8"),
    ),
    "openreceive.php must not import the engine or its dependencies directly.",
  );

  mkdirSync(path.join(pkg, "packages"), { recursive: true });
  for (const dir of [payment, consolePlugin]) {
    execFileSync("zip", ["-qr", path.join(pkg, "packages", `${path.basename(dir)}.zip`), "."], {
      cwd: dir,
      stdio: "inherit",
    });
  }
  for (const name of ["pkg_openreceive.xml", "script.php", "LICENSE", "README.md", "language"]) {
    cpSync(path.join(source, name), path.join(pkg, name), { recursive: true });
  }

  rmSync(archive, { force: true });
  execFileSync("zip", ["-qr", archive, "."], { cwd: pkg, stdio: "inherit" });

  assert.deepEqual(
    list(archive).sort(),
    [
      "LICENSE",
      "README.md",
      "language/en-GB/pkg_openreceive.sys.ini",
      "packages/plg_console_openreceive.zip",
      "packages/plg_hikashoppayment_openreceive.zip",
      "pkg_openreceive.xml",
      "script.php",
    ],
    "The package holds its manifest, install script, language file, license, readme and two plugin ZIPs.",
  );
  const paymentEntries = list(path.join(pkg, "packages/plg_hikashoppayment_openreceive.zip"));
  const loosePhp = paymentEntries.filter(
    (entry) =>
      entry.endsWith(".php") &&
      !/^((openreceive|autoload)\.php|(src|vendor)\/.+\.php)$/.test(entry),
  );
  assert.deepEqual(loosePhp, [], "Only the plugin's own PHP may sit outside vendor/.");
  assert(!paymentEntries.includes("vendor.phar"), "The payment plugin ships no phar.");
  // The Joomla Extensions Directory's checker wants the _JEXEC guard in every
  // PHP file outside a library folder (vendor/ is one).
  const paymentZip = path.join(pkg, "packages/plg_hikashoppayment_openreceive.zip");
  for (const entry of paymentEntries.filter((name) => /^(src\/.+|[^/]+)\.php$/.test(name))) {
    const code = execFileSync("unzip", ["-p", paymentZip, entry], { encoding: "utf8" });
    assert.match(
      code,
      /^\\?defined\('_JEXEC'\) or die;$/m,
      `${entry} must exit unless Joomla runs.`,
    );
  }
  for (const required of [
    "openreceive.xml",
    "openreceive.php",
    "autoload.php",
    "vendor/autoload.php",
    "LICENSE",
    "src/Runtime.php",
    "media/openreceive-checkout.js",
    "media/openreceive-checkout.css",
    "media/MANIFEST.json",
    "language/en-GB/plg_hikashoppayment_openreceive.sys.ini",
  ]) {
    assert(paymentEntries.includes(required), `The payment plugin ZIP must hold ${required}.`);
  }
  assert.deepEqual(
    list(path.join(pkg, "packages/plg_console_openreceive.zip")).sort(),
    [
      "LICENSE",
      "language/en-GB/plg_console_openreceive.sys.ini",
      "openreceive.php",
      "openreceive.xml",
    ],
    "The console plugin ZIP holds its manifest, entry file, language file and license.",
  );
  assert.match(
    readFileSync(path.join(source, "LICENSE"), "utf8"),
    /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/,
    "The Joomla Extensions Directory lists GPL extensions only.",
  );
  console.log(`Built ${archive}`);
} else {
  console.error(`Unknown command ${command}. Use plan or build.`);
  process.exit(2);
}
