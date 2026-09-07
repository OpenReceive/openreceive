#!/usr/bin/env node
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
const source = path.join(root, "packages/php/wordpress");
const staging = path.join(root, "dist/wordpress-build");
const plugin = path.join(staging, "openreceive");
const archive = path.join(root, `dist/openreceive-wordpress-${version}.zip`);
const command = process.argv[2] ?? "plan";
if (command === "plan") {
  console.log(
    `Build WordPress plugin ${version}: ${archive}\nNo publication. Upload the verified archive to WordPress.org for review separately.`,
  );
} else if (command === "build") {
  const run = (bin, args, cwd = plugin) => execFileSync(bin, args, { cwd, stdio: "inherit" });
  assert(
    existsSync(path.join(source, "vendor/bin/strauss")),
    "Run composer install in packages/php/wordpress first.",
  );
  assert(
    existsSync(path.join(root, "packages/js/elements/dist/standalone/MANIFEST.json")),
    "Run npm run build:packages first.",
  );
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(plugin, { recursive: true });
  for (const name of [
    "src",
    "assets",
    "openreceive.php",
    "autoload.php",
    "uninstall.php",
    "readme.txt",
    "README.md",
    "LICENSE",
    "composer.json",
    "composer.lock",
  ]) {
    cpSync(path.join(source, name), path.join(plugin, name), { recursive: true });
  }
  cpSync(path.join(root, "packages/js/elements/dist/standalone"), path.join(plugin, "assets"), {
    recursive: true,
  });
  // The path dependency sits next to the staged plugin; it is never in the zip.
  cpSync(path.join(root, "packages/php/openreceive"), path.join(staging, "engine"), {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes("vendor"),
  });
  const manifest = JSON.parse(readFileSync(path.join(plugin, "composer.json"), "utf8"));
  manifest.repositories[0].url = "../engine";
  writeFileSync(path.join(plugin, "composer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(path.join(plugin, "composer.lock"), "utf8"));
  for (const pkg of lock.packages) {
    if (pkg.name === "openreceive/openreceive") pkg.dist.url = "../engine";
    assert(
      pkg.license?.some((license) =>
        /^(MIT|BSD-[23]-Clause|ISC|Unlicense|Apache-2\.0|GPL-2\.0-or-later|LGPL-2\.1-or-later)$/.test(
          license,
        ),
      ),
      `Review bundled license: ${pkg.name}`,
    );
  }
  writeFileSync(path.join(plugin, "composer.lock"), `${JSON.stringify(lock, null, 2)}\n`);
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
  // dependencies. That can prefix an already prefixed dependency a second time,
  // while its Composer PSR-4 mapping receives only one prefix.
  function normalizePrefixes(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) normalizePrefixes(file);
      else if (entry.name.endsWith(".php")) {
        let code = readFileSync(file, "utf8");
        for (const prefix of ["OpenReceive\\WP\\Vendor\\", "OpenReceive\\\\WP\\\\Vendor\\\\"]) {
          while (code.includes(prefix + prefix)) code = code.replaceAll(prefix + prefix, prefix);
        }
        writeFileSync(file, code);
      }
    }
  }
  normalizePrefixes(plugin);
  // Strauss's authoritative map omits classes it saw under the doubled
  // namespace. Its complete PSR-4 map resolves the normalized classes correctly.
  const autoloadReal = path.join(plugin, "vendor-prefixed/composer/autoload_real.php");
  writeFileSync(
    autoloadReal,
    readFileSync(autoloadReal, "utf8").replace(
      "$loader->setClassMapAuthoritative(true);",
      "$loader->setClassMapAuthoritative(false);",
    ),
  );
  // The plugin's namespace is a child of the engine's OpenReceive namespace.
  // Keep its public WordPress entrypoints while isolating all dependency uses.
  for (const name of readdirSync(path.join(plugin, "src"))) {
    const file = path.join(plugin, "src", name);
    const code = readFileSync(file, "utf8").replace(
      "namespace OpenReceive\\WP\\Vendor\\OpenReceive\\WP;",
      "namespace OpenReceive\\WP;",
    );
    writeFileSync(file, code);
  }
  const assets = JSON.parse(readFileSync(path.join(plugin, "assets/MANIFEST.json"), "utf8"));
  assert.equal(assets.version, version, "Standalone assets must match the release.");
  rmSync(path.join(plugin, "vendor"), { recursive: true });
  rmSync(path.join(plugin, "composer.lock"));
  rmSync(path.join(plugin, "composer.json"));
  mkdirSync(path.join(plugin, "languages"), { recursive: true });
  const wpCli = process.env.OPENRECEIVE_WP_CLI;
  run(wpCli ? "php" : "wp", [
    ...(wpCli ? [wpCli] : []),
    "--allow-root",
    "i18n",
    "make-pot",
    plugin,
    path.join(plugin, "languages/openreceive.pot"),
    "--exclude=vendor-prefixed,assets",
    "--domain=openreceive",
  ]);
  // A release must not depend on ambient Composer classes from another plugin.
  run("php", [
    "-r",
    "define('ABSPATH', __DIR__); require 'autoload.php'; if (!class_exists('OpenReceive\\\\WP\\\\Vendor\\\\OpenReceive\\\\Server\\\\Service') || class_exists('OpenReceive\\\\Server\\\\Service')) exit(1);",
  ]);
  run("php", [
    "-r",
    "define('ABSPATH', __DIR__); require 'autoload.php'; $key = new OpenReceive\\WP\\Vendor\\swentel\\nostr\\Key\\Key(); if ($key->getPublicKey(str_repeat('0', 63) . '1') !== '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798') exit(1);",
  ]);
  rmSync(archive, { force: true });
  run("zip", ["-qr", archive, "openreceive"], staging);
  console.log(`Built ${archive}`);
} else {
  throw new Error("Usage: wordpress-plugin.mjs plan|build");
}
