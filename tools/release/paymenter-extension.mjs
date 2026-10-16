#!/usr/bin/env node
// Builds the Paymenter gateway extension: dist/openreceive-paymenter-<version>.zip
// holds one OpenReceive/ folder for Paymenter's extensions/Gateways/ directory.
// Its dependencies are prefixed with Strauss (OpenReceive\Paymenter\Vendor\…),
// so they can never collide with Paymenter's own packages or another
// extension's, and the checkout's standalone script ships inside it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";

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
  assert(
    existsSync(path.join(source, "vendor/bin/strauss")),
    "Run composer install in packages/php/paymenter first.",
  );
  const standalone = path.join(root, "packages/js/elements/dist/standalone");
  assert(existsSync(path.join(standalone, "MANIFEST.json")), "Run npm run build:packages first.");
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
    "composer.json",
    "composer.lock",
  ]) {
    cpSync(path.join(source, name), path.join(extension, name), { recursive: true });
  }
  mkdirSync(path.join(extension, "assets"));
  for (const name of ["openreceive-checkout.js", "openreceive-checkout.css", "MANIFEST.json"]) {
    cpSync(path.join(standalone, name), path.join(extension, "assets", name));
  }
  const assets = JSON.parse(readFileSync(path.join(extension, "assets/MANIFEST.json"), "utf8"));
  assert.equal(assets.version, version, "Standalone assets must match the release.");

  // The engine is a path dependency staged next to the extension, never inside
  // the zip. Copy only what Composer installs, not a checkout's test caches.
  for (const name of ["src", "composer.json", "LICENSE", "README.md"]) {
    cpSync(path.join(root, "packages/php/openreceive", name), path.join(staging, "engine", name), {
      recursive: true,
    });
  }
  const manifest = JSON.parse(readFileSync(path.join(extension, "composer.json"), "utf8"));
  manifest.repositories[0].url = "../engine";
  writeFileSync(path.join(extension, "composer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(path.join(extension, "composer.lock"), "utf8"));
  // Staging changes a repository URL, which participates in Composer's hash.
  lock["content-hash"] = execFileSync(
    "php",
    [
      "-r",
      "require $argv[1]; echo \\Composer\\Package\\Locker::getContentHash(file_get_contents($argv[2]));",
      path.join(source, "vendor/autoload.php"),
      path.join(extension, "composer.json"),
    ],
    { encoding: "utf8" },
  ).trim();
  for (const pkg of lock.packages) {
    if (pkg.name === "openreceive/openreceive") pkg.dist.url = "../engine";
    assert(
      pkg.license?.some((license) =>
        /^(MIT|BSD-[23]-Clause|ISC|Unlicense|Apache-2\.0|LGPL-2\.1-or-later)$/.test(license),
      ),
      `Review bundled license: ${pkg.name}`,
    );
  }
  writeFileSync(path.join(extension, "composer.lock"), `${JSON.stringify(lock, null, 2)}\n`);
  run("composer", [
    "install",
    "--no-dev",
    "--no-interaction",
    "--no-progress",
    "--prefer-dist",
    "--no-scripts",
  ]);
  run("php", [
    "-r",
    "require $argv[1]; (new \\BrianHenryIE\\Strauss\\Console\\Application('0.26.5'))->run(new \\Symfony\\Component\\Console\\Input\\ArrayInput([]));",
    path.join(source, "vendor/autoload.php"),
  ]);

  // Strauss processes the engine's broad OpenReceive namespace after some
  // dependencies, which can prefix an already prefixed name a second time.
  const doubled = [PREFIX, PREFIX.replaceAll("\\", "\\\\")];
  const visit = (directory, edit) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, edit);
      else if (entry.name.endsWith(".php")) writeFileSync(file, edit(readFileSync(file, "utf8")));
    }
  };
  visit(extension, (code) => {
    for (const prefix of doubled) {
      while (code.includes(prefix + prefix)) code = code.replaceAll(prefix + prefix, prefix);
    }
    return code;
  });
  // Strauss also prefixes a quoted string equal to the engine's namespace,
  // which would turn the extension's own name 'OpenReceive' into a class path.
  for (const directory of OWN_CODE) {
    visit(path.join(extension, directory), (code) =>
      code.replace(
        /(['"])OpenReceive\\{1,2}Paymenter\\{1,2}Vendor\\{1,2}OpenReceive\1/g,
        "$1OpenReceive$1",
      ),
    );
  }
  // Strauss's authoritative map omits classes it saw under the doubled
  // namespace. Its complete PSR-4 map resolves the normalized classes.
  const autoloadReal = path.join(extension, "vendor-prefixed/composer/autoload_real.php");
  writeFileSync(
    autoloadReal,
    readFileSync(autoloadReal, "utf8").replace(
      "$loader->setClassMapAuthoritative(true);",
      "$loader->setClassMapAuthoritative(false);",
    ),
  );
  rmSync(path.join(extension, "vendor"), { recursive: true });
  rmSync(path.join(extension, "composer.lock"));
  // The shipped composer.json lists the bundled dependencies; without the
  // monorepo path repository they resolve from Packagist.
  const shipped = JSON.parse(readFileSync(path.join(source, "composer.json"), "utf8"));
  delete shipped.repositories;
  writeFileSync(path.join(extension, "composer.json"), `${JSON.stringify(shipped, null, 2)}\n`);
  // Dependency archives carry test suites, examples and tool configs.
  const devFile =
    /^(\..+|tests?|examples?|benchmarks?|docs|Makefile|.+\.sh|composer\.lock|maintainers\.yaml|phpbench\.json|(phpunit|phpstan|psalm|phpdoc)\..+)$/i;
  const prefixed = path.join(extension, "vendor-prefixed");
  for (const vendor of readdirSync(prefixed, { withFileTypes: true })) {
    if (!vendor.isDirectory()) continue;
    for (const pkg of readdirSync(path.join(prefixed, vendor.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const pkgDir = path.join(prefixed, vendor.name, pkg.name);
      for (const entry of readdirSync(pkgDir)) {
        if (devFile.test(entry)) rmSync(path.join(pkgDir, entry), { recursive: true });
      }
    }
  }
  for (const map of ["autoload_classmap.php", "autoload_static.php", "autoload_files.php"]) {
    const file = path.join(prefixed, "composer", map);
    if (existsSync(file)) {
      assert(!/\/tests?\//i.test(readFileSync(file, "utf8")), `${map} loads a pruned test file.`);
    }
  }
  // The extension's own code must reach the engine only through the prefix.
  for (const directory of OWN_CODE) {
    visit(path.join(extension, directory), (code) => {
      assert(!/^use OpenReceive\\(?!Paymenter\\Vendor\\)/m.test(code), "Unprefixed engine import.");
      assert(!/^use Nyholm\\/m.test(code), "Unprefixed PSR-7 import.");
      return code;
    });
  }
  // The engine's fake wallet and swap provider are for tests, never a store.
  rmSync(path.join(prefixed, "openreceive/openreceive/src/Testing"), { recursive: true });
  // Paymenter's own Composer maps Paymenter\Extensions\ to extensions/, and
  // every optimized autoload dump (each Paymenter upgrade runs one) scans that
  // directory's .php files. Hundreds of prefixed dependency classes there
  // would each print a PSR-4 warning naming OpenReceive. One archive holds
  // them instead; Composer never reads inside a .phar.
  run("php", [
    "-d",
    "phar.readonly=0",
    "-r",
    "$phar = new Phar($argv[2]); $phar->buildFromDirectory($argv[1]); $phar->setStub('<?php __HALT_COMPILER();');",
    prefixed,
    path.join(extension, "vendor.phar"),
  ]);
  rmSync(prefixed, { recursive: true });
  // A release must not lean on classes another package happens to load.
  run("php", [
    "-r",
    "require 'autoload.php'; if (!class_exists('OpenReceive\\\\Paymenter\\\\Vendor\\\\OpenReceive\\\\Server\\\\Service') || class_exists('OpenReceive\\\\Server\\\\Service')) exit(1);",
  ]);
  run("php", [
    "-r",
    "require 'autoload.php'; $key = new OpenReceive\\Paymenter\\Vendor\\swentel\\nostr\\Key\\Key(); if ($key->getPublicKey(str_repeat('0', 63) . '1') !== '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') exit(1);",
  ]);
  run("php", [
    "-r",
    "foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator('phar://' . getcwd() . '/vendor.phar')) as $file) { if (str_contains($file->getPathname(), '/src/Testing/')) exit(1); }",
  ]);
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
