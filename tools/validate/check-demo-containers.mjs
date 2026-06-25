#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();

const demoContainers = [
  {
    id: "node-express-react",
    packageName: "@openreceive/example-node-express-react",
    dir: "examples/hello-fruit/server/node-express-react",
    service: "hello-fruit-node-express-react",
    image: "ghcr.io/openreceive/demo-express:local",
    port: "3000",
    namespace: "hello_fruit_express",
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
    buildScript: "next build",
    startScript: "tsx ../../shared/require-openreceive-nwc.ts && next start -H 0.0.0.0 -p ${PORT:-3002}"
  }
];

const railsDemoContainers = [
  {
    id: "rails-hotwire",
    dir: "examples/hello-fruit/server/rails-hotwire",
    service: "hello-fruit-rails-hotwire",
    image: "ghcr.io/openreceive/demo-rails-hotwire:local",
    port: "3003",
    namespace: "hello_fruit_rails",
    appStorageVolume: "openreceive-rails-storage:/app/examples/hello-fruit/server/rails-hotwire/storage",
    openreceiveVolume: "openreceive-rails-openreceive:/app/examples/hello-fruit/server/rails-hotwire/.openreceive",
    appStorageVolumeName: "openreceive-rails-storage",
    openreceiveVolumeName: "openreceive-rails-openreceive"
  }
];

