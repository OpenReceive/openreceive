#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { root } from "../shared/root.mjs";

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const source = path.join(root, "packages/php/wordpress");
const staging = path.join(root, "dist/wordpress-build");
const plugin = path.join(staging, "openreceive");
const archive = path.join(root, `dist/openreceive-wordpress-${version}.zip`);
const command = process.argv[2] ?? "plan";
if (command === "plan") {
  console.log(
    `Build WordPress plugin ${version}: ${archive}\nPublishing the GitHub release starts Publish WordPress.org, which commits this archive to the plugin directory after approval.`,
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
  // Copy only what Composer installs: a working checkout also holds test and
  // analysis caches that would otherwise ship inside the plugin.
  for (const name of ["src", "composer.json", "LICENSE", "README.md"]) {
    cpSync(path.join(root, "packages/php/openreceive", name), path.join(staging, "engine", name), {
      recursive: true,
    });
  }
  const manifest = JSON.parse(readFileSync(path.join(plugin, "composer.json"), "utf8"));
  manifest.repositories[0].url = "../engine";
  writeFileSync(path.join(plugin, "composer.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = JSON.parse(readFileSync(path.join(plugin, "composer.lock"), "utf8"));
  // Staging changes a repository URL, which participates in Composer's hash.
  lock["content-hash"] = execFileSync(
    "php",
    [
      "-r",
      "require $argv[1]; echo \\Composer\\Package\\Locker::getContentHash(file_get_contents($argv[2]));",
      path.join(source, "vendor/autoload.php"),
      path.join(plugin, "composer.json"),
    ],
    { encoding: "utf8" },
  ).trim();
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
  // Strauss also prefixes any quoted string equal to the engine's namespace,
  // which turned the gateway's 'OpenReceive' name in wp-admin into
  // 'OpenReceive\WP\Vendor\OpenReceive'. A class name follows every real
  // reference to the engine, so a bare one is always text.
  for (const name of readdirSync(path.join(plugin, "src"))) {
    const file = path.join(plugin, "src", name);
    const code = readFileSync(file, "utf8")
      .replace("namespace OpenReceive\\WP\\Vendor\\OpenReceive\\WP;", "namespace OpenReceive\\WP;")
      .replace(/(['"])OpenReceive\\{1,2}WP\\{1,2}Vendor\\{1,2}OpenReceive\1/g, "$1OpenReceive$1");
    writeFileSync(file, code);
  }
  const assets = JSON.parse(readFileSync(path.join(plugin, "assets/MANIFEST.json"), "utf8"));
  assert.equal(assets.version, version, "Standalone assets must match the release.");
  rmSync(path.join(plugin, "vendor"), { recursive: true });
  rmSync(path.join(plugin, "composer.lock"));
  // WordPress.org review reads composer.json to see the bundled dependencies.
  // Without the monorepo path repository it resolves from Packagist.
  const review = JSON.parse(readFileSync(path.join(source, "composer.json"), "utf8"));
  delete review.repositories;
  writeFileSync(path.join(plugin, "composer.json"), `${JSON.stringify(review, null, 2)}\n`);
  // Dependency archives carry their own test suites, examples and tool configs,
  // which the plugin directory review rejects as development files.
  const devFile =
    /^(\..+|tests?|examples?|benchmarks?|docs|Makefile|.+\.sh|composer\.lock|maintainers\.yaml|phpbench\.json|(phpunit|phpstan|psalm|phpdoc)\..+)$/i;
  const prefixed = path.join(plugin, "vendor-prefixed");
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
  for (const entry of readdirSync(plugin, { recursive: true })) {
    if (path.basename(entry) === ".DS_Store") rmSync(path.join(plugin, entry));
  }
  for (const map of ["autoload_classmap.php", "autoload_static.php", "autoload_files.php"]) {
    const file = path.join(prefixed, "composer", map);
    if (existsSync(file)) {
      assert(!/\/tests?\//i.test(readFileSync(file, "utf8")), `${map} loads a pruned test file.`);
    }
  }
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
  // The fake wallet stays in the staged directory, which the Docker example
  // installs for its tests, and never reaches a store through the archive.
  const testkit = [
    "openreceive/src/DemoWallet.php",
    "openreceive/vendor-prefixed/openreceive/openreceive/src/Testing/*",
  ];
  run("zip", ["-qr", archive, "openreceive", "-x", ...testkit], staging);
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).split("\n");
  assert(
    !entries.some((entry) => entry.endsWith("DemoWallet.php") || entry.includes("/src/Testing/")),
    "The release archive must not ship the testkit.",
  );
  console.log(`Built ${archive}`);
} else if (command === "publish") {
  // WordPress.org hosts the plugin in Subversion: trunk/ holds the current
  // code, tags/<version>/ each release, and assets/ the directory page's
  // banners, icons and screenshots. wordpress.org serves the tag that trunk's
  // readme names as its Stable tag and offers it to every site as an update.
  // One commit puts a verified release ZIP into trunk and its tag together.
  const { values: options } = parseArgs({
    args: process.argv.slice(3),
    options: {
      zip: { type: "string", default: archive },
      repository: { type: "string", default: "https://plugins.svn.wordpress.org/openreceive" },
      assets: { type: "string", default: path.join(source, "wordpress-org") },
      "dry-run": { type: "boolean", default: false },
      "skip-verify": { type: "boolean", default: false },
      timeout: { type: "string", default: "900" },
    },
  });
  const dryRun = options["dry-run"];
  const username = process.env.WPORG_SVN_USERNAME;
  const password = process.env.WPORG_SVN_PASSWORD;
  // Subversion reads no password variable. Keep the secret out of every
  // child's environment and argv; the one commit reads it from stdin.
  delete process.env.WPORG_SVN_PASSWORD;
  assert(
    dryRun || (username && password),
    "Set WPORG_SVN_USERNAME and WPORG_SVN_PASSWORD (the SVN password from the WordPress.org profile, not the account password).",
  );
  // wordpress.org can take many minutes to answer the last request of a large
  // commit. Subversion's default ten-minute wait gave up on the first
  // publication, which had landed.
  const svn = (args, extra = {}) =>
    execFileSync(
      "svn",
      ["--non-interactive", "--config-option", "servers:global:http-timeout=3600", ...args],
      { encoding: "utf8", ...extra },
    );
  // An authenticated write reads the password from stdin. A failed write may
  // still have landed, so `landed` asks the server before the failure counts.
  const write = (args, cwd, landed) => {
    try {
      const output = svn(
        [...args, "--username", username, "--password-from-stdin", "--no-auth-cache"],
        { cwd, input: password },
      );
      console.log(output.trim().split("\n").at(-1));
    } catch (error) {
      if (!landed()) throw error;
      const reason = String(error.stderr ?? error.message)
        .trim()
        .split("\n")
        .at(-1);
      console.log(`svn ${args[0]} failed (${reason}), but wordpress.org has the change.`);
    }
  };
  const work = mkdtempSync(path.join(tmpdir(), "openreceive-wporg-"));
  try {
    const entries = execFileSync("unzip", ["-Z1", options.zip], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert(
      entries.every((entry) => entry.startsWith("openreceive/")),
      "The ZIP must hold only the openreceive/ plugin directory.",
    );
    execFileSync("unzip", ["-q", options.zip, "-d", path.join(work, "zip")]);
    const built = path.join(work, "zip/openreceive");
    const stableTag = (readme) => readme.match(/^Stable tag:\s*(\S+)\s*$/m)?.[1];
    const release = readFileSync(path.join(built, "openreceive.php"), "utf8").match(
      /^ \* Version:\s*(\S+)\s*$/m,
    )?.[1];
    const stable = stableTag(readFileSync(path.join(built, "readme.txt"), "utf8"));
    assert(
      release !== undefined && release === stable,
      `openreceive.php Version (${release}) and readme.txt Stable tag (${stable}) must match.`,
    );
    assert(
      /^\d+\.\d+\.\d+$/.test(release),
      `WordPress.org gets stable releases only, not ${release}.`,
    );
    const tags = () =>
      svn(["list", `${options.repository}/tags`])
        .split("\n")
        .map((entry) => entry.replace(/\/$/, ""));
    const trunkStable = () => stableTag(svn(["cat", `${options.repository}/trunk/readme.txt`]));
    if (tags().includes(release)) {
      console.log(`tags/${release} is already on WordPress.org; nothing to commit.`);
    } else {
      const checkout = path.join(work, "svn");
      svn(["checkout", "--quiet", "--depth", "immediates", options.repository, checkout]);
      svn(["update", "--quiet", "--set-depth", "infinity", "trunk", "assets"], { cwd: checkout });
      const trunkReadme = path.join(checkout, "trunk/readme.txt");
      const current = existsSync(trunkReadme)
        ? stableTag(readFileSync(trunkReadme, "utf8"))
        : undefined;
      if (current !== undefined) {
        const [a, b] = [release, current].map((value) => value.split(".").map(Number));
        // Equal is a re-run whose trunk commit landed and whose tag did not.
        assert(
          (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0,
          `trunk already holds ${current}; refusing to move it back to ${release}.`,
        );
      }
      // Replace a directory's contents, so files the new release (or the
      // committed images) dropped are deleted from Subversion too.
      const mirror = (from, to) => {
        const target = path.join(checkout, to);
        for (const entry of readdirSync(target))
          rmSync(path.join(target, entry), { recursive: true });
        cpSync(from, target, { recursive: true });
        svn(["add", "--quiet", "--force", "--no-ignore", to], { cwd: checkout });
        const missing = svn(["status", to], { cwd: checkout })
          .split("\n")
          .filter((line) => line.startsWith("!"))
          .map((line) => line.slice(8))
          .sort();
        const deleted = missing.filter(
          (file, index) => !missing.slice(0, index).some((parent) => file.startsWith(`${parent}/`)),
        );
        // A trailing @ stops Subversion reading an @ in a file name as a revision.
        if (deleted.length > 0) {
          svn(["delete", "--quiet", "--force", ...deleted.map((file) => `${file}@`)], {
            cwd: checkout,
          });
        }
      };
      mirror(built, "trunk");
      mirror(options.assets, "assets");
      // Without a MIME type, wordpress.org serves the images as downloads.
      for (const name of readdirSync(path.join(checkout, "assets"))) {
        const type = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
        }[path.extname(name)];
        if (type)
          svn(["propset", "--quiet", "svn:mime-type", type, `assets/${name}@`], { cwd: checkout });
      }
      const changes = svn(["status", "--quiet"], { cwd: checkout }).split("\n").filter(Boolean);
      const count = (code) => changes.filter((line) => line[0] === code).length;
      console.log(
        `WordPress.org ${release}: ${count("A")} added, ${count("M")} modified, ${count("D")} deleted in trunk and assets, then tags/${release} copied from trunk.`,
      );
      if (dryRun) {
        console.log(`Dry run: nothing committed to ${options.repository}.`);
      } else {
        // Trunk first, then the tag as a copy on the server, which sends no
        // files. Copying in the working copy sent every file twice.
        if (changes.length > 0) {
          write(["commit", "--message", `OpenReceive ${release}`], checkout, () => {
            return trunkStable() === release;
          });
        }
        write(
          [
            "copy",
            "--message",
            `Tag OpenReceive ${release}`,
            `${options.repository}/trunk`,
            `${options.repository}/tags/${release}`,
          ],
          checkout,
          () => tags().includes(release),
        );
      }
    }
    if (!dryRun && !options["skip-verify"]) {
      // The plugin API lists a version once wordpress.org has built its ZIP.
      const deadline = Date.now() + Number(options.timeout) * 1000;
      const info =
        "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=openreceive";
      for (;;) {
        const listed = await fetch(info)
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) => body?.version)
          .catch(() => undefined);
        if (listed === release) break;
        assert(
          Date.now() < deadline,
          `wordpress.org still lists ${listed ?? "no version"} after ${options.timeout}s; the SVN commit itself succeeded.`,
        );
        console.error(`waiting for wordpress.org to list openreceive ${release}…`);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      console.log(`Published https://wordpress.org/plugins/openreceive/ ${release}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  throw new Error("Usage: wordpress-plugin.mjs plan|build|publish");
}
