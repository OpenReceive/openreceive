import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publisher = fileURLToPath(new URL("../tools/release/composer-release.mjs", import.meta.url));

test("Composer retries reproduce both version tags across runner identities and dates", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "composer-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  mkdirSync(root);
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "First runner",
    GIT_AUTHOR_EMAIL: "first@example.test",
    GIT_COMMITTER_NAME: "First runner",
    GIT_COMMITTER_EMAIL: "first@example.test",
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--initial-branch=main");
  mkdirSync(path.join(root, "packages/php/openreceive/src"), { recursive: true });
  mkdirSync(path.join(root, "packages/php/laravel"), { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), ".release/\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(
    path.join(root, "packages/php/openreceive/src/Version.php"),
    "<?php namespace OpenReceive; final class Version { public const VERSION = '1.2.3'; }\n",
  );
  writeFileSync(
    path.join(root, "packages/php/openreceive/composer.json"),
    JSON.stringify({ name: "openreceive/openreceive" }),
  );
  writeFileSync(
    path.join(root, "packages/php/laravel/composer.json"),
    JSON.stringify({
      name: "openreceive/laravel",
      require: { "openreceive/openreceive": "~1.2.3" },
      repositories: [{ type: "path", url: "../openreceive" }],
    }),
  );
  git("add", ".");
  git("commit", "-m", "Fixture packages");
  const remotes = ["openreceive", "laravel"].map((name) => {
    const remote = path.join(directory, `${name}.git`);
    git("init", "--bare", remote);
    return remote;
  });
  const publish = () =>
    execFileSync(
      process.execPath,
      [
        publisher,
        "publish",
        "--root",
        root,
        "--skip-packagist",
        "--remote-openreceive",
        remotes[0],
        "--remote-laravel",
        remotes[1],
      ],
      { cwd: root, env, encoding: "utf8", stdio: "pipe" },
    );
  const build = () =>
    execFileSync(process.execPath, [publisher, "build", "--root", root], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  build();
  const originalRecord = readFileSync(
    path.join(root, ".release/composer/1.2.3/openreceive.json"),
    "utf8",
  );
  const originalMtime = statSync(path.join(root, ".release/composer/1.2.3/openreceive.json"), {
    bigint: true,
  }).mtimeNs;
  publish();
  assert.equal(
    statSync(path.join(root, ".release/composer/1.2.3/openreceive.json"), { bigint: true }).mtimeNs,
    originalMtime,
  );
  assert.equal(
    readFileSync(path.join(root, ".release/composer/1.2.3/openreceive.json"), "utf8"),
    originalRecord,
  );
  const firstTags = remotes.map((remote) => git("--git-dir", remote, "rev-parse", "v1.2.3"));
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Second runner";
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "second@example.test";
  env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = "2026-09-07T12:00:00Z";
  // Force a fresh split to retain the reproducibility regression across identities.
  rmSync(path.join(root, ".release/composer"), { recursive: true });
  publish();
  const secondTags = remotes.map((remote) => git("--git-dir", remote, "rev-parse", "v1.2.3"));
  assert.deepEqual(secondTags, firstTags);
  for (const [index, name] of ["openreceive", "laravel"].entries()) {
    const record = JSON.parse(
      readFileSync(path.join(root, `.release/composer/1.2.3/${name}.json`), "utf8"),
    );
    assert.equal(record.commit, firstTags[index]);
    assert.equal(git("--git-dir", remotes[index], "rev-parse", "main"), firstTags[index]);
  }
  const laravel = JSON.parse(git("--git-dir", remotes[1], "show", "v1.2.3:composer.json"));
  assert.equal(laravel.repositories, undefined);
  assert.equal(laravel.require["openreceive/openreceive"], "~1.2.3");
  // A stale source commit and an altered cached split are both rebuilt.
  const recordPath = path.join(root, ".release/composer/1.2.3/openreceive.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  writeFileSync(recordPath, JSON.stringify({ ...record, commit: "0".repeat(40) }));
  build();
  assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).commit, record.commit);
  writeFileSync(path.join(root, "packages/php/openreceive/src/new.php"), "<?php // new code\n");
  git("add", ".");
  git("commit", "-m", "New package source");
  build();
  const updated = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(updated.source_commit, git("rev-parse", "HEAD"));
  assert.notEqual(updated.commit, record.commit);
});
