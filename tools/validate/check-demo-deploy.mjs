#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();

const demos = [
  {
    slug: "express-demo",
    hostname: "express-demo.openreceive.org",
    stagingHostname: "express-demo.staging.openreceive.org",
    stack: "Express + React",
    image: "ghcr.io/openreceive/demo-express",
    compose: "demos/deploy/stacks/express-demo.compose.yml",
    caddy: "demos/deploy/proxy/sites/express-demo.caddy",
    port: "3000"
  },
  {
    slug: "static-demo",
    hostname: "static-demo.openreceive.org",
    stagingHostname: "static-demo.staging.openreceive.org",
    stack: "Static HTML + Small API",
    image: "ghcr.io/openreceive/demo-static",
    compose: "demos/deploy/stacks/static-demo.compose.yml",
    caddy: "demos/deploy/proxy/sites/static-demo.caddy",
    port: "3001"
  },
  {
    slug: "nextjs-demo",
    hostname: "nextjs-demo.openreceive.org",
    stagingHostname: "nextjs-demo.staging.openreceive.org",
    stack: "Next.js Fullstack",
    image: "ghcr.io/openreceive/demo-nextjs",
    compose: "demos/deploy/stacks/nextjs-demo.compose.yml",
    caddy: "demos/deploy/proxy/sites/nextjs-demo.caddy",
    port: "3002"
  }
];

const requiredFiles = [
  "demos/deploy/README.md",
  "demos/deploy/inventory/hosts.yml",
  "demos/deploy/inventory/production.env.example",
  "demos/deploy/inventory/staging.env.example",
  "demos/deploy/manifests/production.json",
  "demos/deploy/manifests/staging.json",
  "demos/deploy/proxy/Caddyfile",
  "demos/deploy/proxy/compose.yml",
  "demos/deploy/scripts/deploy-all",
  "demos/deploy/scripts/deploy-demo",
  "demos/deploy/scripts/promote-demo",
  "demos/deploy/scripts/rollback-demo",
  "demos/deploy/scripts/smoke-demo",
  ...demos.flatMap((demo) => [demo.compose, demo.caddy])
];

const findings = [];

function fail(message) {
  findings.push(message);
}

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath}: missing file`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function readJson(relativePath) {
  const text = read(relativePath);
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return {};
  }
}

function readYaml(relativePath) {
  const text = read(relativePath);
  if (text === "") return {};
  try {
    return parseYaml(text) ?? {};
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return {};
  }
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function expectArrayEqual(actual, expected, message) {
  expect(
    Array.isArray(actual) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    message
  );
}

function forbidSecrets(relativePath, text) {
  expect(!/OPENRECEIVE_NWC\s*=/.test(text), `${relativePath}: must not assign OPENRECEIVE_NWC`);
  expect(!/nostr\+walletconnect:\/\//.test(text), `${relativePath}: must not contain NWC URI`);
  expect(!/[?&]secret=[^"'\s`]+/.test(text), `${relativePath}: must not contain secret query values`);
  expect(!/CLOUDFLARE_API_TOKEN\s*=\s*\S+/.test(text), `${relativePath}: must not contain Cloudflare token values`);
  expect(!/GHCR_(?:READ_)?TOKEN\s*=\s*\S+/.test(text), `${relativePath}: must not contain GHCR token values`);
  expect(!/OPENRECEIVE_DEPLOY_HOST\s*=\s*\S+/.test(text), `${relativePath}: must not contain private deploy host values`);
  expect(!/PRIVATE KEY-----/.test(text), `${relativePath}: must not contain private keys`);
}

function readEnvExample(relativePath) {
  const text = read(relativePath);
  const env = Object.create(null);

  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      fail(`${relativePath}: invalid env line ${line}`);
      continue;
    }
    env[line.slice(0, equalsIndex)] = line.slice(equalsIndex + 1);
  }

  return { env, text };
}

function validateRequiredFiles() {
  for (const relativePath of requiredFiles) {
    const absolute = path.join(root, relativePath);
    expect(existsSync(absolute), `${relativePath}: missing file`);
    if (existsSync(absolute)) {
      forbidSecrets(relativePath, readFileSync(absolute, "utf8"));
    }
  }
}

