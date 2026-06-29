#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();

const demoContainers = [
  {
    id: "node-express",
    packageName: "@openreceive/example-node-express",
    dir: "examples/hello-fruit/server/node-express",
    service: "hello-fruit-node-express",
    image: "ghcr.io/openreceive/demo-express:local",
    port: "3000",
    namespace: "hello_fruit_express",
    openreceiveVolume: "openreceive-node-express-openreceive:/app/examples/hello-fruit/server/node-express/.openreceive",
    openreceiveVolumeName: "openreceive-node-express-openreceive",
    buildScript: "vite build --configLoader runner",
    startScript: "tsx ../../shared/require-openreceive-nwc.ts && tsx src/server/production.ts"
  },
  {
    id: "static-html-small-api",
    packageName: "@openreceive/example-static-html-small-api",
    dir: "examples/hello-fruit/server/static-html-small-api",
    service: "hello-fruit-static-html-small-api",
    image: "ghcr.io/openreceive/demo-static:local",
    port: "3001",
    namespace: "hello_fruit_static",
    openreceiveVolume: "openreceive-static-html-small-api-openreceive:/app/examples/hello-fruit/server/static-html-small-api/.openreceive",
    openreceiveVolumeName: "openreceive-static-html-small-api-openreceive",
    buildScript: "vite build --configLoader runner",
    startScript: "tsx ../../shared/require-openreceive-nwc.ts && tsx src/server/production.ts"
  },
  {
    id: "nextjs-fullstack",
    packageName: "@openreceive/example-nextjs-fullstack",
    dir: "examples/hello-fruit/server/nextjs-fullstack",
    service: "hello-fruit-nextjs-fullstack",
    image: "ghcr.io/openreceive/demo-nextjs:local",
    port: "3002",
    namespace: "hello_fruit_nextjs",
    openreceiveVolume: "openreceive-nextjs-fullstack-openreceive:/app/examples/hello-fruit/server/nextjs-fullstack/.openreceive",
    openreceiveVolumeName: "openreceive-nextjs-fullstack-openreceive",
    buildScript: "next build",
    startScript: "tsx ../../shared/require-openreceive-nwc.ts && next start -H 0.0.0.0 -p ${PORT:-3002}"
  }
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

function forbidSecrets(relativePath, text) {
  expect(!/OPENRECEIVE_NWC\s*=/.test(text), `${relativePath}: must not assign OPENRECEIVE_NWC`);
  expect(!/nostr\+walletconnect:\/\//.test(text), `${relativePath}: must not contain NWC URI`);
  expect(!/[?&]secret=[0-9a-fA-F]{16,}/.test(text), `${relativePath}: must not contain NWC code query value`);
}

function validateDockerfile(demo) {
  const relativePath = `${demo.dir}/Dockerfile`;
  const text = read(relativePath);
  const exposeMatches = [...text.matchAll(/^EXPOSE\s+(\d+)/gm)].map((match) => match[1]);
  const npmCiMatch = text.match(/^RUN(?:\s+--mount=[^\n]+)?\s+npm ci\b/m);
  const npmCiIndex = npmCiMatch?.index ?? -1;
  const buildIndex = text.indexOf(`RUN npm run build -w ${demo.packageName}`);
  const nodeEnvIndex = text.indexOf("ENV NODE_ENV=production");

  forbidSecrets(relativePath, text);
  expect(/^FROM node:20-bookworm-slim$/m.test(text), `${relativePath}: must use the pinned Node 20 slim base image`);
  expect(text.includes("apt-get install -y --no-install-recommends g++ libsqlite3-dev make python3 sqlite3"), `${relativePath}: must install SQLite native build/runtime packages`);
  expect(text.includes("npm install sqlite3@5.1.7 ws@8.18.3 --no-save --no-audit"), `${relativePath}: must install the Node 20 sqlite3 driver and WebSocket polyfill in the image`);
  expect(text.includes("COPY package.json package-lock.json ./"), `${relativePath}: must copy root package manifests`);
  expect(text.includes("COPY packages ./packages"), `${relativePath}: must copy local packages`);
  expect(text.includes("COPY spec/data/rates ./spec/data/rates"), `${relativePath}: must copy shared price-source data`);
  expect(text.includes("COPY examples/hello-fruit ./examples/hello-fruit"), `${relativePath}: must copy Hello Fruit sources`);
  expect(npmCiIndex !== -1, `${relativePath}: must run npm ci`);
  expect(buildIndex !== -1, `${relativePath}: must build its workspace package`);
  expect(npmCiIndex !== -1 && buildIndex !== -1 && npmCiIndex < buildIndex, `${relativePath}: npm ci must run before the demo build`);
  expect(buildIndex !== -1 && nodeEnvIndex > buildIndex, `${relativePath}: NODE_ENV=production must be set after build dependencies are used`);
  expect(exposeMatches.length === 1 && exposeMatches[0] === demo.port, `${relativePath}: must expose only ${demo.port}`);
  expect(text.includes('CMD ["npm", "start"]'), `${relativePath}: must start with npm start`);
}

function validateCompose(demo) {
  const relativePath = `${demo.dir}/compose.yml`;
  const text = read(relativePath);
  const compose = readYaml(relativePath);
  const services = compose.services ?? {};
  const serviceNames = Object.keys(services);
  const service = services[demo.service] ?? {};
  const envFile = service.env_file?.[0];
  const ports = service.ports ?? [];

  forbidSecrets(relativePath, text);
  expect(serviceNames.length === 1, `${relativePath}: must define only the app service`);
  expect(serviceNames.includes(demo.service), `${relativePath}: service name must include ${demo.service}`);
  expect(service.build?.context === "../../../..", `${relativePath}: build context must be the repo root`);
  expect(service.build?.dockerfile === `${demo.dir}/Dockerfile`, `${relativePath}: dockerfile path must target the demo Dockerfile`);
  expect(service.depends_on === undefined, `${relativePath}: local-sqlite demo must not depend on a database service`);
  expect(envFile?.path === "../../../../.env" && envFile?.required === false, `${relativePath}: root .env must be optional runtime env_file`);
  expect(service.environment?.OPENRECEIVE_STORE === "local-sqlite", `${relativePath}: OPENRECEIVE_STORE must default to local-sqlite`);
  expect(service.environment?.OPENRECEIVE_NAMESPACE === demo.namespace, `${relativePath}: app must receive a demo namespace`);
  expect(service.environment?.OPENRECEIVE_DEMO_MODE === "${OPENRECEIVE_DEMO_MODE:-test_nwc}", `${relativePath}: demo mode must default to test_nwc`);
  expect(service.environment?.OPENRECEIVE_DEPLOYED_AT === "${OPENRECEIVE_DEPLOYED_AT:-}", `${relativePath}: deployed_at metadata env must be pass-through`);
  expect(service.environment?.PORT === demo.port, `${relativePath}: PORT must be ${demo.port}`);
  expect((service.expose ?? []).length === 1 && service.expose[0] === demo.port, `${relativePath}: must expose only ${demo.port}`);
  expect(ports.length === 0, `${relativePath}: stable compose must not publish host ports`);
  expect(service.network_mode === undefined, `${relativePath}: must not use host networking`);
  expect(JSON.stringify(service.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: must not mount the Docker socket`);
  expect(service.volumes?.includes(demo.openreceiveVolume), `${relativePath}: OpenReceive SQLite storage must use named volume`);
  expect(compose.volumes?.[demo.openreceiveVolumeName] !== undefined, `${relativePath}: must declare ${demo.openreceiveVolumeName} volume`);
  expect(!text.includes("openreceive-postgres"), `${relativePath}: default demo compose must not start Postgres`);
}

function validateComposeOverride(demo) {
  const relativePath = `${demo.dir}/compose.override.yml.example`;
  const text = read(relativePath);
  const compose = readYaml(relativePath);
  const service = compose.services?.[demo.service] ?? {};
  const ports = service.ports ?? [];

  forbidSecrets(relativePath, text);
  expect(ports.length === 1 && ports[0] === `${demo.port}:${demo.port}`, `${relativePath}: local override must publish ${demo.port}:${demo.port}`);
  expect(service.network_mode === undefined, `${relativePath}: must not use host networking`);
  expect(JSON.stringify(service.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: must not mount the Docker socket`);
}

function validateEnvExample(demo) {
  const relativePath = `${demo.dir}/.env.example`;
  const text = read(relativePath);

  expect(/^OPENRECEIVE_NWC=$/m.test(text), `${relativePath}: OPENRECEIVE_NWC must be empty placeholder`);
  expect(new RegExp(`^PORT=${demo.port}$`, "m").test(text), `${relativePath}: PORT must default to ${demo.port}`);
  expect(/^OPENRECEIVE_WALLET_PROFILE=rizful$/m.test(text), `${relativePath}: wallet profile must default to rizful`);
  expect(!/nostr\+walletconnect:\/\//.test(text), `${relativePath}: must not contain an NWC URI`);
}

function validatePackage(demo) {
  const relativePath = `${demo.dir}/package.json`;
  const pkg = readJson(relativePath);

  expect(pkg.name === demo.packageName, `${relativePath}: package name must be ${demo.packageName}`);
  expect(pkg.scripts?.build === demo.buildScript, `${relativePath}: build script must run ${demo.buildScript}`);
  expect(pkg.scripts?.start === demo.startScript, `${relativePath}: start script must be ${demo.startScript}`);
  expect(pkg.scripts?.dev?.includes("require-openreceive-nwc.ts"), `${relativePath}: dev script must validate OPENRECEIVE_NWC before boot`);
  expect(pkg.scripts?.["openreceive:worker"] === undefined, `${relativePath}: worker script must not be exposed`);
  expect(pkg.scripts?.["openreceive:poll"] === undefined, `${relativePath}: removed status command script must not be exposed`);
  expect(pkg.dependencies?.pg === "^8.22.0", `${relativePath}: demo must depend on pg for package-owned invoice persistence`);
  expect(pkg.dependencies?.qrcode === undefined, `${relativePath}: qrcode must be provided by the OpenReceive UI package`);
}

function validateReadme(demo) {
  const relativePath = `${demo.dir}/README.md`;
  const text = read(relativePath);

  expect(text.includes("The browser never receives `OPENRECEIVE_NWC`."), `${relativePath}: must state browser NWC boundary`);
  expect(text.includes("valid receive-only `OPENRECEIVE_NWC`"), `${relativePath}: must state demos need a valid receive-only OPENRECEIVE_NWC`);
  expect(text.includes("docker compose -f compose.yml -f compose.override.yml.example up --build"), `${relativePath}: must document compose startup without a worker profile`);
  expect(text.includes("uses `local-sqlite` by default"), `${relativePath}: must document the local-sqlite default`);
  expect(text.includes("named `.openreceive` volume"), `${relativePath}: must document persistent OpenReceive SQLite storage`);
  expect(!text.includes("npm run openreceive:poll"), `${relativePath}: must not document removed status command scripts`);
  expect(!text.includes("openreceive:worker"), `${relativePath}: must not document a worker script`);
  expect(!text.includes("--profile openreceive-worker"), `${relativePath}: must not document worker profiles`);
  expect(text.includes("/demo-metadata.json"), `${relativePath}: must document demo metadata`);
}

function validateMakefile(demo) {
  const relativePath = `${demo.dir}/Makefile`;
  const text = read(relativePath);
  const targets = [...text.matchAll(/^([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);

  for (const target of [
    "setup",
    "dev",
    "test",
    "demo-test-nwc",
    "demo-production",
    "docker-build",
    "docker-run",
    "docker-smoke"
  ]) {
    expect(targets.includes(target), `${relativePath}: missing ${target} target`);
  }

  forbidSecrets(relativePath, text);
  expect(text.includes(`IMAGE ?= ${demo.image}`), `${relativePath}: image must default to ${demo.image}`);
  expect(text.includes(`SMOKE_URL ?= http://127.0.0.1:${demo.port}/demo-metadata.json`), `${relativePath}: smoke URL must target demo metadata on ${demo.port}`);
  expect(text.includes("COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example"), `${relativePath}: local compose command must include override example`);
  expect(text.includes("OPENRECEIVE_DEMO_MODE=test_nwc $(COMPOSE) up --build"), `${relativePath}: demo-test-nwc must use compose test_nwc mode`);
  expect(text.includes("OPENRECEIVE_DEMO_MODE=production $(COMPOSE) up --build"), `${relativePath}: demo-production must use compose production mode`);
  expect(!text.includes("--profile openreceive-worker"), `${relativePath}: Makefile must not use a worker profile`);
  expect(text.includes("$(COMPOSE) up"), `${relativePath}: docker-run must use compose command`);
  expect(text.includes("curl -fsS $(SMOKE_URL)"), `${relativePath}: docker-smoke must curl SMOKE_URL`);
}

function validateDockerignore() {
  const relativePath = ".dockerignore";
  const text = read(relativePath);

  for (const entry of [
    ".env",
    ".env.*",
    "private",
    "building",
    "demos/deploy/secrets",
    "demos/deploy/.ssh"
  ]) {
    expect(text.split(/\r?\n/).includes(entry), `${relativePath}: must ignore ${entry}`);
  }
}

for (const demo of demoContainers) {
  validatePackage(demo);
  validateEnvExample(demo);
  validateReadme(demo);
  validateMakefile(demo);
  validateDockerfile(demo);
  validateCompose(demo);
  validateComposeOverride(demo);
}
validateDockerignore();

if (findings.length > 0) {
  console.error("Demo container validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Demo container validation passed for ${demoContainers.length} demo(s).`);
