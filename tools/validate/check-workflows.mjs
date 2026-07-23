#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const workflowDirectory = ".github/workflows";
const requiredWorkflows = {
  [`${workflowDirectory}/ci.yml`]: [
    "npm test",
    "npm run lint",
    "npm run check:generated",
    "npm run typecheck",
    "npm run test:js",
  ],
  [`${workflowDirectory}/conformance.yml`]: [
    "npm run validate",
    "npm run check:generated",
    "npm run test:js",
  ],
  [`${workflowDirectory}/demos.yml`]: [
    "npm run check:demo-containers",
    "npm run build:demo",
    "npm run scan:client-bundles",
  ],
  [`${workflowDirectory}/provider-registry.yml`]: [
    "npm run validate",
    "tests/v0.1/provider-data.test.mjs",
  ],
  [`${workflowDirectory}/security.yml`]: [
    "npm run scan:secrets",
    "npm run check:workflows",
    "npm run scan:client-bundles",
  ],
  [`${workflowDirectory}/release.yml`]: [
    "npm run check:release",
    "npm run test:package-smoke",
    "Release dry run complete",
  ],
  [`${workflowDirectory}/publish.yml`]: ["npm run check:release", "Publishing is disabled"],
};

const forbiddenText = [
  "pull_request_target",
  "NWC_URI: $",
  "NWC_URI: ${{",
  "secrets.NWC_URI",
  "LSC_URI_PRIMARY: $",
  "LSC_URI_BACKUP: $",
  "secrets.LSC_URI_PRIMARY",
  "secrets.LSC_URI_BACKUP",
  "secrets.CLOUDFLARE_API_TOKEN",
  "secrets.DEPLOY_SSH_KEY",
  "secrets.WIREGUARD",
  "npm publish",
  "docker push",
  "gh release create",
];

const findings = [];

function fail(message) {
  findings.push(message);
}

function readWorkflow(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!existsSync(absolute)) {
    fail(`${relativePath}: missing workflow`);
    return { text: "", workflow: {} };
  }

  const text = readFileSync(absolute, "utf8");
  try {
    const workflow = parseYaml(text);
    return {
      text,
      workflow: workflow === null ? {} : workflow,
    };
  } catch (error) {
    fail(`${relativePath}: ${error.message}`);
    return { text, workflow: {} };
  }
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function workflowCommands(workflow) {
  const commands = [];
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === "string") commands.push(step.run);
    }
  }
  return commands;
}

for (const [relativePath, requiredCommands] of Object.entries(requiredWorkflows)) {
  const { text, workflow } = readWorkflow(relativePath);
  const commands = workflowCommands(workflow);
  const allCommands = commands.join("\n");

  expect(
    typeof workflow.name === "string" && workflow.name.length > 0,
    `${relativePath}: missing workflow name`,
  );
  expect(workflow.on !== undefined, `${relativePath}: missing triggers`);
  expect(
    workflow.permissions?.contents === "read",
    `${relativePath}: contents permission must be read-only`,
  );
  const permissions = workflow.permissions === undefined ? {} : workflow.permissions;
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  expect(
    Object.keys(permissions).length === 1,
    `${relativePath}: workflow must not request extra permissions`,
  );
  expect(workflow.concurrency !== undefined, `${relativePath}: missing concurrency group`);
  expect(Object.keys(jobs).length > 0, `${relativePath}: missing jobs`);

  for (const command of requiredCommands) {
    expect(allCommands.includes(command), `${relativePath}: missing command ${command}`);
  }

  for (const forbidden of forbiddenText) {
    expect(!text.includes(forbidden), `${relativePath}: forbidden workflow text ${forbidden}`);
  }
}

const ciWorkflow = readWorkflow(`${workflowDirectory}/ci.yml`).workflow;
expect(
  ciWorkflow.on?.pull_request !== undefined,
  `${workflowDirectory}/ci.yml: missing pull_request trigger`,
);
expect(ciWorkflow.on?.push !== undefined, `${workflowDirectory}/ci.yml: missing push trigger`);

for (const scheduled of ["conformance.yml", "demos.yml", "provider-registry.yml", "security.yml"]) {
  const workflow = readWorkflow(`${workflowDirectory}/${scheduled}`).workflow;
  expect(
    workflow.on?.schedule !== undefined,
    `${workflowDirectory}/${scheduled}: missing scheduled slow-lane trigger`,
  );
}

const releaseWorkflow = readWorkflow(`${workflowDirectory}/release.yml`).workflow;
expect(
  releaseWorkflow.on?.push?.tags !== undefined,
  `${workflowDirectory}/release.yml: missing tag pre-release trigger`,
);

if (findings.length > 0) {
  console.error("Workflow validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Workflow validation passed for ${Object.keys(requiredWorkflows).length} workflow(s).`);