function validateGitignore() {
  const relativePath = ".gitignore";
  const text = read(relativePath);
  const entries = text.split(/\r?\n/);

  for (const entry of [
    "demos/deploy/secrets/",
    "demos/deploy/certs/",
    "demos/deploy/wireguard/",
    "demos/deploy/.ssh/",
    "demos/deploy/**/*.env",
    "!demos/deploy/**/*.env.example",
    "demos/deploy/**/*.secret",
    "demos/deploy/**/*.key",
    "demos/deploy/**/*.pem",
    "demos/deploy/**/id_*",
    "demos/deploy/**/wg*.conf",
    "private_private_infra_details.txt"
  ]) {
    expect(entries.includes(entry), `${relativePath}: must ignore ${entry}`);
  }
}

function validateInventory() {
  const relativePath = "demos/deploy/inventory/hosts.yml";
  const inventory = readYaml(relativePath);

  expect(inventory.schema_version === "0.1.0", `${relativePath}: schema_version must be 0.1.0`);
  expect(inventory.proxy_network === "openreceive_demo_proxy", `${relativePath}: proxy_network must be openreceive_demo_proxy`);
  expect(
    inventory.operator_private_inventory === "private_private_infra_details.txt",
    `${relativePath}: private inventory must stay outside demos/deploy`
  );
  expect(Array.isArray(inventory.demos), `${relativePath}: demos must be an array`);
  expect(inventory.demos?.length === demos.length, `${relativePath}: must define ${demos.length} demos`);

  for (const demo of demos) {
    const entry = inventory.demos?.find((item) => item.slug === demo.slug);
    expect(Boolean(entry), `${relativePath}: missing ${demo.slug}`);
    expect(entry?.hostname === demo.hostname, `${relativePath}: ${demo.slug} hostname must be ${demo.hostname}`);
    expect(entry?.stack === demo.stack, `${relativePath}: ${demo.slug} stack must be ${demo.stack}`);
    expect(entry?.image === demo.image, `${relativePath}: ${demo.slug} image must be ${demo.image}`);
    expect(entry?.compose === demo.compose, `${relativePath}: ${demo.slug} compose path must be ${demo.compose}`);
    expect(entry?.smoke_url === `https://${demo.hostname}/demo-metadata.json`, `${relativePath}: ${demo.slug} smoke_url must target demo metadata`);
  }
}

function validateEnvExample(environment) {
  const relativePath = `demos/deploy/inventory/${environment}.env.example`;
  const { env, text } = readEnvExample(relativePath);

  forbidSecrets(relativePath, text);
  expect(env.OPENRECEIVE_ENVIRONMENT === environment, `${relativePath}: OPENRECEIVE_ENVIRONMENT must be ${environment}`);
  expect(env.OPENRECEIVE_DEMO_MODE === "test_nwc", `${relativePath}: demo mode must default to test_nwc`);
  expect(env.OPENRECEIVE_IMAGE_TAG === "replace-with-git-sha", `${relativePath}: image tag must be a placeholder`);
  expect(env.OPENRECEIVE_GIT_SHA === "replace-with-git-sha", `${relativePath}: git sha must be a placeholder`);
  expect(env.OPENRECEIVE_IMAGE_DIGEST === "sha256:replace-with-image-digest", `${relativePath}: image digest must be a placeholder`);
  expect(env.OPENRECEIVE_DEPLOYED_AT === "1970-01-01T00:00:00Z", `${relativePath}: deployed_at must be a timestamp placeholder`);
  expect(Object.keys(env).length === 6, `${relativePath}: must contain only public metadata variables`);
}

function validateManifest(environment) {
  const relativePath = `demos/deploy/manifests/${environment}.json`;
  const manifest = readJson(relativePath);

  expect(manifest.schema_version === "0.1.0", `${relativePath}: schema_version must be 0.1.0`);
  expect(manifest.environment === environment, `${relativePath}: environment must be ${environment}`);
  expect(Array.isArray(manifest.deployments), `${relativePath}: deployments must be an array`);
  expect(manifest.deployments?.length === demos.length, `${relativePath}: must contain ${demos.length} deployments`);

  for (const demo of demos) {
    const entry = manifest.deployments?.find((item) => item.slug === demo.slug);
    const hostname = environment === "production" ? demo.hostname : demo.stagingHostname;
    expect(Boolean(entry), `${relativePath}: missing ${demo.slug}`);
    expect(entry?.public_url === `https://${hostname}`, `${relativePath}: ${demo.slug} public_url must be https://${hostname}`);
    expect(entry?.image === demo.image, `${relativePath}: ${demo.slug} image must be ${demo.image}`);
    for (const field of ["git_sha", "image_digest", "deployed_at", "previous_image_digest"]) {
      expect(entry?.[field] === null, `${relativePath}: ${demo.slug} ${field} must default to null`);
    }
  }
}

