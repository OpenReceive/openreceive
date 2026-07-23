#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = path.join(root, ".env");

try {
  process.loadEnvFile(envPath);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (!process.env.NWC_URI?.trim()) {
  console.error(
    "The Hello Fruit demo requires NWC_URI. Copy .env.example to .env and add a receive-only NWC URI.",
  );
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("run-with-root-env requires a command.");
  process.exit(1);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start ${command}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
