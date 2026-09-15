import { availableParallelism } from "node:os";

export function packageJobs(value = process.env.OPENRECEIVE_PACKAGE_JOBS) {
  const jobs = Number(value ?? Math.min(4, availableParallelism()));
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error("OPENRECEIVE_PACKAGE_JOBS must be a positive integer.");
  }
  return jobs;
}

export function workspaceDependencies(pkg, names) {
  return Object.keys({
    ...pkg.manifest.dependencies,
    ...pkg.manifest.optionalDependencies,
    ...pkg.manifest.peerDependencies,
    ...pkg.manifest.devDependencies,
  }).filter((name) => names.has(name));
}

// Validate the whole graph before starting. On failure, stop scheduling new
// work and drain running tasks before callers remove their temporary files.
export async function runPackageTasks(packages, task, jobs = packageJobs()) {
  packageJobs(jobs);
  const names = new Set(packages.map((pkg) => pkg.manifest.name));
  if (names.size !== packages.length) throw new Error("Duplicate workspace package name.");
  const dependencies = new Map(
    packages.map((pkg) => [pkg.manifest.name, workspaceDependencies(pkg, names)]),
  );
  const visited = new Set();
  const visiting = new Set();
  function visit(name) {
    if (visiting.has(name)) throw new Error(`Workspace dependency cycle at ${name}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name)) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name);

  const pending = new Set(packages);
  const running = new Set();
  const completed = new Map();
  let failure;
  while (pending.size || running.size) {
    for (const pkg of pending) {
      if (failure || running.size >= jobs) break;
      const name = pkg.manifest.name;
      if (!dependencies.get(name).every((dependency) => completed.has(dependency))) continue;
      pending.delete(pkg);
      const promise = Promise.resolve()
        .then(() => task(pkg))
        .then((result) => completed.set(name, result))
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => running.delete(promise));
      running.add(promise);
    }
    if (running.size) await Promise.race(running);
    else break;
  }
  if (failure) throw failure;
  return packages.map((pkg) => completed.get(pkg.manifest.name));
}
