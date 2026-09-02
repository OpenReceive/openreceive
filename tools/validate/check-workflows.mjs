#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();
const workflowDirectory = ".github/workflows";

// Every workflow file must be listed here: the validator scans the directory
// and fails on files it has no expectations for, so a new workflow cannot
// land unvalidated.
const requiredWorkflows = {
  "ci.yml": [
    // The per-push gate is package.json's test:ci:core, asserted by name so
    // its step list lives in exactly one place.
    "npm run test:ci:core",
    // Per-push browser smoke: one real checkout through the node-express
    // demo in Chromium (full spec matrix stays in the weekly demos lane).
    "npm run test:e2e:smoke",
    "tools/ci/ruby-tests.sh",
    "tools/ci/ruby-gem-build.sh",
    // The Rails example must run per-push, not only in the weekly demos lane
    // (a schema break in it once shipped unexecuted).
    "bin/ci",
  ],
  "conformance.yml": [
    "npm run validate",
    "npm run check:generated",
    "npm run test:js",
    "tools/ci/ruby-tests.sh",
  ],
  "demos.yml": [
    "npm run check:demo-containers",
    "npm run build:packages",
    "npm run build:demo",
    "npm run scan:client-bundles",
    // Weekly full Playwright matrix (ci.yml runs only the smoke spec).
    "npm run test:e2e",
    "bin/ci",
  ],
  "provider-registry.yml": [
    "npm run validate",
    "node --import tsx --test tests/provider-data.test.mjs",
  ],
  "security.yml": ["npm run scan:secrets", "npm run check:workflows"],
  "release.yml": [
    "npm run check:release",
    "npm run test:package-smoke",
    // Together with ci.yml these cover all of `npm run test:ci`; release:publish
    // relies on that to skip the local suite when both are green on HEAD.
    "npm run check:demo-containers",
    "npm run test -w @openreceive/example-buttons-rails",
    "npm run build:demo",
    "npm run scan:client-bundles",
    "does not match package.json version",
    "Release dry run complete",
  ],
  // The one workflow that publishes. RubyGems trusts this filename (with the
  // `rubygems` environment) as the gems' trusted publisher, so its checks
  // below are part of the trust boundary.
  "publish-gems.yml": ["does not match package.json version", "gem build", "gem push"],
};

// RubyGems.org's three trusted-publisher entries name this file and this
// environment; the environment requires a human approval and admits only v*
// tags. Any other workflow that ran `gem push` would be a second, ungated
// publisher, so the string is allowed here and nowhere else.
const gemPublishWorkflow = "publish-gems.yml";
const gemPublishEnvironment = "rubygems";

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
  // The repo's own npm/gem publish entry points: workflows may dry-run
  // releases but never publish through these; the gems publish only through
  // `gem push` in publish-gems.yml (see gemPublishWorkflow).
  "npm run release:publish",
  "npm run release:gem:publish",
];
const gemPushText = "gem push";

// The Ruby engine lanes run only inside ruby:* containers; the entry scripts
// must never run on the runner host (no gems or toolchains on the host).
const containerOnlyCommands = ["tools/ci/ruby-tests.sh", "tools/ci/ruby-gem-build.sh"];

const SHA_PINNED_USES = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

const findings = [];

function fail(message) {
  findings.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
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

/**
 * Every command a workflow runs, INCLUDING the ones inside the local composite
 * actions it uses. Without following `uses: ./.github/actions/*`, extracting a
 * shared setup block would silently drop its commands out of the per-workflow
 * expectations below — the check would keep passing while it stopped checking.
 */
function workflowCommands(workflow) {
  const commands = [];
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === "string") commands.push(step.run);
      if (typeof step.uses === "string" && step.uses.startsWith("./")) {
        commands.push(...localActionCommands(step.uses));
      }
    }
  }
  return commands;
}

function localActionCommands(uses) {
  for (const filename of ["action.yml", "action.yaml"]) {
    const actionPath = path.join(root, uses.slice(2), filename);
    if (!existsSync(actionPath)) continue;
    const action = parseYaml(readFileSync(actionPath, "utf8"));
    return (action.runs?.steps ?? [])
      .map((step) => step.run)
      .filter((run) => typeof run === "string");
  }
  throw new Error(`local action ${uses} has no action.yml`);
}

function containerImage(job) {
  if (typeof job.container === "string") return job.container;
  if (typeof job.container?.image === "string") return job.container.image;
  return undefined;
}

function checkActionPins(relativePath, workflow, text) {
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string") continue;
      // Local composite actions have no remote ref to pin.
      if (step.uses.startsWith("./")) continue;
      expect(
        SHA_PINNED_USES.test(step.uses),
        `${relativePath}: ${jobName} uses ${step.uses} — actions must be pinned to a full commit SHA`,
      );
    }
  }

  // A pinned SHA is unreadable on its own: the source line must keep the
  // resolved version as a trailing comment.
  for (const line of text.split("\n")) {
    const uses = line.match(/^\s*-?\s*uses:\s*(\S+)/);
    if (uses === null || uses[1].startsWith("./")) continue;
    expect(
      /#\s*v\d/.test(line),
      `${relativePath}: "${line.trim()}" must keep a "# vX" comment naming the pinned version`,
    );
  }
}

