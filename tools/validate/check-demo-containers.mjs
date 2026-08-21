#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { OPENRECEIVE_DEMOS } from "../shared/demo-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeDemos = OPENRECEIVE_DEMOS.filter((demo) => demo.kind === "node");
const railsDemo = OPENRECEIVE_DEMOS.find((demo) => demo.kind === "rails");

const findings = [];
const fail = (message) => findings.push(message);
const expect = (condition, message) => {
  if (!condition) fail(message);
};
const read = (relativePath) => {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath}: missing file`);
    return "";
  }
  return readFileSync(absolute, "utf8");
};
const parse = (relativePath, parser) => {
  try {
    return parser(read(relativePath)) ?? {};
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return {};
  }
};
/** Compose files share service shape through `<<: *anchor`, so merge keys must resolve. */
const parseCompose = (text) => parseYaml(text, { merge: true });
const forbidSecrets = (relativePath, text) => {
  expect(!/nostr\+walletconnect:\/\//.test(text), `${relativePath}: contains an NWC URI`);
  expect(!/[?&]secret=[0-9a-fA-F]{16,}/.test(text), `${relativePath}: contains an NWC secret`);
};
/** Compose/Dockerfile must not configure OpenReceive runtime persistence. */
const forbidOpenReceiveRuntimePersistence = (
  relativePath,
  text,
  { allowHostPostgres = false } = {},
) => {
  expect(
    !/OPENRECEIVE_STORE|OPENRECEIVE_NAMESPACE|OPENRECEIVE_DATABASE/i.test(text),
    `${relativePath}: contains OpenReceive runtime persistence configuration`,
  );
  if (!allowHostPostgres) {
    expect(
      !/\bpostgres\b/i.test(text),
      `${relativePath}: must not wire a Postgres service into OpenReceive`,
    );
  }
  expect(
    !/\.openreceive/.test(text),
    `${relativePath}: must not mount an OpenReceive state directory`,
  );
};
/** No demo reads a mode switch: `npm run demo <x>` always runs the image's built server. */
const forbidDemoModeSwitch = (relativePath, text) => {
  expect(
    !/OPENRECEIVE_DEMO_MODE/.test(text),
    `${relativePath}: references OPENRECEIVE_DEMO_MODE, which no code reads`,
  );
};
/** The published-port override exists to publish ports — never to swap in a dev server. */
const expectPortsOnlyOverride = (relativePath, override, service, port) => {
  const overridden = override.services?.[service] ?? {};
  expect(
    overridden.ports?.[0] === `${port}:${port}`,
    `${relativePath}: must publish ${port}:${port}`,
  );
  expect(
    Object.keys(overridden).join(",") === "ports",
    `${relativePath}: must publish ports only — the image's production command stays`,
  );
  expect(
    Object.keys(override.services ?? {}).length === 1,
    `${relativePath}: must override exactly one service`,
  );
};

