#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  buildPackageArtifact,
  discoverWorkspacePackages,
  validateWorkspacePackageGraph,
} from "./build-artifacts.mjs";
import { runPackageTasks, workspaceDependencies } from "./parallel.mjs";

export async function buildWorkspaces(input = {}) {
  const root = input.root ?? process.cwd();
  const packages = discoverWorkspacePackages({ root });
  validateWorkspacePackageGraph(packages);
  const names = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const selected = new Set();
  function select(name) {
    if (selected.has(name)) return;
    const pkg = names.get(name);
    if (!pkg) throw new Error(`Unknown workspace package ${name}`);
    selected.add(name);
    for (const dependency of workspaceDependencies(pkg, names)) select(dependency);
  }
  for (const name of input.names?.length ? input.names : names.keys()) select(name);
  await runPackageTasks(
    packages.filter((pkg) => selected.has(pkg.manifest.name)),
    async (pkg) => {
      console.error(`building ${pkg.manifest.name}`);
      await buildPackageArtifact(pkg, undefined, { root });
    },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildWorkspaces({ names: process.argv.slice(2) }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