function checkContainerLanes(relativePath, workflow) {
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const [jobName, job] of Object.entries(jobs)) {
    const runsRubyLane = (job.steps ?? []).some(
      (step) =>
        typeof step.run === "string" &&
        containerOnlyCommands.some((command) => step.run.includes(command)),
    );
    if (!runsRubyLane) continue;
    const image = containerImage(job);
    expect(
      typeof image === "string" && image.startsWith("ruby:"),
      `${relativePath}: ${jobName} runs the Ruby lane and must run inside a ruby:* container`,
    );
    const usesHostRubySetup = (job.steps ?? []).some(
      (step) => typeof step.uses === "string" && step.uses.startsWith("ruby/setup-ruby"),
    );
    expect(
      !usesHostRubySetup,
      `${relativePath}: ${jobName} must not install Ruby on the runner host`,
    );
  }
}

// The trusted-publisher contract: every job runs in the gated environment,
// requests the OIDC token and nothing more, and only a v* tag can start it.
function checkGemPublishWorkflow(relativePath, workflow) {
  const tags = workflow.on?.push?.tags;
  expect(
    Array.isArray(tags) && tags.length === 1 && tags[0] === "v*",
    `${relativePath}: push trigger must be exactly the v* tags`,
  );
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const [jobName, job] of Object.entries(jobs)) {
    expect(
      job.environment === gemPublishEnvironment,
      `${relativePath}: ${jobName} must run in the ${gemPublishEnvironment} environment`,
    );
    const permissions = job.permissions === undefined ? {} : job.permissions;
    expect(
      permissions.contents === "read" &&
        permissions["id-token"] === "write" &&
        Object.keys(permissions).length === 2,
      `${relativePath}: ${jobName} permissions must be exactly contents: read + id-token: write`,
    );
    expect(
      typeof containerImage(job) === "string" && containerImage(job).startsWith("ruby:"),
      `${relativePath}: ${jobName} must build and push inside a ruby:* container`,
    );
  }
}

function checkNodeSetup(relativePath, workflow) {
  const jobs = workflow.jobs === undefined ? {} : workflow.jobs;
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses !== "string" || !step.uses.startsWith("actions/setup-node")) continue;
      expect(
        step.with?.["node-version-file"] === ".nvmrc" && step.with?.["node-version"] === undefined,
        `${relativePath}: ${jobName} setup-node must use node-version-file: .nvmrc (single source of truth)`,
      );
    }
  }
}

const presentWorkflows = existsSync(path.join(root, workflowDirectory))
  ? readdirSync(path.join(root, workflowDirectory)).filter(
      (entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"),
    )
  : [];

for (const entry of presentWorkflows) {
  expect(
    requiredWorkflows[entry] !== undefined,
    `${workflowDirectory}/${entry}: unknown workflow — add expectations for it in tools/validate/check-workflows.mjs`,
  );
}

for (const [fileName, requiredCommands] of Object.entries(requiredWorkflows)) {
  const relativePath = `${workflowDirectory}/${fileName}`;
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
  if (fileName === gemPublishWorkflow) {
    checkGemPublishWorkflow(relativePath, workflow);
  } else {
    expect(
      !text.includes(gemPushText),
      `${relativePath}: forbidden workflow text ${gemPushText} (only ${gemPublishWorkflow} publishes gems)`,
    );
  }

  checkActionPins(relativePath, workflow, text);
  checkContainerLanes(relativePath, workflow);
  checkNodeSetup(relativePath, workflow);
}

const ciWorkflow = readWorkflow(`${workflowDirectory}/ci.yml`).workflow;
// The gate ci.yml runs must exist, and must still contain the checker that
// validates ci.yml itself — otherwise this file stops running on push.
const rootScripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
expect(
  typeof rootScripts["test:ci:core"] === "string" &&
    rootScripts["test:ci:core"].includes("npm run check:workflows"),
  "package.json: test:ci:core must exist and include npm run check:workflows",
);
expect(
  ciWorkflow.on?.pull_request !== undefined,
  `${workflowDirectory}/ci.yml: missing pull_request trigger`,
);
expect(ciWorkflow.on?.push !== undefined, `${workflowDirectory}/ci.yml: missing push trigger`);
// The push trigger must watch the repository's actual default branch — a
// trigger on a nonexistent branch means push CI silently never runs.
expect(
  Array.isArray(ciWorkflow.on?.push?.branches) && ciWorkflow.on.push.branches.includes("master"),
  `${workflowDirectory}/ci.yml: push trigger must include the default branch (master)`,
);

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
