import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { platformSummaryMarkdown } from "../trials/harness/report.ts";
import {
  parseInstalled,
  registryLeakCheck,
  treeVersionCheck,
} from "../trials/harness/installed.ts";
import {
  compactInfoBody,
  compactVersionsLines,
  composerGlobalConfig,
  composerPackagesJson,
  dockerfileBlock,
  harnessDockerfileLine,
  mergeVersions,
  npmPackument,
  npmTarballUrl,
  patchDockerfile,
  pep503Page,
  pickSubnet,
  registryLeaks,
  rewriteDirections,
  routeRequest,
  treeOverride,
  treeShopEnv,
  treeWordPressMuPlugin,
} from "../trials/harness/tree-registry.ts";
import { nextPatchVersion, treeInputFiles, treeKey } from "../trials/harness/tree-build.ts";

const env = { base: "http://172.17.0.1:17893", host: "172.17.0.1" };

const npmArtifact = {
  name: "@openreceive/http",
  version: "0.4.33",
  file: "npm/openreceive-http-0.4.33.tgz",
  integrity: "sha512-abc",
  shasum: "deadbeef",
  manifest: { name: "@openreceive/http", version: "0.4.33", dependencies: { pg: "^8" } },
};

const gem = {
  name: "openreceive-rails",
  version: "0.4.33",
  file: "gems/openreceive-rails-0.4.33.gem",
  sha256: "ff".repeat(32),
  dependencies: [
    ["openreceive", "= 0.4.33"],
    ["rails", ">= 8.0, < 9"],
  ],
  requiredRuby: ">= 3.2",
  requiredRubygems: ">= 0",
};

test("the tree's version is one above the workspace, and only package inputs change it", () => {
  assert.equal(nextPatchVersion("0.4.32"), "0.4.33");
  assert.deepEqual(
    treeInputFiles([
      "packages/js/http/src/index.ts",
      "trials/README.md",
      "docs/agents/node.md",
      "tests/a.mjs",
      "tools/release/gem-release.mjs",
    ]),
    ["packages/js/http/src/index.ts", "tools/release/gem-release.mjs"],
  );
  assert.notEqual(treeKey([["packages/a", "one"]]), treeKey([["packages/a", "two"]]));
});

test("the packument offers only the tree's version, with an npmjs tarball URL npm rewrites to the mirror", () => {
  const packument = npmPackument(npmArtifact);
  assert.deepEqual(packument["dist-tags"], { latest: "0.4.33" });
  assert.deepEqual(Object.keys(packument.versions), ["0.4.33"]);
  const dist = packument.versions["0.4.33"].dist;
  assert.equal(dist.tarball, "https://registry.npmjs.org/@openreceive/http/-/http-0.4.33.tgz");
  assert.equal(
    npmTarballUrl("openreceive", "0.4.33"),
    "https://registry.npmjs.org/openreceive/-/openreceive-0.4.33.tgz",
  );
  assert.equal(dist.integrity, "sha512-abc");
});

test("routes separate the tree's own artifacts from pass-through", () => {
  assert.deepEqual(routeRequest("/@openreceive%2fhttp"), {
    kind: "npm-packument",
    name: "@openreceive/http",
  });
  assert.deepEqual(routeRequest("/@openreceive/http/-/http-0.4.33.tgz"), {
    kind: "npm-tarball",
    name: "@openreceive/http",
    file: "http-0.4.33.tgz",
  });
  assert.deepEqual(routeRequest("/openreceive/-/openreceive-0.4.33.tgz"), {
    kind: "npm-tarball",
    name: "openreceive",
    file: "openreceive-0.4.33.tgz",
  });
  assert.equal(routeRequest("/-/npm/v1/security/advisories/bulk").kind, "proxy");
  assert.deepEqual(routeRequest("/_tree/pypi/simple/openreceive/"), {
    kind: "pypi-page",
    project: "openreceive",
  });
  assert.deepEqual(routeRequest("/_tree/pypi/files/openreceive-0.4.33-py3-none-any.whl"), {
    kind: "pypi-file",
    file: "openreceive-0.4.33-py3-none-any.whl",
  });
  assert.deepEqual(routeRequest("/_tree/composer/packages.json"), { kind: "composer-index" });
  assert.deepEqual(routeRequest("/_tree/composer/laravel-0.4.33.zip"), {
    kind: "composer-dist",
    file: "laravel-0.4.33.zip",
  });
  assert.deepEqual(routeRequest("/_tree/release/openreceive-odoo-0.4.33.zip"), {
    kind: "release",
    file: "openreceive-odoo-0.4.33.zip",
  });
  assert.deepEqual(routeRequest("/_tree/release/"), { kind: "release-index" });
  assert.deepEqual(routeRequest("/_tree/rubygems/versions"), { kind: "gem-versions" });
  assert.deepEqual(routeRequest("/_tree/rubygems/info/rack"), { kind: "gem-info", name: "rack" });
  assert.deepEqual(routeRequest("/_tree/rubygems/gems/openreceive-0.4.33.gem"), {
    kind: "gem-file",
    file: "openreceive-0.4.33.gem",
  });
  assert.deepEqual(routeRequest("/_tree/rubygems/api/v1/dependencies?gems=rack"), {
    kind: "proxy",
    upstream: "rubygems.org",
    path: "/api/v1/dependencies?gems=rack",
  });
});

