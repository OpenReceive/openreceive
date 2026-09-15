import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { artifactCacheIdentity } from "../tools/package/artifact-cache.mjs";
import { buildPackageTarballs } from "../tools/package/build-artifacts.mjs";
import { packageJobs, runPackageTasks } from "../tools/package/parallel.mjs";
import { publishTarballs } from "../tools/release/npm-release.mjs";

const pkg = (name, dependencies = {}) => ({ manifest: { name, dependencies } });

test("package tasks overlap independent work, respect dependencies and preserve result order", async () => {
  const packages = [pkg("leaf", { base: "1" }), pkg("base"), pkg("independent")];
  const done = new Set();
  let active = 0;
  let peak = 0;
  const result = await runPackageTasks(
    packages,
    async ({ manifest: { name } }) => {
      if (name === "leaf") assert(done.has("base"));
      peak = Math.max(peak, ++active);
      await delay(20);
      active--;
      done.add(name);
      return name;
    },
    2,
  );
  assert.equal(peak, 2);
  assert.deepEqual(result, ["leaf", "base", "independent"]);
});

test("failed package tasks drain active work and never launch dependent or queued tasks", async () => {
  const started = [];
  let drained = false;
  await assert.rejects(
    runPackageTasks(
      [pkg("broken"), pkg("running"), pkg("dependent", { broken: "1" }), pkg("queued")],
      async ({ manifest: { name } }) => {
        started.push(name);
        if (name === "broken") throw new Error("build failed");
        await delay(20);
        drained = true;
      },
      2,
    ),
    /build failed/,
  );
  assert(drained);
  assert.deepEqual(started, ["broken", "running"]);
  await assert.rejects(
    runPackageTasks([pkg("a", { b: "1" }), pkg("b", { a: "1" })], () => {
      assert.fail("cyclic graph must fail before starting");
    }),
    /cycle/,
  );
  for (const value of [0, -1, 1.5, "invalid"])
    assert.throws(() => packageJobs(value), /positive integer/);
});

test("packing builds once; clean-commit reuse verifies bytes and invalidates dirty or changed source", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-artifact-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages/js/core"), { recursive: true });
  const packageDir = path.join(root, "packages/js/core");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/js/*"] }),
  );
  writeFileSync(path.join(root, ".gitignore"), ".release/\n**/dist/\nbuild-count\n");
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openreceive/core",
      version: "1.0.0",
      exports: { ".": "./dist/index.js" },
      files: ["dist"],
      scripts: { build: "node build.cjs", prepack: "npm run build" },
    }),
  );
  writeFileSync(
    path.join(packageDir, "build.cjs"),
    `
    const fs = require('node:fs');
    fs.appendFileSync('../../..//build-count', 'build\\n');
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/index.js', 'module.exports = 42;');
  `,
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    }).trim();
  git("init");
  git("add", ".");
  git("commit", "-m", "Fixture");
  const build = () => buildPackageTarballs({ root, outDir: ".release/output", log: () => {} });
  const count = () =>
    readFileSync(path.join(root, "build-count"), "utf8").trim().split("\n").length;
  const first = await build();
  assert.equal(count(), 1, "explicit build must not run again through prepack");
  const bytes = readFileSync(first.tarballs[0].tarball);
  await build();
  assert.equal(count(), 1, "identical clean source must reuse the archive");
  assert.deepEqual(readFileSync(first.tarballs[0].tarball), bytes);
  const cacheRoot = path.join(root, ".release/package-artifacts");
  const cache = path.join(cacheRoot, readdirSync(cacheRoot)[0]);
  const archive = readdirSync(cache).find((file) => file.endsWith(".tgz"));
  writeFileSync(path.join(cache, archive), "corrupt archive");
  await build();
  assert.equal(count(), 2, "corrupt cached bytes must force a rebuild");
  const identity = artifactCacheIdentity(root);
  appendFileSync(path.join(packageDir, "build.cjs"), "\n// changed input\n");
  assert.equal(artifactCacheIdentity(root), undefined);
  await build();
  assert.equal(count(), 3, "dirty source must never use the clean commit cache");
  git("add", ".");
  git("commit", "-m", "Changed input");
  assert.notEqual(artifactCacheIdentity(root).commit, identity.commit);
  await build();
  assert.equal(count(), 4, "a new commit must rebuild");
});

test("publication runs independent packages concurrently after their dependencies, using tested archives", async () => {
  const packages = [
    pkg("@openreceive/browser", { "@openreceive/core": "1" }),
    pkg("@openreceive/core"),
    pkg("@openreceive/provider-data"),
  ];
  const completed = new Set();
  let active = 0;
  let peak = 0;
  await publishTarballs(
    "/fixture",
    packages.map(({ manifest }) => ({
      name: manifest.name,
      tarball: `/fixture/${manifest.name.split("/")[1]}.tgz`,
    })),
    { "dry-run": true },
    {
      packages,
      jobs: 2,
      runNpm: async (args) => {
        const name = path.basename(args[1], ".tgz");
        if (name === "browser") assert(completed.has("core"));
        assert(args.includes("--dry-run"));
        assert(args.includes("--ignore-scripts"));
        peak = Math.max(peak, ++active);
        await delay(20);
        active--;
        completed.add(name);
      },
    },
  );
  assert.equal(peak, 2);
  assert.equal(completed.size, 3);
});
