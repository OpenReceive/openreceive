#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const requiredWorkflows = {
  ".github/workflows/ci.yml": ["npm run test:ci"],
  ".github/workflows/conformance.yml": ["npm run validate", "npm run check:generated", "npm run test:js"],
  ".github/workflows/demos.yml": ["npm run check:demo-containers", "npm run check:demo-deploy", "npm run build:demo", "npm run scan:client-bundles"],
  ".github/workflows/provider-registry.yml": ["npm run validate", "tests/v0.1/provider-data.test.mjs"],
  ".github/workflows/security.yml": ["npm run scan:secrets", "npm run check:workflows", "npm run scan:client-bundles"],
  ".github/workflows/release.yml": ["npm run check:release", "npm run test:package-smoke", "Release dry run complete"],
  ".github/workflows/publish.yml": ["npm run check:release", "Publishing is disabled"]
};

const forbiddenText = [
  "pull_request_target",
  "OPENRECEIVE_NWC: $",
  "OPENRECEIVE_NWC: ${{",
  "secrets.OPENRECEIVE_NWC",
  "secrets.CLOUDFLARE_API_TOKEN",
  "secrets.DEPLOY_SSH_KEY",
  "secrets.WIREGUARD",
  "npm publish",
  "docker push",
  "gh release create"
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
    return {
      text,
      workflow: parseYaml(text) ?? {}
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
  for (const job of Object.values(workflow.jobs ?? {})) {
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

  expect(typeof workflow.name === "string" && workflow.name.length > 0, `${relativePath}: missing workflow name`);
  expect(workflow.on !== undefined, `${relativePath}: missing triggers`);
  expect(workflow.permissions?.contents === "read", `${relativePath}: contents permission must be read-only`);
  expect(Object.keys(workflow.permissions ?? {}).length === 1, `${relativePath}: workflow must not request extra permissions`);
  expect(workflow.concurrency !== undefined, `${relativePath}: missing concurrency group`);
  expect(Object.keys(workflow.jobs ?? {}).length > 0, `${relativePath}: missing jobs`);

  for (const command of requiredCommands) {
    expect(allCommands.includes(command), `${relativePath}: missing command ${command}`);
  }

  for (const forbidden of forbiddenText) {
    expect(!text.includes(forbidden), `${relativePath}: forbidden workflow text ${forbidden}`);
  }
}

if (findings.length > 0) {
  console.error("Workflow validation failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Workflow validation passed for ${Object.keys(requiredWorkflows).length} workflow(s).`);