test("the simple page, composer index and compact index describe the tree's builds", () => {
  const page = pep503Page(env.base, [
    { filename: "openreceive-0.4.33-py3-none-any.whl", file: "python/w", sha256: "ab" },
  ]);
  assert.match(page, /_tree\/pypi\/files\/openreceive-0\.4\.33-py3-none-any\.whl#sha256=ab/);
  const packages = composerPackagesJson(env.base, [
    {
      name: "openreceive/laravel",
      version: "0.4.33",
      file: "composer/laravel-0.4.33.zip",
      sha256: "cd",
      manifest: { name: "openreceive/laravel", require: {} },
    },
  ]).packages;
  assert.equal(
    packages["openreceive/laravel"]["0.4.33"].dist.url,
    `${env.base}/_tree/composer/laravel-0.4.33.zip`,
  );
  assert.equal(packages["openreceive/laravel"]["0.4.33"].version, "0.4.33");
  assert.equal(
    compactInfoBody(gem),
    `---\n0.4.33 openreceive:= 0.4.33,rails:>= 8.0&< 9|checksum:${"ff".repeat(32)},ruby:>= 3.2\n`,
  );
  const merged = mergeVersions(
    "created_at: 2026\n---\nrack 2.2.25 abc\n",
    compactVersionsLines([gem]),
  );
  assert.match(merged, /^rack 2\.2\.25 abc$/m);
  assert.match(merged, /^openreceive-rails 0\.4\.33 [0-9a-f]{32}$/m);
});

test("a Dockerfile gets the mirror after every FROM, and its tools only where it uses them", () => {
  const block = dockerfileBlock(env, { composer: true, bundler: false });
  const patched = patchDockerfile(
    "FROM php:8.4-cli\nRUN composer install\nFROM base AS two\nRUN true\n",
    block,
  );
  const lines = patched.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("ENV NPM_CONFIG_REGISTRY=")).length, 2);
  assert.ok(patched.includes("COMPOSER_HOME=/opt/openreceive-composer"));
  assert.ok(patched.includes('"secure-http":false'));
  assert.equal(lines[1], "# Package mirror for this machine.");
  assert.ok(!patched.includes("bundle config"));
  assert.ok(block.every(harnessDockerfileLine));
  // Each build must miss Docker's cache: every build has the same version.
  const tools = { composer: true, bundler: false };
  assert.notDeepEqual(dockerfileBlock(env, tools, "aaa"), dockerfileBlock(env, tools, "bbb"));
  assert.match(dockerfileBlock(env, tools, "aaa")[1], /OPENRECEIVE_TREE_BUILD=aaa/);
  const ruby = dockerfileBlock(env, { composer: false, bundler: true });
  assert.ok(
    ruby.some((line) =>
      line.startsWith("RUN bundle config set --local mirror.https://rubygems.org"),
    ),
  );
  assert.ok(ruby.every(harnessDockerfileLine));
  assert.ok(!harnessDockerfileLine("ENV FOO=1"));
  assert.equal(treeShopEnv(env).NPM_CONFIG_REGISTRY, `${env.base}/`);
  assert.deepEqual(JSON.parse(composerGlobalConfig(env.base)).config, { "secure-http": false });
});

test("served directions name the tree's version, with release assets and the odoo pin on the mirror", () => {
  const rewrite = { fromVersion: "0.4.32", toVersion: "0.4.33", base: env.base, host: env.host };
  const rewritten = rewriteDirections(
    [
      "wp plugin install openreceive --version=0.4.32 --activate",
      "curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.32/openreceive-paymenter-0.4.32.zip",
      "`standalone-checkout-<version>.tar.gz` on every [GitHub release](https://github.com/openreceive/openreceive/releases).",
      "curl -fsSLO https://github.com/OpenReceive/openreceive/releases/download/v0.4.32/standalone-checkout-0.4.32.tar.gz",
      " && pip3 install --no-cache-dir --break-system-packages openreceive==0.4.32",
      'pip install "openreceive[django]"',
      "Run `npx openreceive doctor` on 0.4.32.",
    ].join("\n"),
    rewrite,
  );
  const lines = rewritten.split("\n");
  assert.equal(
    lines[0],
    `wp plugin install ${env.base}/_tree/release/openreceive-wordpress-0.4.33.zip --activate`,
  );
  assert.equal(lines[1], `curl -fsSLO ${env.base}/_tree/release/openreceive-paymenter-0.4.33.zip`);
  assert.equal(
    lines[2],
    `\`standalone-checkout-<version>.tar.gz\` (${env.base}/_tree/release/standalone-checkout-0.4.33.tar.gz) on every [GitHub release](${env.base}/_tree/release/).`,
  );
  assert.equal(lines[3], `curl -fsSLO ${env.base}/_tree/release/standalone-checkout-0.4.33.tar.gz`);
  assert.equal(
    lines[4],
    ` && pip3 install --no-cache-dir --break-system-packages --index-url ${env.base}/_tree/pypi/simple/ --trusted-host 172.17.0.1 openreceive==0.4.33`,
  );
  assert.equal(lines[5], 'pip install "openreceive[django]"');
  assert.equal(lines[6], "Run `npx openreceive doctor` on 0.4.33.");
});