for (const demo of nodeDemos) {
  const packagePath = `${demo.dir}/package.json`;
  const pkg = parse(packagePath, JSON.parse);
  expect(pkg.name === demo.packageName, `${packagePath}: wrong package name`);
  expect(pkg.dependencies?.pg === undefined, `${packagePath}: must not depend on pg`);
  expect(pkg.dependencies?.sqlite3 === undefined, `${packagePath}: must not depend on sqlite3`);
  expect(
    pkg.dependencies?.["better-sqlite3"] === undefined,
    `${packagePath}: must not depend on better-sqlite3`,
  );

  const dockerfilePath = `${demo.dir}/Dockerfile`;
  const dockerfile = read(dockerfilePath);
  forbidSecrets(dockerfilePath, dockerfile);
  forbidOpenReceiveRuntimePersistence(dockerfilePath, dockerfile);
  forbidDemoModeSwitch(dockerfilePath, dockerfile);
  expect(/^FROM node:22-bookworm-slim$/m.test(dockerfile), `${dockerfilePath}: must use Node 22`);
  expect(dockerfile.includes("npm ci --no-audit"), `${dockerfilePath}: must use npm ci`);
  expect(
    dockerfile.includes("COPY config ./config"),
    `${dockerfilePath}: must copy shared OpenReceive config`,
  );
  expect(
    dockerfile.includes("COPY tools/run-with-root-env.mjs ./tools/run-with-root-env.mjs"),
    `${dockerfilePath}: must copy the root-env launcher`,
  );
  expect(
    dockerfile.includes("RUN npm run build:packages"),
    `${dockerfilePath}: must build packages`,
  );
  expect(
    dockerfile.includes(`RUN npm run build -w ${demo.packageName}`),
    `${dockerfilePath}: must build the demo`,
  );
  expect(dockerfile.includes(`EXPOSE ${demo.port}`), `${dockerfilePath}: must expose ${demo.port}`);

  const composePath = `${demo.dir}/compose.yml`;
  const composeText = read(composePath);
  const compose = parse(composePath, parseCompose);
  const service = compose.services?.[demo.service] ?? {};
  forbidSecrets(composePath, composeText);
  forbidOpenReceiveRuntimePersistence(composePath, composeText);
  forbidDemoModeSwitch(composePath, composeText);
  expect(
    Object.keys(compose.services ?? {}).length === 1,
    `${composePath}: must define one app service`,
  );
  expect(
    service.build?.context === "../../../..",
    `${composePath}: build context must be the repo root`,
  );
  expect(service.depends_on === undefined, `${composePath}: must not depend on a database`);
  expect(compose.volumes === undefined, `${composePath}: must not declare OpenReceive volumes`);
  expect(service.volumes === undefined, `${composePath}: must not mount configuration files`);
  expect(service.env_file?.length === 1, `${composePath}: must load one environment file`);
  expect(
    service.env_file?.[0] === "../../../../.env",
    `${composePath}: must load the repo-root .env`,
  );
  expect(service.environment?.PORT === demo.port, `${composePath}: wrong PORT`);

  const overridePath = `${demo.dir}/compose.override.yml.example`;
  const overrideText = read(overridePath);
  const override = parse(overridePath, parseCompose);
  forbidSecrets(overridePath, overrideText);
  forbidOpenReceiveRuntimePersistence(overridePath, overrideText);
  forbidDemoModeSwitch(overridePath, overrideText);
  expectPortsOnlyOverride(overridePath, override, demo.service, demo.port);

  const makefilePath = `${demo.dir}/Makefile`;
  forbidDemoModeSwitch(makefilePath, read(makefilePath));

  const readmePath = `${demo.dir}/README.md`;
  const readme = read(readmePath);
  forbidSecrets(readmePath, readme);
  forbidDemoModeSwitch(readmePath, readme);
  expect(
    !/OPENRECEIVE_STORE|OPENRECEIVE_NAMESPACE|OPENRECEIVE_DATABASE/i.test(readme),
    `${readmePath}: must not document OpenReceive runtime persistence`,
  );
  expect(
    readme.includes("The browser never receives your NWC code."),
    `${readmePath}: missing NWC boundary`,
  );
  expect(
    /host-owned|host owns|host SQLite|local SQLite/i.test(readme),
    `${readmePath}: must describe host-owned persistence`,
  );
}

