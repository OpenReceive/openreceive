// The dependency bundle a PHP extension ZIP carries (Paymenter, FOSSBilling).
// It installs the extension's locked dependencies with the monorepo's engine
// as a staged path package, prefixes every dependency namespace with Strauss
// so none can collide with the host application's packages or another
// extension's, and packs the prefixed tree into one vendor.phar next to the
// extension's autoload.php. The host's Composer never reads inside a .phar.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";

/**
 * @param {object} options
 * @param {string} options.source The package (its composer.json, composer.lock and vendor/ with Strauss).
 * @param {string} options.staging A scratch directory; the engine is staged inside it, never in the ZIP.
 * @param {string} options.directory The staged extension directory that receives vendor.phar; it already
 *   holds the extension's own code and its autoload.php.
 * @param {string} options.prefix The Strauss namespace prefix, e.g. "OpenReceive\\Paymenter\\Vendor\\".
 * @param {string[]} options.ownCode The extension's own code directories, relative to `directory`, whose
 *   imports Strauss rewrites (the composer.json's extra.strauss.update_call_sites).
 */
export function bundleDependencies({ source, staging, directory, prefix, ownCode }) {
  const run = (bin, args) => execFileSync(bin, args, { cwd: directory, stdio: "inherit" });
  assert(
    existsSync(path.join(source, "vendor/bin/strauss")),
    `Run composer install in ${path.relative(root, source)} first.`,
  );
  const shipped = JSON.parse(readFileSync(path.join(source, "composer.json"), "utf8"));
  assert.deepEqual(
    shipped.extra.strauss.update_call_sites,
    ownCode,
    "Strauss must rewrite exactly the extension's own code.",
  );

  // The engine is a path dependency staged next to the extension, never inside
  // the zip. Copy only what Composer installs, not a checkout's test caches.
  const engine = path.join(staging, "engine");
  for (const name of ["src", "composer.json", "LICENSE", "README.md"]) {
    cpSync(path.join(root, "packages/php/openreceive", name), path.join(engine, name), {
      recursive: true,
    });
  }
  const engineUrl = path.relative(directory, engine);
  const manifest = structuredClone(shipped);
  manifest.repositories[0].url = engineUrl;
  writeFileSync(path.join(directory, "composer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(path.join(source, "composer.lock"), "utf8"));
  // Staging changes a repository URL, which participates in Composer's hash.
  lock["content-hash"] = execFileSync(
    "php",
    [
      "-r",
      "require $argv[1]; echo \\Composer\\Package\\Locker::getContentHash(file_get_contents($argv[2]));",
      path.join(source, "vendor/autoload.php"),
      path.join(directory, "composer.json"),
    ],
    { encoding: "utf8" },
  ).trim();
  for (const pkg of lock.packages) {
    if (pkg.name === "openreceive/openreceive") pkg.dist.url = engineUrl;
    assert(
      pkg.license?.some((license) =>
        /^(MIT|BSD-[23]-Clause|ISC|Unlicense|Apache-2\.0|LGPL-2\.1-or-later)$/.test(license),
      ),
      `Review bundled license: ${pkg.name}`,
    );
  }
  writeFileSync(path.join(directory, "composer.lock"), `${JSON.stringify(lock, null, 2)}\n`);
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
  const doubled = [prefix, prefix.replaceAll("\\", "\\\\")];
  const visit = (dir, edit) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, edit);
      else if (entry.name.endsWith(".php")) writeFileSync(file, edit(readFileSync(file, "utf8")));
    }
  };
  visit(directory, (code) => {
    for (const doubledPrefix of doubled) {
      while (code.includes(doubledPrefix + doubledPrefix)) {
        code = code.replaceAll(doubledPrefix + doubledPrefix, doubledPrefix);
      }
    }
    return code;
  });
  // Strauss also prefixes a quoted string equal to the engine's namespace,
  // which would turn the extension's own name 'OpenReceive' into a class path.
  const segments = prefix.split("\\").filter(Boolean);
  const quotedPrefix = new RegExp(
    `(['"])${segments.map((segment) => `${segment}\\\\{1,2}`).join("")}OpenReceive\\1`,
    "g",
  );
  for (const own of ownCode) {
    visit(path.join(directory, own), (code) => code.replace(quotedPrefix, "$1OpenReceive$1"));
  }
  // Strauss's authoritative map omits classes it saw under the doubled
  // namespace. Its complete PSR-4 map resolves the normalized classes.
  const autoloadReal = path.join(directory, "vendor-prefixed/composer/autoload_real.php");
  writeFileSync(
    autoloadReal,
    readFileSync(autoloadReal, "utf8").replace(
      "$loader->setClassMapAuthoritative(true);",
      "$loader->setClassMapAuthoritative(false);",
    ),
  );
  rmSync(path.join(directory, "vendor"), { recursive: true });
  rmSync(path.join(directory, "composer.lock"));
  // The shipped composer.json lists the bundled dependencies; without the
  // monorepo path repository they resolve from Packagist.
  delete shipped.repositories;
  writeFileSync(path.join(directory, "composer.json"), `${JSON.stringify(shipped, null, 2)}\n`);
  // Dependency archives carry test suites, examples and tool configs.
  const devFile =
    /^(\..+|tests?|examples?|benchmarks?|docs|Makefile|.+\.sh|composer\.lock|maintainers\.yaml|phpbench\.json|(phpunit|phpstan|psalm|phpdoc)\..+)$/i;
  const prefixed = path.join(directory, "vendor-prefixed");
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
  const unprefixed = new RegExp(
    `^use OpenReceive\\\\(?!${segments.slice(1).join("\\\\")}\\\\)`,
    "m",
  );
  for (const own of ownCode) {
    visit(path.join(directory, own), (code) => {
      assert(!unprefixed.test(code), "Unprefixed engine import.");
      assert(!/^use Nyholm\\/m.test(code), "Unprefixed PSR-7 import.");
      return code;
    });
  }
  // The engine's fake wallet and swap provider are for tests, never a store.
  rmSync(path.join(prefixed, "openreceive/openreceive/src/Testing"), { recursive: true });
  // One archive holds the prefixed classes. A host whose optimized autoload
  // dump scans its extensions directory (Paymenter's does on every upgrade)
  // would print a PSR-4 warning naming OpenReceive for each loose one.
  run("php", [
    "-d",
    "phar.readonly=0",
    "-r",
    "$phar = new Phar($argv[2]); $phar->buildFromDirectory($argv[1]); $phar->setStub('<?php __HALT_COMPILER();');",
    prefixed,
    path.join(directory, "vendor.phar"),
  ]);
  rmSync(prefixed, { recursive: true });
  // A release must not lean on classes another package happens to load.
  const php = prefix.replaceAll("\\", "\\\\");
  run("php", [
    "-r",
    `require 'autoload.php'; if (!class_exists('${php}OpenReceive\\\\Server\\\\Service') || class_exists('OpenReceive\\\\Server\\\\Service')) exit(1);`,
  ]);
  run("php", [
    "-r",
    `require 'autoload.php'; $key = new ${prefix}swentel\\nostr\\Key\\Key(); if ($key->getPublicKey(str_repeat('0', 63) . '1') !== '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') exit(1);`,
  ]);
  run("php", [
    "-r",
    "foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator('phar://' . getcwd() . '/vendor.phar')) as $file) { if (str_contains($file->getPathname(), '/src/Testing/')) exit(1); }",
  ]);
}

/** The checkout's standalone script and stylesheet, checked against the release version. */
export function copyCheckoutAssets(destination, version) {
  const standalone = path.join(root, "packages/js/elements/dist/standalone");
  assert(existsSync(path.join(standalone, "MANIFEST.json")), "Run npm run build:packages first.");
  for (const name of ["openreceive-checkout.js", "openreceive-checkout.css", "MANIFEST.json"]) {
    cpSync(path.join(standalone, name), path.join(destination, name));
  }
  const assets = JSON.parse(readFileSync(path.join(destination, "MANIFEST.json"), "utf8"));
  assert.equal(assets.version, version, "Standalone assets must match the release.");
}