function validateProxyCompose() {
  const relativePath = "demos/deploy/proxy/compose.yml";
  const compose = readYaml(relativePath);
  const services = compose.services ?? {};
  const serviceNames = Object.keys(services);
  const service = services.caddy ?? {};

  expect(compose.networks?.demo_proxy?.external === true, `${relativePath}: proxy network must be external`);
  expect(compose.networks?.demo_proxy?.name === "openreceive_demo_proxy", `${relativePath}: proxy network name must be openreceive_demo_proxy`);
  expect(serviceNames.length === 1 && serviceNames[0] === "caddy", `${relativePath}: must define only the caddy service`);
  expect(service.image === "ghcr.io/openreceive/caddy-cloudflare-dns:latest", `${relativePath}: caddy image must be pinned to project image`);
  expectArrayEqual(service.ports ?? [], ["80:80", "443:443"], `${relativePath}: caddy must publish only 80 and 443`);
  expect(service.env_file?.length === 1, `${relativePath}: caddy must load exactly one env_file`);
  expect(service.env_file?.[0]?.path === "/opt/openreceive/secrets/cloudflare-dns.env", `${relativePath}: caddy env_file must use the host Cloudflare secret path`);
  expect(service.env_file?.[0]?.required === false, `${relativePath}: caddy env_file must be optional for local config validation`);
  expectArrayEqual(service.networks ?? [], ["demo_proxy"], `${relativePath}: caddy must join only demo_proxy`);
  expect((service.volumes ?? []).includes("./Caddyfile:/etc/caddy/Caddyfile:ro"), `${relativePath}: caddy must mount Caddyfile read-only`);
  expect((service.volumes ?? []).includes("./sites:/etc/caddy/sites:ro"), `${relativePath}: caddy must mount site configs read-only`);
  expect(service.restart === "unless-stopped", `${relativePath}: caddy restart policy must be unless-stopped`);
  expect(service.network_mode === undefined, `${relativePath}: must not use host networking`);
  expect(JSON.stringify(service.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: must not mount Docker socket`);
}

function validateCaddyFiles() {
  const mainPath = "demos/deploy/proxy/Caddyfile";
  const mainText = read(mainPath);

  expect(mainText.includes("import /etc/caddy/sites/*.caddy"), `${mainPath}: must import site snippets`);

  for (const demo of demos) {
    const text = read(demo.caddy);
    expect(text.includes(`${demo.hostname} {`), `${demo.caddy}: must serve ${demo.hostname}`);
    expect(text.includes("encode zstd gzip"), `${demo.caddy}: must enable compression`);
    expect(text.includes('header /openreceive/* Cache-Control "no-store"'), `${demo.caddy}: must keep checkout responses uncached`);
    expect(text.includes(`reverse_proxy ${demo.slug}:${demo.port}`), `${demo.caddy}: must reverse proxy to ${demo.slug}:${demo.port}`);
  }
}

function validateDemoStack(demo) {
  const relativePath = demo.compose;
  const compose = readYaml(relativePath);
  const services = compose.services ?? {};
  const serviceNames = Object.keys(services);
  const service = services[demo.slug] ?? {};

  expect(compose.networks?.demo_proxy?.external === true, `${relativePath}: proxy network must be external`);
  expect(compose.networks?.demo_proxy?.name === "openreceive_demo_proxy", `${relativePath}: proxy network name must be openreceive_demo_proxy`);
  expect(serviceNames.length === 1, `${relativePath}: must define only the web service`);
  expect(serviceNames.includes(demo.slug), `${relativePath}: must define ${demo.slug}`);
  expect(
    service.image === `${demo.image}:\${OPENRECEIVE_IMAGE_TAG:?set OPENRECEIVE_IMAGE_TAG}`,
    `${relativePath}: image must use required OPENRECEIVE_IMAGE_TAG`
  );
  expectArrayEqual(service.expose ?? [], [demo.port], `${relativePath}: must expose only ${demo.port}`);
  expect((service.ports ?? []).length === 0, `${relativePath}: production stack must not publish host ports`);
  expectArrayEqual(service.networks ?? [], ["demo_proxy"], `${relativePath}: ${demo.slug} must join only demo_proxy`);
  expect(service.env_file?.length === 1, `${relativePath}: ${demo.slug} must load exactly one env_file`);
  expect(service.env_file?.[0]?.path === "/opt/openreceive/secrets/rizful-test-wallet.env", `${relativePath}: ${demo.slug} env_file must use the host receive-only NWC code path`);
  expect(service.env_file?.[0]?.required === false, `${relativePath}: ${demo.slug} env_file must be optional for local config validation`);
  expect(service.environment?.OPENRECEIVE_DEMO_MODE === "${OPENRECEIVE_DEMO_MODE:-test_nwc}", `${relativePath}: demo mode must default to test_nwc`);
  expect(service.environment?.OPENRECEIVE_PUBLIC_URL === `https://${demo.hostname}`, `${relativePath}: public URL must be https://${demo.hostname}`);
  expect(service.environment?.OPENRECEIVE_GIT_SHA === "${OPENRECEIVE_GIT_SHA:-}", `${relativePath}: git sha metadata env must pass through`);
  expect(service.environment?.OPENRECEIVE_IMAGE_DIGEST === "${OPENRECEIVE_IMAGE_DIGEST:-}", `${relativePath}: image digest metadata env must pass through`);
  expect(service.environment?.OPENRECEIVE_DEPLOYED_AT === "${OPENRECEIVE_DEPLOYED_AT:-}", `${relativePath}: deployed_at metadata env must pass through`);
  expect(service.environment?.PORT === demo.port, `${relativePath}: PORT must be ${demo.port}`);
  expect(service.restart === "unless-stopped", `${relativePath}: restart policy must be unless-stopped`);
  expect(service.network_mode === undefined, `${relativePath}: must not use host networking`);
  expect(JSON.stringify(service.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: must not mount Docker socket`);
}

function validateScript(relativePath, requiredSnippets) {
  const absolute = path.join(root, relativePath);
  const text = read(relativePath);
  const stat = existsSync(absolute) ? statSync(absolute) : undefined;

  expect(text.startsWith("#!/usr/bin/env bash\n"), `${relativePath}: must use bash shebang`);
  expect(text.includes("set -euo pipefail"), `${relativePath}: must use strict shell flags`);
  expect(Boolean(stat && (stat.mode & 0o111)), `${relativePath}: must be executable`);
  for (const snippet of requiredSnippets) {
    expect(text.includes(snippet), `${relativePath}: missing ${snippet}`);
  }
}

function validateScripts() {
  validateScript("demos/deploy/scripts/deploy-demo", [
    "express-demo|static-demo|nextjs-demo",
    "OPENRECEIVE_DEPLOY_HOST:?",
    "OPENRECEIVE_IMAGE_TAG:?",
    "Run the private operator wrapper"
  ]);
  validateScript("demos/deploy/scripts/deploy-all", [
    "deploy-demo\" express-demo",
    "deploy-demo\" static-demo",
    "deploy-demo\" nextjs-demo"
  ]);
  validateScript("demos/deploy/scripts/promote-demo", [
    "express-demo|static-demo|nextjs-demo",
    "sha256:*",
    "Record this digest in demos/deploy/manifests/"
  ]);
  validateScript("demos/deploy/scripts/rollback-demo", [
    "express-demo|static-demo|nextjs-demo",
    "previous_image_digest"
  ]);
  validateScript("demos/deploy/scripts/smoke-demo", [
    "curl -fsS \"$base_url/demo-metadata.json\"",
    "Demo URL must start with http:// or https://"
  ]);
}

function validateReadme() {
  const relativePath = "demos/deploy/README.md";
  const text = read(relativePath);

  expect(text.includes("public, non-secret deployment templates"), `${relativePath}: must describe public non-secret scope`);
  expect(text.includes("docker network create openreceive_demo_proxy"), `${relativePath}: must document proxy network creation`);
  expect(text.includes("/opt/openreceive/secrets/rizful-test-wallet.env"), `${relativePath}: must document receive-only NWC code path`);
  expect(text.includes("npm run check:demo-deploy"), `${relativePath}: must document deploy validator`);
  expect(text.includes("scripts/smoke-demo https://express-demo.openreceive.org"), `${relativePath}: must document smoke command`);
}

validateRequiredFiles();
validateGitignore();
validateInventory();
validateEnvExample("production");
validateEnvExample("staging");
validateManifest("production");
validateManifest("staging");
validateProxyCompose();
validateCaddyFiles();
for (const demo of demos) validateDemoStack(demo);
validateScripts();
validateReadme();

if (findings.length > 0) {
  console.error("Demo deployment validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Demo deployment validation passed for ${demos.length} demo(s).`);
