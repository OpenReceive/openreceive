import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../tools/release/wordpress-plugin.mjs", import.meta.url));
const hasSvn =
  spawnSync("sh", ["-c", "command -v svn svnadmin zip unzip"], { stdio: "ignore" }).status === 0;

// A local file:// repository laid out like a new WordPress.org plugin.
function directory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wporg publish "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("svnadmin", ["create", path.join(dir, "repo")]);
  const url = `file://${path.join(dir, "repo")}`;
  execFileSync("svn", [
    "mkdir",
    "-q",
    "-m",
    "init",
    `${url}/trunk`,
    `${url}/tags`,
    `${url}/assets`,
  ]);
  const assets = path.join(dir, "assets");
  mkdirSync(assets);
  writeFileSync(path.join(assets, "icon-128x128.png"), "png");
  return { dir, url, assets };
}

function pluginZip(dir, version, files = {}, stable = version) {
  const staging = mkdtempSync(path.join(dir, "zip-"));
  const plugin = path.join(staging, "openreceive");
  mkdirSync(plugin);
  writeFileSync(
    path.join(plugin, "openreceive.php"),
    `<?php\n/**\n * Plugin Name: OpenReceive\n * Version: ${version}\n */\n`,
  );
  writeFileSync(path.join(plugin, "readme.txt"), `=== OpenReceive ===\nStable tag: ${stable}\n`);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(plugin, name)), { recursive: true });
    writeFileSync(path.join(plugin, name), body);
  }
  const zip = path.join(dir, `openreceive-wordpress-${version}-${path.basename(staging)}.zip`);
  execFileSync("zip", ["-qr", zip, "openreceive"], { cwd: staging });
  return zip;
}

function publish({ url, assets }, zip, extra = [], env = {}) {
  return spawnSync(
    process.execPath,
    [
      tool,
      "publish",
      "--zip",
      zip,
      "--repository",
      url,
      "--assets",
      assets,
      "--skip-verify",
      ...extra,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        WPORG_SVN_USERNAME: "openreceive",
        WPORG_SVN_PASSWORD: "fixture",
        ...env,
      },
    },
  );
}

const svn = (...args) => execFileSync("svn", args, { encoding: "utf8" });
const revision = (url) => svn("info", "--show-item", "revision", url).trim();

test("publish commits trunk, the version tag and the assets in one revision", {
  skip: !hasSvn,
}, (t) => {
  const repo = directory(t);
  const first = publish(
    repo,
    pluginZip(repo.dir, "1.2.3", { "old.php": "old", "src/Gone.php": "gone" }),
  );
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Committed revision 2\./);
  assert.match(svn("cat", `${repo.url}/trunk/openreceive.php`), /Version: 1\.2\.3/);
  assert.equal(svn("ls", `${repo.url}/tags`), "1.2.3/\n");
  assert.equal(
    svn("propget", "svn:mime-type", `${repo.url}/assets/icon-128x128.png`).trim(),
    "image/png",
  );

  // The next release replaces trunk: files it dropped leave trunk, not the old tag.
  const second = publish(repo, pluginZip(repo.dir, "1.2.4", { "src/Kept.php": "kept" }));
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(svn("ls", "-R", `${repo.url}/trunk`).split("\n").filter(Boolean).sort(), [
    "openreceive.php",
    "readme.txt",
    "src/",
    "src/Kept.php",
  ]);
  assert.match(svn("ls", "-R", `${repo.url}/tags/1.2.3`), /old\.php/);
  assert.match(svn("cat", `${repo.url}/tags/1.2.4/readme.txt`), /Stable tag: 1\.2\.4/);

  // Re-running a published release is a no-op.
  const again = publish(repo, pluginZip(repo.dir, "1.2.4"));
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already on WordPress\.org/);
  assert.equal(revision(repo.url), "3");
});

test("publish refuses mismatched, older, prerelease or unauthenticated releases", {
  skip: !hasSvn,
}, (t) => {
  const repo = directory(t);
  assert.equal(publish(repo, pluginZip(repo.dir, "2.0.0")).status, 0);
  const mismatch = publish(repo, pluginZip(repo.dir, "2.0.1", {}, "2.0.0"));
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Stable tag \(2\.0\.0\) must match/);
  const older = publish(repo, pluginZip(repo.dir, "1.9.9"));
  assert.notEqual(older.status, 0);
  assert.match(older.stderr, /refusing to move it back to 1\.9\.9/);
  const prerelease = publish(repo, pluginZip(repo.dir, "2.1.0-alpha.1"));
  assert.notEqual(prerelease.status, 0);
  assert.match(prerelease.stderr, /stable releases only/);
  const unauthenticated = publish(repo, pluginZip(repo.dir, "2.0.1"), [], {
    WPORG_SVN_PASSWORD: "",
  });
  assert.notEqual(unauthenticated.status, 0);
  assert.match(unauthenticated.stderr, /Set WPORG_SVN_USERNAME and WPORG_SVN_PASSWORD/);
  const dryRun = publish(repo, pluginZip(repo.dir, "2.0.1"), ["--dry-run"], {
    WPORG_SVN_PASSWORD: "",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing committed/);
  assert.equal(revision(repo.url), "2");
});