{
  const demo = railsDemo;
  const dockerfilePath = `${demo.dir}/Dockerfile`;
  const dockerfile = read(dockerfilePath);
  forbidSecrets(dockerfilePath, dockerfile);
  forbidOpenReceiveRuntimePersistence(dockerfilePath, dockerfile, { allowHostPostgres: true });
  forbidDemoModeSwitch(dockerfilePath, dockerfile);
  expect(/FROM ruby:/m.test(dockerfile), `${dockerfilePath}: must use a Ruby base image`);
  expect(
    /FROM node:22/m.test(dockerfile),
    `${dockerfilePath}: must build the Shakapacker client with Node 22`,
  );
  expect(
    dockerfile.includes(`npm run build -w ${demo.packageName}`),
    `${dockerfilePath}: must build the Rails Hello Fruit client`,
  );
  expect(dockerfile.includes("packages/ruby"), `${dockerfilePath}: must copy Ruby packages`);
  expect(
    dockerfile.includes("examples/hello-fruit/shared"),
    `${dockerfilePath}: must copy shared Hello Fruit assets`,
  );
  expect(dockerfile.includes(`EXPOSE ${demo.port}`), `${dockerfilePath}: must expose ${demo.port}`);

  // Shakapacker layout: one pack entry, webpack config, and a manifest-driven
  // public/packs handed from the client stage to the Ruby stage.
  const packsEntry = "app/javascript/packs/hello_fruit.js";
  expect(
    existsSync(path.join(root, demo.dir, packsEntry)),
    `${demo.dir}/${packsEntry}: missing Shakapacker pack entry`,
  );
  expect(
    existsSync(path.join(root, demo.dir, "app/javascript/src/main.tsx")),
    `${demo.dir}/app/javascript/src/main.tsx: missing React client entry`,
  );
  expect(
    existsSync(path.join(root, demo.dir, "lib/hello_fruit/public_cache_headers.rb")),
    `${demo.dir}/lib/hello_fruit/public_cache_headers.rb: missing public cache middleware`,
  );

  const shakapackerConfigPath = `${demo.dir}/config/shakapacker.yml`;
  const shakapacker = parse(shakapackerConfigPath, parseCompose);
  expect(
    shakapacker.default?.source_path === "app/javascript",
    `${shakapackerConfigPath}: source_path must be app/javascript`,
  );
  expect(
    shakapacker.default?.source_entry_path === "packs",
    `${shakapackerConfigPath}: source_entry_path must be packs`,
  );
  expect(
    shakapacker.default?.public_output_path === "packs",
    `${shakapackerConfigPath}: must emit into public/packs`,
  );
  expect(
    shakapacker.production?.compile === false,
    `${shakapackerConfigPath}: production must not compile on request`,
  );
  expect(
    (shakapacker.default?.additional_paths ?? []).includes("../../shared"),
    `${shakapackerConfigPath}: must resolve the shared Hello Fruit helpers`,
  );

  const railsPackagePath = `${demo.dir}/package.json`;
  const railsPackage = parse(railsPackagePath, JSON.parse);
  expect(railsPackage.name === demo.packageName, `${railsPackagePath}: wrong package name`);
  expect(
    /webpack --config config\/webpack\/webpack\.config\.js/.test(railsPackage.scripts?.build ?? ""),
    `${railsPackagePath}: build must run the Shakapacker webpack config`,
  );
  expect(
    existsSync(path.join(root, demo.dir, "config/webpack/webpack.config.js")),
    `${demo.dir}/config/webpack/webpack.config.js: missing webpack config`,
  );

  // The webpack manifest is the digest authority; a Propshaft/Sprockets
  // precompile pass would fingerprint the same bundles a second time.
  expect(
    !/^\s*RUN[^\n]*assets:precompile/m.test(dockerfile),
    `${dockerfilePath}: must not precompile assets — public/packs/manifest.json is the digest authority`,
  );
  expect(
    /COPY --from=client [^\n]*public\/packs/.test(dockerfile),
    `${dockerfilePath}: must copy the client stage's public/packs into the Ruby stage`,
  );
  expect(
    dockerfile.includes("ARG CLIENT_BUILD_ID"),
    `${dockerfilePath}: must accept CLIENT_BUILD_ID so demo rebuilds pick up JS`,
  );
  const dockerignore = read(".dockerignore");
  expect(
    dockerignore.includes("**/public/packs*"),
    ".dockerignore: must exclude host Shakapacker output from the Rails image context",
  );

  const composePath = `${demo.dir}/compose.yml`;
  const composeText = read(composePath);
  const compose = parse(composePath, parseCompose);
  const service = compose.services?.[demo.service] ?? {};
  const notifications = compose.services?.[demo.notificationsService] ?? {};
  const db = compose.services?.[demo.dbService] ?? {};
  forbidSecrets(composePath, composeText);
  forbidOpenReceiveRuntimePersistence(composePath, composeText, { allowHostPostgres: true });
  forbidDemoModeSwitch(composePath, composeText);
  expect(db.image?.includes("postgres"), `${composePath}: must define a host Postgres service`);
  // The NWC-02 listener plus periodic pass is its own process; no web process runs a timer.
  expect(
    notifications.command?.join(" ").includes("openreceive:notifications"),
    `${composePath}: notifications worker must run the openreceive:notifications task`,
  );
  expect(
    service.command === undefined,
    `${composePath}: the app service must run the image's default production command`,
  );
  expect(
    service.build?.context === "../../../..",
    `${composePath}: build context must be the repo root`,
  );
  expect(
    service.build?.args?.CLIENT_BUILD_ID !== undefined,
    `${composePath}: must pass CLIENT_BUILD_ID so demo rebuilds pick up JS`,
  );
  expect(service.depends_on?.db !== undefined, `${composePath}: app must depend on host Postgres`);
  expect(
    /DATABASE_URL/.test(composeText),
    `${composePath}: must set host DATABASE_URL (not OpenReceive persistence)`,
  );
  expect(
    !/OPENRECEIVE_STORE|OPENRECEIVE_NAMESPACE|OPENRECEIVE_DATABASE/i.test(composeText),
    `${composePath}: must not set OpenReceive runtime persistence env`,
  );
  expect(service.env_file?.length === 1, `${composePath}: must load one environment file`);
  expect(
    service.env_file?.[0] === "../../../../.env",
    `${composePath}: must load the repo-root .env`,
  );
  expect(service.environment?.PORT === demo.port, `${composePath}: wrong PORT`);

  const overridePath = `${demo.dir}/compose.override.yml.example`;
  const overrideText = read(overridePath);
  const override = parse(overridePath, parseCompose);
  forbidSecrets(overridePath, overrideText);
  forbidOpenReceiveRuntimePersistence(overridePath, overrideText, { allowHostPostgres: true });
  forbidDemoModeSwitch(overridePath, overrideText);
  expectPortsOnlyOverride(overridePath, override, demo.service, demo.port);

  const readmePath = `${demo.dir}/README.md`;
  const readme = read(readmePath);
  forbidSecrets(readmePath, readme);
  forbidDemoModeSwitch(readmePath, readme);
  expect(
    !/OPENRECEIVE_STORE|OPENRECEIVE_NAMESPACE|OPENRECEIVE_DATABASE/i.test(readme),
    `${readmePath}: must not document OpenReceive runtime persistence`,
  );
  expect(
    readme.includes("The browser never receives your NWC code."),
    `${readmePath}: missing NWC boundary`,
  );
  expect(
    /host-owned|Host-owned|host owns/i.test(readme),
    `${readmePath}: must describe host-owned persistence`,
  );
  expect(/Postgres|postgres/i.test(readme), `${readmePath}: must describe host Postgres`);

  const migrationsDir = `${demo.dir}/db/migrate`;
  const migratePath = path.join(root, migrationsDir);
  expect(existsSync(migratePath), `${migrationsDir}: missing migrations`);
  const migrateListing = existsSync(migratePath) ? readdirSync(migratePath).join("\n") : "";
  expect(/create_products/.test(migrateListing), `${migrationsDir}: missing products migration`);
  expect(/create_orders/.test(migrateListing), `${migrationsDir}: missing orders migration`);
  expect(
    /create_openreceive_tables/.test(migrateListing),
    `${migrationsDir}: missing openreceive tables migration`,
  );
}

const envExamplePath = ".env.example";
const envExample = read(envExamplePath);
const envNames = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
expect(
  JSON.stringify(envNames) ===
    JSON.stringify(["NWC_URI", "LSC_URI_PRIMARY", "LSC_URI_BACKUP", "LOG_LEVEL"]),
  `${envExamplePath}: must define the three server-secret URI variables plus LOG_LEVEL`,
);
expect(
  /^LOG_LEVEL=(DEBUG|INFO|WARN|ERROR)$/m.test(envExample),
  `${envExamplePath}: LOG_LEVEL must be DEBUG|INFO|WARN|ERROR`,
);
expect(
  !/[?&]secret=[0-9a-fA-F]{64}/.test(envExample),
  `${envExamplePath}: contains a real-looking secret`,
);

if (findings.length > 0) {
  console.error("Demo container validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Demo container validation passed for ${nodeDemos.length} Node demo(s) + Rails demo without OpenReceive runtime persistence.`,
);
