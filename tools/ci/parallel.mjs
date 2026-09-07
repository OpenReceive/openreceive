#!/usr/bin/env node

// Run independent npm scripts with bounded concurrency. Build dependencies must
// finish before invoking this runner; each lane keeps its own complete log.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";

const scripts = process.argv.slice(2);
const jobs = Number(process.env.OPENRECEIVE_CI_JOBS ?? Math.min(4, availableParallelism()));
if (!Number.isSafeInteger(jobs) || jobs < 1 || scripts.length === 0) {
  console.error(
    "Usage: OPENRECEIVE_CI_JOBS=<positive integer> node tools/ci/parallel.mjs <npm scripts...>",
  );
  process.exit(1);
}

const directory = mkdtempSync(path.join(tmpdir(), "openreceive-ci-"));
console.log(`Running up to ${jobs} independent checks; logs: ${directory}`);
let next = 0;
let failed = false;
async function worker() {
  while (next < scripts.length) {
    const index = next++;
    const script = scripts[index];
    const log = path.join(directory, `${index}-${script.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}.log`);
    const fd = openSync(log, "w", 0o600);
    const start = performance.now();
    console.log(`START ${script}: ${log}`);
    const code = await new Promise((resolve) => {
      const child = spawn("npm", ["run", script], { stdio: ["ignore", fd, fd] });
      child.once("error", (error) => {
        console.error(`${script}: ${error.message}`);
        resolve(1);
      });
      child.once("close", (status) => resolve(status ?? 1));
    });
    closeSync(fd);
    failed ||= code !== 0;
    console.log(
      `${code === 0 ? "PASS" : "FAIL"} ${script} (${((performance.now() - start) / 1000).toFixed(1)}s): ${log}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, scripts.length) }, worker));
process.exitCode = failed ? 1 : 0;