test("a WordPress shop's override mounts a must-use plugin that allows exactly the registry", () => {
  const php = treeWordPressMuPlugin("172.17.0.1");
  assert.match(php, /http_request_host_is_external/);
  assert.match(php, /http_allowed_safe_ports/);
  assert.match(php, /'172\.17\.0\.1'/);
  assert.match(php, /17893/);
  const yaml = treeOverride(
    ["wordpress", "db", "cli"],
    env,
    "10.202.4.0/24",
    "/tmp/shop.tree-mu.php",
  );
  const mounts = [...yaml.matchAll(/source: "\/tmp\/shop\.tree-mu\.php"/g)];
  assert.equal(mounts.length, 2);
  assert.match(yaml, /target: \/var\/www\/html\/wp-content\/mu-plugins\/trial-package-mirror\.php/);
  assert.match(yaml, /\n {2}db:\n {4}environment:/);
});

test("the override reaches every service and gives the shop its own subnet", () => {
  const yaml = treeOverride(["web", "functions"], env, "10.202.3.0/24");
  assert.match(yaml, /\n {2}web:\n {4}environment:\n/);
  assert.match(yaml, /\n {2}functions:\n/);
  assert.match(yaml, /NPM_CONFIG_REGISTRY: "http:\/\/172\.17\.0\.1:17893\/"/);
  assert.match(yaml, /subnet: "10\.202\.3\.0\/24"/);
  const used = new Set(["10.202.1.0/24"]);
  const handed = new Set(["10.202.2.0/24"]);
  assert.equal(pickSubnet(used, handed), "10.202.3.0/24");
});

test("installed-version parsing and the tree check", () => {
  assert.deepEqual(parseInstalled("web", "@openreceive/http 0.4.33\nnoise\nopenreceive 0.4.33\n"), [
    { service: "web", name: "@openreceive/http", version: "0.4.33" },
    { service: "web", name: "openreceive", version: "0.4.33" },
  ]);
  assert.deepEqual(parseInstalled("web", "  * openreceive-rails (0.4.33)\n  * puma (7.0)"), [
    { service: "web", name: "openreceive-rails", version: "0.4.33" },
  ]);
  assert.deepEqual(parseInstalled("web", "openreceive/laravel 0.4.33\n"), [
    { service: "web", name: "openreceive/laravel", version: "0.4.33" },
  ]);
  const found = parseInstalled("web", "openreceive/openreceive 0.4.33\n");
  assert.equal(treeVersionCheck(found, "0.4.33").pass, true);
  assert.equal(treeVersionCheck(found, "0.4.34").pass, false);
  assert.equal(treeVersionCheck([], "0.4.33").pass, false);
  assert.equal(treeVersionCheck([], "0.4.33").severity, "blocker");
  // No wallet code yet: the agent rightly stops first, but what it did install still counts.
  assert.equal(treeVersionCheck([], "0.4.33", true).pass, true);
  assert.equal(treeVersionCheck(found, "0.4.34", true).pass, false);
  assert.equal(registryLeakCheck([]).pass, true);
  const leak = registryLeakCheck(["composer.lock: 2"]);
  assert.equal(leak.pass, false);
  assert.equal(leak.severity, "polish");
  assert.match(leak.evidence, /composer\.lock/);
});

test("a shop's leak report lists its files but not the harness's own Dockerfile lines", async () => {
  const shop = mkdtempSync(path.join(tmpdir(), "tree-leak-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "master", shop]);
    const block = dockerfileBlock(env, { composer: true, bundler: true });
    writeFileSync(path.join(shop, "Dockerfile"), patchDockerfile("FROM php:8.4-cli\n", block));
    writeFileSync(path.join(shop, "composer.lock"), `{"url":"${env.base}/_tree/composer/x.zip"}`);
    writeFileSync(path.join(shop, "keep.txt"), "nothing here\n");
    const leaks = await registryLeaks(shop, "172.17.0.1:17893");
    assert.deepEqual(leaks, ["composer.lock: 1"]);
  } finally {
    rmSync(shop, { recursive: true, force: true });
  }
});

test("a tree summary has no passed.json entry and names the build", () => {
  const markdown = platformSummaryMarkdown({
    slug: "node",
    day: "2026-11-08",
    mode: "tree",
    release: "0.4.32",
    directionsUrl: "http://127.0.0.1:1/node.md",
    directions: "aaaaaaaaaaaa",
    treeBuild: { version: "0.4.33", commit: "b8a9bab2" },
    runs: [{ id: "x", ok: true, agent: "codex", model: "default", checks: [] }],
  });
  assert.match(markdown, /built from this tree \(b8a9bab2\) as 0\.4\.33/);
  assert.doesNotMatch(markdown, /^passed\.json entry:/m);
  assert.match(markdown, /- mode: tree/);
});
