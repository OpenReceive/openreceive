#!/usr/bin/env node

// Keep npm and direct/CI invocations on the same Docker runner. No host SDK.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "../shared/root.mjs";

const result = spawnSync(
  "bash",
  [path.join(root, "packages/dotnet/docker/test-unit.sh"), ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" },
);
if (result.error) console.error(`test:dotnet: ${result.error.message}`);
process.exit(result.status ?? 1);