const findings = [];
const jsDemoDatabaseService = "openreceive-postgres";
const jsDemoDatabaseVolume = "openreceive-postgres-data";
const jsDemoStoreUri = "postgres://openreceive:openreceive@openreceive-postgres:5432/openreceive";

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
  expect(text.includes("COPY package.json package-lock.json ./"), `${relativePath}: must copy root package manifests`);
  expect(text.includes("COPY packages ./packages"), `${relativePath}: must copy local packages`);
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
  const databaseService = services[jsDemoDatabaseService] ?? {};
  const envFile = service.env_file?.[0];
  const ports = service.ports ?? [];
  const databasePorts = databaseService.ports ?? [];

  forbidSecrets(relativePath, text);
  expect(serviceNames.length === 2, `${relativePath}: must define app and Postgres services`);
  expect(serviceNames.includes(demo.service), `${relativePath}: service name must include ${demo.service}`);
  expect(serviceNames.includes(jsDemoDatabaseService), `${relativePath}: service name must include ${jsDemoDatabaseService}`);
  expect(service.build?.context === "../../../..", `${relativePath}: build context must be the repo root`);
  expect(service.build?.dockerfile === `${demo.dir}/Dockerfile`, `${relativePath}: dockerfile path must target the demo Dockerfile`);
  expect(service.depends_on?.[jsDemoDatabaseService]?.condition === "service_healthy", `${relativePath}: app must wait for Postgres health`);
  expect(envFile?.path === "../../../../.env" && envFile?.required === false, `${relativePath}: root .env must be optional runtime env_file`);
  expect(service.environment?.OPENRECEIVE_STORE === jsDemoStoreUri, `${relativePath}: app must receive local Postgres OPENRECEIVE_STORE`);
  expect(service.environment?.OPENRECEIVE_NAMESPACE === demo.namespace, `${relativePath}: app must receive a demo namespace`);
  expect(service.environment?.OPENRECEIVE_DEMO_MODE === "${OPENRECEIVE_DEMO_MODE:-test_nwc}", `${relativePath}: demo mode must default to test_nwc`);
  expect(service.environment?.OPENRECEIVE_DEPLOYED_AT === "${OPENRECEIVE_DEPLOYED_AT:-}", `${relativePath}: deployed_at metadata env must be pass-through`);
  expect(service.environment?.PORT === demo.port, `${relativePath}: PORT must be ${demo.port}`);
  expect((service.expose ?? []).length === 1 && service.expose[0] === demo.port, `${relativePath}: must expose only ${demo.port}`);
  expect(ports.length === 0, `${relativePath}: stable compose must not publish host ports`);
  expect(service.network_mode === undefined, `${relativePath}: must not use host networking`);
  expect(JSON.stringify(service.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: must not mount the Docker socket`);
  expect(databaseService.image === "postgres:17-alpine", `${relativePath}: Postgres service must use pinned alpine image`);
  expect(databaseService.environment?.POSTGRES_DB === "openreceive", `${relativePath}: Postgres database must be openreceive`);
  expect(databaseService.environment?.POSTGRES_USER === "openreceive", `${relativePath}: Postgres user must be openreceive`);
  expect(databaseService.environment?.POSTGRES_PASSWORD === "openreceive", `${relativePath}: local Postgres password must be explicit demo-only value`);
  expect(databaseService.healthcheck?.test?.includes("pg_isready -U openreceive -d openreceive"), `${relativePath}: Postgres healthcheck must use pg_isready`);
  expect(databaseService.volumes?.[0] === `${jsDemoDatabaseVolume}:/var/lib/postgresql/data`, `${relativePath}: Postgres data must use named volume`);
  expect(databasePorts.length === 0, `${relativePath}: Postgres service must not publish host ports`);
  expect(databaseService.network_mode === undefined, `${relativePath}: Postgres service must not use host networking`);
  expect(JSON.stringify(databaseService.volumes ?? []).includes("/var/run/docker.sock") === false, `${relativePath}: Postgres service must not mount the Docker socket`);
  expect(compose.volumes?.[jsDemoDatabaseVolume] !== undefined, `${relativePath}: must declare ${jsDemoDatabaseVolume} volume`);
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
  expect(pkg.scripts?.["openreceive:poll"] === "openreceive poll --once", `${relativePath}: one-shot poll script must use default config`);
  expect(pkg.dependencies?.pg === "^8.22.0", `${relativePath}: demo must depend on pg for package-owned invoice persistence`);
  expect(pkg.dependencies?.qrcode === undefined, `${relativePath}: qrcode must be provided by the OpenReceive UI package`);
}

function validateReadme(demo) {
  const relativePath = `${demo.dir}/README.md`;
  const text = read(relativePath);

  expect(text.includes("The browser never receives `OPENRECEIVE_NWC`."), `${relativePath}: must state browser NWC boundary`);
  expect(text.includes("valid receive-only `OPENRECEIVE_NWC`"), `${relativePath}: must state demos need a valid receive-only OPENRECEIVE_NWC`);
  expect(text.includes("docker compose -f compose.yml -f compose.override.yml.example up --build"), `${relativePath}: must document compose startup without a worker profile`);
  expect(text.includes("npm run openreceive:poll"), `${relativePath}: must document the one-shot poll script`);
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
  expect(text.includes(`HEALTH_URL ?= http://127.0.0.1:${demo.port}/healthz`), `${relativePath}: smoke URL must target /healthz on ${demo.port}`);
  expect(text.includes("COMPOSE ?= docker compose -f compose.yml -f compose.override.yml.example"), `${relativePath}: local compose command must include override example`);
  expect(text.includes("OPENRECEIVE_DEMO_MODE=test_nwc $(COMPOSE) up --build"), `${relativePath}: demo-test-nwc must use compose test_nwc mode`);
  expect(text.includes("OPENRECEIVE_DEMO_MODE=production $(COMPOSE) up --build"), `${relativePath}: demo-production must use compose production mode`);
  expect(!text.includes("--profile openreceive-worker"), `${relativePath}: Makefile must not use a worker profile`);
  expect(text.includes("$(COMPOSE) up"), `${relativePath}: docker-run must use compose command`);
  expect(text.includes("curl -fsS $(HEALTH_URL)"), `${relativePath}: docker-smoke must curl HEALTH_URL`);
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

function validateRailsDemo(demo) {
  const gemfilePath = `${demo.dir}/Gemfile`;
  const dockerfilePath = `${demo.dir}/Dockerfile`;
  const composePath = `${demo.dir}/compose.yml`;
  const overridePath = `${demo.dir}/compose.override.yml.example`;
  const envPath = `${demo.dir}/.env.example`;
  const readmePath = `${demo.dir}/README.md`;
  const makefilePath = `${demo.dir}/Makefile`;

  const gemfile = read(gemfilePath);
  const dockerfile = read(dockerfilePath);
  const composeText = read(composePath);
  const compose = readYaml(composePath);
  const overrideText = read(overridePath);
  const override = readYaml(overridePath);
  const envExample = read(envPath);
  const readme = read(readmePath);
  const makefile = read(makefilePath);
  const routes = read(`${demo.dir}/config/routes.rb`);
  const initializer = read(`${demo.dir}/config/initializers/openreceive.rb`);
  const controller = read(`${demo.dir}/app/controllers/hello_fruit_controller.rb`);
  const partial = read(`${demo.dir}/app/views/openreceive/_invoice.html.erb`);

  forbidSecrets(gemfilePath, gemfile);
  forbidSecrets(dockerfilePath, dockerfile);
  forbidSecrets(composePath, composeText);
  forbidSecrets(overridePath, overrideText);
  forbidSecrets(readmePath, readme);
  forbidSecrets(makefilePath, makefile);
  forbidSecrets(`${demo.dir}/config/routes.rb`, routes);
  forbidSecrets(`${demo.dir}/app/controllers/hello_fruit_controller.rb`, controller);
  forbidSecrets(`${demo.dir}/app/views/openreceive/_invoice.html.erb`, partial);

  expect(gemfile.includes('gem "rails"'), `${gemfilePath}: must depend on Rails`);
  expect(gemfile.includes('gem "openreceive", path:'), `${gemfilePath}: must use local openreceive gem`);
  expect(gemfile.includes('gem "openreceive-rails", path:'), `${gemfilePath}: must use local openreceive-rails gem`);
  expect(/^FROM ruby:3\.3-bookworm$/m.test(dockerfile), `${dockerfilePath}: must use pinned Ruby 3.3 bookworm image`);
  expect(dockerfile.includes("COPY packages/ruby ./packages/ruby"), `${dockerfilePath}: must copy Ruby packages`);
  expect(dockerfile.includes("RUN bundle install"), `${dockerfilePath}: must bundle install`);
  expect(dockerfile.includes(`EXPOSE ${demo.port}`), `${dockerfilePath}: must expose ${demo.port}`);
  expect(dockerfile.includes("bundle exec rails db:prepare"), `${dockerfilePath}: must prepare Rails database before boot`);
  expect(dockerfile.includes("bundle exec rails server"), `${dockerfilePath}: must start Rails server`);

  const services = compose.services ?? {};
  const serviceNames = Object.keys(services);
  const service = services[demo.service] ?? {};
  expect(serviceNames.length === 1 && serviceNames[0] === demo.service, `${composePath}: service name must be ${demo.service}`);
  expect(service.build?.context === "../../../..", `${composePath}: build context must be repo root`);
  expect(service.build?.dockerfile === `${demo.dir}/Dockerfile`, `${composePath}: dockerfile path must target Rails demo Dockerfile`);
  expect(service.image === demo.image, `${composePath}: image must be ${demo.image}`);
  expect(service.env_file?.[0]?.path === "../../../../.env" && service.env_file?.[0]?.required === false, `${composePath}: root .env must be optional runtime env_file`);
  expect(service.environment?.OPENRECEIVE_DEMO_MODE === "${OPENRECEIVE_DEMO_MODE:-test_nwc}", `${composePath}: demo mode must default to test_nwc`);
  expect(service.environment?.OPENRECEIVE_STORE === "local-sqlite", `${composePath}: OPENRECEIVE_STORE must default to local-sqlite`);
  expect(service.environment?.OPENRECEIVE_NAMESPACE === demo.namespace, `${composePath}: OPENRECEIVE_NAMESPACE must be ${demo.namespace}`);
  expect(service.environment?.PORT === demo.port, `${composePath}: PORT must be ${demo.port}`);
  expect((service.expose ?? []).length === 1 && service.expose[0] === demo.port, `${composePath}: must expose only ${demo.port}`);
  expect((service.ports ?? []).length === 0, `${composePath}: stable compose must not publish host ports`);
  if (demo.appStorageVolume !== undefined) {
    expect(service.volumes?.includes(demo.appStorageVolume), `${composePath}: Rails app SQLite storage must use named volume`);
    expect(compose.volumes?.[demo.appStorageVolumeName] !== undefined, `${composePath}: must declare ${demo.appStorageVolumeName} volume`);
  }
  expect(service.volumes?.includes(demo.openreceiveVolume), `${composePath}: OpenReceive SQLite storage must use named volume`);
  expect(compose.volumes?.[demo.openreceiveVolumeName] !== undefined, `${composePath}: must declare ${demo.openreceiveVolumeName} volume`);

  const overrideService = override.services?.[demo.service] ?? {};
  expect(overrideService.ports?.[0] === `${demo.port}:${demo.port}`, `${overridePath}: local override must publish ${demo.port}:${demo.port}`);
  expect(/^OPENRECEIVE_NWC=$/m.test(envExample), `${envPath}: OPENRECEIVE_NWC must be empty placeholder`);
  expect(/^# OPENRECEIVE_STORE defaults to local-sqlite$/m.test(envExample), `${envPath}: OPENRECEIVE_STORE must document local-sqlite default`);
  expect(new RegExp(`^OPENRECEIVE_NAMESPACE=${demo.namespace}$`, "m").test(envExample), `${envPath}: OPENRECEIVE_NAMESPACE must default to ${demo.namespace}`);
  expect(new RegExp(`^PORT=${demo.port}$`, "m").test(envExample), `${envPath}: PORT must default to ${demo.port}`);
  expect(readme.includes("The browser never receives `OPENRECEIVE_NWC`."), `${readmePath}: must state browser NWC boundary`);
  expect(readme.includes("docker compose -f compose.yml -f compose.override.yml.example up --build"), `${readmePath}: must document compose startup`);
  expect(makefile.includes(`IMAGE ?= ${demo.image}`), `${makefilePath}: image must default to ${demo.image}`);
  expect(makefile.includes(`HEALTH_URL ?= http://127.0.0.1:${demo.port}/healthz`), `${makefilePath}: smoke URL must target healthz`);
  expect(routes.includes('mount OpenReceive::Rails::Engine => "/openreceive"'), `${demo.dir}/config/routes.rb: must mount OpenReceive engine`);
  expect(initializer.includes("NwcRuby::Client.from_uri"), `${demo.dir}/config/initializers/openreceive.rb: must wire nwc-ruby client`);
  expect(initializer.includes('ENV.fetch("OPENRECEIVE_NWC"'), `${demo.dir}/config/initializers/openreceive.rb: must require OPENRECEIVE_NWC at boot`);
  expect(initializer.includes("OpenReceive.parse_nwc_uri"), `${demo.dir}/config/initializers/openreceive.rb: must validate OPENRECEIVE_NWC at boot`);
  expect(!initializer.includes("OpenReceive::UnavailableReceiveClient"), `${demo.dir}/config/initializers/openreceive.rb: demos must not boot with an unavailable wallet client`);
  expect(initializer.includes("OpenReceive::Rails.resolve_invoice_store"), `${demo.dir}/config/initializers/openreceive.rb: must use package-owned OpenReceive invoice store`);
  expect(!initializer.includes("create_active_record_invoice_store"), `${demo.dir}/config/initializers/openreceive.rb: must not use app ActiveRecord invoice storage`);
  expect(initializer.includes("config.settlement_action"), `${demo.dir}/config/initializers/openreceive.rb: must configure settlement action`);
  expect(controller.includes("nwc_secret_exposed: false"), `${demo.dir}/app/controllers/hello_fruit_controller.rb: metadata must explicitly avoid NWC exposure`);
  expect(partial.includes("turbo_frame_tag"), `${demo.dir}/app/views/openreceive/_invoice.html.erb: must render Turbo frame`);
  expect(!existsSync(path.join(root, demo.dir, "app/models/open_receive_invoice.rb")), `${demo.dir}: must not ship an app ActiveRecord invoice model`);
  expect(!existsSync(path.join(root, demo.dir, "db/migrate/002_create_openreceive_tables.rb")), `${demo.dir}: must not ship an app OpenReceive invoice migration`);
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
for (const demo of railsDemoContainers) {
  validateRailsDemo(demo);
}
validateDockerignore();

if (findings.length > 0) {
  console.error("Demo container validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Demo container validation passed for ${demoContainers.length + railsDemoContainers.length} demo(s).`);
