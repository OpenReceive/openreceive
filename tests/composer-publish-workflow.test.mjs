import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(new URL("../.github/workflows/publish-composer.yml", import.meta.url), "utf8"),
);
const publishStep = workflow.jobs["publish-composer"].steps.find((step) =>
  step.run?.includes("tools/release/composer-release.mjs publish"),
);

// Run the actual workflow shell, replacing the publisher with an offline probe.
// ssh -G resolves configuration without connecting; no git command is executed.
const probe = `
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const identities = [];
for (const [flag, expectedKey] of [
  ["--remote-openreceive", "fixture engine key\\n"],
  ["--remote-laravel", "fixture laravel key\\n"],
]) {
  const remote = args[args.indexOf(flag) + 1];
  const alias = remote.match(/^git@([^:]+):/)[1];
  const result = spawnSync("/bin/sh", ["-c", process.env.GIT_SSH_COMMAND + ' -G -T "$1"', "ssh", alias], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  const entries = result.stdout.trim().split("\\n").map(line => {
    const space = line.indexOf(" ");
    return [line.slice(0, space), line.slice(space + 1)];
  });
  const config = Object.fromEntries(entries);
  const identityFiles = entries.filter(([key]) => key === "identityfile").map(([, value]) => value);
  identities.push({
    remote, config, identityFiles,
    keyMatches: readFileSync(identityFiles[0], "utf8") === expectedKey,
    mode: statSync(identityFiles[0]).mode & 0o777,
    hostKey: readFileSync(config.userknownhostsfile.replace(/^"|"$/g, ""), "utf8").trim(),
  });
}
writeFileSync(process.env.COMPOSER_TEST_REPORT, JSON.stringify({
  args, identities,
  secretsRemoved: process.env.COMPOSER_OPENRECEIVE_SSH_KEY === undefined && process.env.COMPOSER_LARAVEL_SSH_KEY === undefined,
}));
process.exit(Number(process.env.COMPOSER_TEST_EXIT));
`;

function runPublish(t, overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "composer workflow "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const runnerTemp = path.join(directory, "runner temp");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  const probePath = path.join(directory, "probe.mjs");
  const reportPath = path.join(directory, "report.json");
  writeFileSync(probePath, probe);
  writeFileSync(
    path.join(bin, "node"),
    '#!/bin/sh\nexec "$COMPOSER_TEST_NODE" "$COMPOSER_TEST_PROBE" "$@"\n',
    { mode: 0o700 },
  );
  const result = spawnSync("bash", ["-c", publishStep.run], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      COMPOSER_TEST_NODE: process.execPath,
      COMPOSER_TEST_PROBE: probePath,
      COMPOSER_TEST_REPORT: reportPath,
      COMPOSER_TEST_EXIT: "0",
      COMPOSER_OPENRECEIVE_SSH_KEY: "fixture engine key",
      COMPOSER_LARAVEL_SSH_KEY: "fixture laravel key",
      COMPOSER_BOOTSTRAP: "false",
      ...overrides,
    },
  });
  assert.deepEqual(readdirSync(runnerTemp), [], "temporary credentials must be removed on exit");
  assert.doesNotMatch(result.stdout + result.stderr, /fixture (engine|laravel) key/);
  return { result, reportPath };
}

test("Composer publishing selects one private key per remote and pins GitHub's host key", (t) => {
  const { result, reportPath } = runPublish(t);
  assert.equal(result.status, 0, result.stderr);
  const { args, identities, secretsRemoved } = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(args.slice(0, 2), ["tools/release/composer-release.mjs", "publish"]);
  assert.equal(args.includes("--skip-packagist"), false);
  assert.equal(secretsRemoved, true);
  assert.deepEqual(
    identities.map(({ remote }) => remote.split(":")[1]),
    ["OpenReceive/openreceive-php.git", "OpenReceive/openreceive-laravel.git"],
  );
  assert.notEqual(identities[0].identityFiles[0], identities[1].identityFiles[0]);
  for (const { config, identityFiles, keyMatches, mode, hostKey } of identities) {
    assert.equal(identityFiles.length, 1);
    assert.equal(keyMatches, true);
    assert.equal(mode, 0o600);
    assert.equal(config.hostname, "github.com");
    assert.equal(config.hostkeyalias, "github.com");
    assert.equal(config.user, "git");
    assert.equal(config.identitiesonly, "yes");
    assert.equal(config.identityagent, "none");
    assert.equal(config.batchmode, "yes");
    assert.equal(config.stricthostkeychecking, "true");
    assert.equal(config.hostkeyalgorithms, "ssh-ed25519");
    assert.equal(
      hostKey,
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
  }
});

test("Composer bootstrap pushes both remotes without polling unregistered packages", (t) => {
  const { result, reportPath } = runPublish(t, { COMPOSER_BOOTSTRAP: "true" });
  assert.equal(result.status, 0, result.stderr);
  const { args, identities } = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(args.includes("--skip-packagist"), true);
  assert.equal(identities.length, 2);
  assert.match(result.stdout, /Submit them/);
});

test("Composer publishing preserves failures and removes temporary credentials", (t) => {
  const { result } = runPublish(t, { COMPOSER_TEST_EXIT: "37" });
  assert.equal(result.status, 37, result.stderr);
  assert.doesNotMatch(result.stdout, /Published|Both split repositories pushed/);
});

for (const secret of ["COMPOSER_OPENRECEIVE_SSH_KEY", "COMPOSER_LARAVEL_SSH_KEY"]) {
  test(`Composer publishing stops before the publisher when ${secret} is missing`, (t) => {
    const { result, reportPath } = runPublish(t, { [secret]: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`${secret} is not set`));
    assert.throws(() => readFileSync(reportPath), { code: "ENOENT" });
  });
}
