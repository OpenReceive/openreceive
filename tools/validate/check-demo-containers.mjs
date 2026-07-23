#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const demos = [
  {
    dir: "examples/hello-fruit/server/node-express",
    packageName: "@openreceive/example-node-express",
    service: "hello-fruit-node-express",
    port: "3000",
  },
  {
    dir: "examples/hello-fruit/server/static-html-small-api",
    packageName: "@openreceive/example-static-html-small-api",
    service: "hello-fruit-static-html-small-api",
    port: "3001",
  },
  {
    dir: "examples/hello-fruit/server/nextjs-fullstack",
    packageName: "@openreceive/example-nextjs-fullstack",
    service: "hello-fruit-nextjs-fullstack",
    port: "3002",
  },
];

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
const forbidSecrets = (relativePath, text) => {
  expect(!/nostr\+walletconnect:\/\//.test(text), `${relativePath}: contains an NWC URI`);
  expect(!/[?&]secret=[0-9a-fA-F]{16,}/.test(text), `${relativePath}: contains an NWC secret`);
};
const forbidOpenReceivePersistence = (relativePath, text) => {
  expect(
    !/local-sqlite|sqlite3|libsqlite|\bpostgres\b|OPENRECEIVE_STORE|OPENRECEIVE_NAMESPACE/i.test(
      text,
    ),
    `${relativePath}: contains OpenReceive persistence configuration`,
  );
  expect(
    !/\.openreceive/.test(text),
    `${relativePath}: mounts or references an OpenReceive state directory`,
  );
};

for (const demo of demos) {
  const packagePath = `${demo.dir}/package.json`;
  const pkg = parse(packagePath, JSON.parse);
  expect(pkg.name === demo.packageName, `${packagePath}: wrong package name`);
  expect(pkg.dependencies?.pg === undefined, `${packagePath}: must not depend on pg`);
  expect(pkg.dependencies?.sqlite3 === undefined, `${packagePath}: must not depend on sqlite3`);

  const dockerfilePath = `${demo.dir}/Dockerfile`;
  const dockerfile = read(dockerfilePath);
  forbidSecrets(dockerfilePath, dockerfile);
  forbidOpenReceivePersistence(dockerfilePath, dockerfile);
  expect(/^FROM node:22-bookworm-slim$/m.test(dockerfile), `${dockerfilePath}: must use Node 22`);
  expect(dockerfile.includes("npm ci --no-audit"), `${dockerfilePath}: must use npm ci`);
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
  const compose = parse(composePath, parseYaml);
  const service = compose.services?.[demo.service] ?? {};
  forbidSecrets(composePath, composeText);
  forbidOpenReceivePersistence(composePath, composeText);
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
  const override = parse(overridePath, parseYaml);
  forbidSecrets(overridePath, overrideText);
  forbidOpenReceivePersistence(overridePath, overrideText);
  expect(
    override.services?.[demo.service]?.ports?.[0] === `${demo.port}:${demo.port}`,
    `${overridePath}: wrong published port`,
  );

  const readmePath = `${demo.dir}/README.md`;
  const readme = read(readmePath);
  forbidSecrets(readmePath, readme);
  forbidOpenReceivePersistence(readmePath, readme);
  expect(
    readme.includes("The browser never receives your NWC code."),
    `${readmePath}: missing NWC boundary`,
  );
}

const envExamplePath = ".env.example";
const envExample = read(envExamplePath);
const envNames = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
expect(
  JSON.stringify(envNames) ===
    JSON.stringify(["NWC_URI", "LSC_URI_PRIMARY", "LSC_URI_BACKUP"]),
  `${envExamplePath}: must define only the three server-secret URI variables`,
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

console.log(`Demo container validation passed for ${demos.length} storage-free demo(s).`);
